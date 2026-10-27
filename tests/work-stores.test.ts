import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore, type Cipher } from "../src/main/work/accounts";
import { WorkspaceStore } from "../src/main/work/workspace";
import { baseBranchOf, type ProjectInput } from "../src/shared/work/types";
import { fakeFetch } from "./work-helpers";

let dir: string;
const temp = () => (dir = mkdtempSync(join(tmpdir(), "office-work-")));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Reversible stand-in for safeStorage. */
const cipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain).reverse(),
  decrypt: (data) => Buffer.from(data).reverse().toString(),
};

describe("AccountStore", () => {
  it("checks credentials, stores them encrypted and never exposes tokens", async () => {
    const path = join(temp(), "accounts.bin");
    const { fetch } = fakeFetch({
      "GET /rest/api/3/myself": { displayName: "Ana" },
      "GET /user": { login: "ana-gh" },
    });
    const store = new AccountStore(path, cipher, fetch);
    await store.connect({ provider: "jira", site: "acme", email: "a@acme.com", token: "secret-1" });
    const view = await store.connect({ provider: "github", token: "secret-2" });

    expect(view).toEqual({
      secureStorage: true,
      accounts: [
        { provider: "jira", user: "Ana", detail: "https://acme.atlassian.net" },
        { provider: "github", user: "ana-gh" },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(readFileSync(path).toString()).not.toContain("secret-1");

    const reopened = new AccountStore(path, cipher, fetch);
    expect(reopened.view().accounts).toHaveLength(2);
    expect(reopened.jira().site).toBe("https://acme.atlassian.net");
    expect(reopened.disconnect("github").accounts.map((a) => a.provider)).toEqual(["jira"]);
    expect(() => reopened.git("github")).toThrow(/Connect a GitHub account/);
  });

  it("saves nothing when the credentials are refused", async () => {
    const path = join(temp(), "accounts.bin");
    const { fetch } = fakeFetch({ "GET /user": [401, { message: "Bad credentials" }] });
    const store = new AccountStore(path, cipher, fetch);
    await expect(store.connect({ provider: "github", token: "x" })).rejects.toThrow(
      "Invalid credentials (Bad credentials)",
    );
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to store accounts without secure storage", async () => {
    const store = new AccountStore(join(temp(), "a.bin"), { ...cipher, available: () => false });
    expect(store.view().secureStorage).toBe(false);
    await expect(store.connect({ provider: "github", token: "x" })).rejects.toThrow(
      /secure storage/,
    );
  });
});

const project = (patch: Partial<ProjectInput> = {}): ProjectInput => ({
  name: "App",
  tracker: { kind: "jira", projectKey: "PROJ" },
  repo: {
    provider: "github",
    fullName: "acme/app",
    defaultBranch: "main",
    cloneUrl: "https://github.com/acme/app.git",
    webUrl: "https://github.com/acme/app",
  },
  localPath: "",
  agent: { permissionMode: "acceptEdits", openPullRequest: true },
  ...patch,
});

describe("WorkspaceStore", () => {
  it("adds, edits, activates and removes projects", () => {
    const path = join(temp(), "workspace.json");
    const store = new WorkspaceStore(path, join(dir, "repos"));
    const first = store.save(project()).projects[0]!;
    expect(first.localPath).toBe(join(dir, "repos", "github", "acme", "app"));
    expect(store.view().activeProjectId).toBe(first.id);

    const second = store.save(project({ name: "Lib", localPath: "/src/lib" })).projects[1]!;
    store.save({ ...first, name: "App 2" });
    expect(store.view().projects.map((p) => p.name)).toEqual(["App 2", "Lib"]);

    store.setActive(second.id);
    expect(new WorkspaceStore(path, dir).view().activeProjectId).toBe(second.id);
    expect(store.remove(second.id).activeProjectId).toBe(first.id);
    expect(() => store.setActive("nope")).toThrow(/Unknown project/);
  });

  it("keeps preferences next to the projects", () => {
    const path = join(temp(), "w.json");
    const store = new WorkspaceStore(path, dir);
    expect(store.view()).toMatchObject({ onboarded: false, notifications: true });
    store.setPreferences({ onboarded: true });
    store.save(project());
    store.setPreferences({ notifications: false });
    expect(new WorkspaceStore(path, dir).view()).toMatchObject({
      onboarded: true,
      notifications: false,
    });
    expect(store.view().projects).toHaveLength(1);
  });

  it("reads projects saved before trackers existed as Jira projects", () => {
    const path = join(temp(), "w.json");
    const legacy: Record<string, unknown> = {
      ...project({ localPath: "/src/app" }),
      id: "old",
      jiraProjectKey: "OLD",
    };
    delete legacy.tracker;
    writeFileSync(path, JSON.stringify({ projects: [legacy] }));
    const [loaded] = new WorkspaceStore(path, dir).view().projects;
    expect(loaded?.tracker).toEqual({ kind: "jira", projectKey: "OLD" });
    expect(loaded).not.toHaveProperty("jiraProjectKey");
  });

  it("keeps a base branch, refusing odd names", () => {
    const store = new WorkspaceStore(join(temp(), "w.json"), dir);
    const saved = store.save(project({ baseBranch: "release/2.0" })).projects[0]!;
    expect(baseBranchOf(saved)).toBe("release/2.0");
    expect(baseBranchOf({ ...saved, baseBranch: " " })).toBe("main");
    for (const bad of ["a..b", "x; rm -rf", "feature branch"])
      expect(() => store.save(project({ baseBranch: bad }))).toThrow(/Base branch/);
  });

  it("validates projects", () => {
    const store = new WorkspaceStore(join(temp(), "w.json"), dir);
    expect(() => store.save(project({ tracker: { kind: "jira", projectKey: "" } }))).toThrow();
    expect(() =>
      store.save(
        project({
          tracker: { kind: "github" },
          repo: { ...project().repo, provider: "bitbucket" },
        }),
      ),
    ).toThrow(/GitHub Issues need a GitHub repository/);
    expect(() =>
      store.save(
        project({
          agent: { permissionMode: "acceptEdits", openPullRequest: true, model: "x; rm -rf" },
        }),
      ),
    ).toThrow(/Model/);
  });
});
