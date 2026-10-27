import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoverProjects,
  guessJiraKeys,
  parseRemote,
  recentFolders,
  unreachable,
} from "../src/main/work/discover";
import { HttpError } from "../src/main/integrations/http";
import { git } from "../src/main/work/git";
import type { RepoSummary } from "../src/shared/work/types";

describe("parseRemote", () => {
  it("reads GitHub and Bitbucket remotes in every form", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "https://github.com/acme/app",
      "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git",
    ])
      expect(parseRemote(url)).toEqual({ provider: "github", fullName: "acme/app" });
    expect(parseRemote("https://me@bitbucket.org/ws/my-app.git")).toEqual({
      provider: "bitbucket",
      fullName: "ws/my-app",
    });
    expect(parseRemote("git@bitbucket.org:ws/app.git")?.provider).toBe("bitbucket");
  });

  it("ignores other hosts", () => {
    expect(parseRemote("https://gitlab.com/acme/app.git")).toBeUndefined();
    expect(parseRemote("D:/repos/app")).toBeUndefined();
  });
});

describe("guessJiraKeys", () => {
  const texts = [
    "PROJ-12 fix login",
    "feature/PROJ-13-dark-mode",
    "Merge OPS-4 into main",
    "PROJ-14: tests",
    "Bump UTF-8 handling", // looks like a key: filtering by known projects drops it
    "sha-256 support",
  ];

  it("counts keys from branches and commits, most frequent first", () => {
    expect(guessJiraKeys(texts)).toEqual(["PROJ", "OPS", "UTF"]);
  });

  it("keeps only the account's projects when they are known", () => {
    expect(guessJiraKeys(texts, ["OPS", "WEB"])).toEqual(["OPS"]);
  });
});

describe("recentFolders", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "office-transcripts-"));
    const session = (dir: string, file: string, cwd: string, mtime: number) => {
      mkdirSync(join(root, dir), { recursive: true });
      const path = join(root, dir, file);
      writeFileSync(path, `{"type":"summary"}\n{"type":"user","cwd":${JSON.stringify(cwd)}}\n`);
      utimesSync(path, mtime / 1000, mtime / 1000);
    };
    session("D--a", "1.jsonl", "D:\\a", 1_000_000);
    session("D--a", "2.jsonl", "D:\\a\\sub", 3_000_000);
    session("D--b", "1.jsonl", "D:\\b", 2_000_000);
    mkdirSync(join(root, "empty"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("gives each project folder's latest working directory, newest first", () => {
    expect(recentFolders(root)).toEqual([
      { path: "D:\\a\\sub", lastUsed: 3_000_000 },
      { path: "D:\\b", lastUsed: 2_000_000 },
    ]);
    expect(recentFolders(join(root, "missing"))).toEqual([]);
  });
});

// Real repositories: one on GitHub, one elsewhere, one already a project, plus a worktree.
describe("discoverProjects", () => {
  let dir: string;
  const repoOf = (fullName: string): RepoSummary => ({
    provider: "github",
    fullName,
    defaultBranch: "main",
    cloneUrl: `https://github.com/${fullName}.git`,
    webUrl: `https://github.com/${fullName}`,
    private: true,
  });

  async function repo(name: string, remote: string | undefined, commits: string[]) {
    const path = join(dir, name);
    await git(["init", "-q", "-b", "main", path]);
    for (const message of commits)
      await git(
        [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          message,
        ],
        { cwd: path },
      );
    if (remote) await git(["remote", "add", "origin", remote], { cwd: path });
    return path;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "office-discover-"));
    const app = await repo("app", "git@github.com:acme/app.git", [
      "PROJ-1 init",
      "PROJ-2 more",
      "OPS-1 ci",
    ]);
    await git(["worktree", "add", "-q", join(dir, "wt"), "-b", "agent/x"], { cwd: app });
    await repo("lab", "https://gitlab.com/acme/lab.git", ["start"]);
    await repo("private", "https://github.com/acme/secret.git", ["start"]);
    await repo("done", "https://github.com/acme/done.git", ["start"]);
    await repo("local", undefined, ["start"]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("pairs folders with the account's repositories and a Jira key", async () => {
    const found = await discoverProjects({
      folders: [
        { path: join(dir, "wt"), lastUsed: 5 },
        { path: join(dir, "app"), lastUsed: 4 },
        { path: join(dir, "lab"), lastUsed: 3 },
        { path: join(dir, "private"), lastUsed: 2 },
        { path: join(dir, "done"), lastUsed: 2 },
        { path: join(dir, "local"), lastUsed: 1 },
        { path: join(dir, "agents", "PROJ-9"), lastUsed: 1 },
        { path: join(dir, "gone"), lastUsed: 1 },
      ],
      exclude: [join(dir, "agents")],
      existing: new Set(["github:acme/done"]),
      repos: async (provider) => (provider === "github" ? [repoOf("acme/app")] : undefined),
      jiraKeys: ["PROJ", "OPS"],
    });
    const byPath = (name: string) => found.find((f) => f.path.endsWith(name));

    // The worktree leads to its repository, which is listed once.
    expect(found.filter((f) => f.remote?.fullName === "acme/app")).toHaveLength(1);
    expect(byPath("app")).toMatchObject({
      lastUsed: 5,
      remote: { provider: "github", fullName: "acme/app" },
      repo: { fullName: "acme/app", defaultBranch: "main" },
      jiraKeys: ["PROJ", "OPS"],
    });
    expect(byPath("app")?.repo).not.toHaveProperty("private");
    expect(byPath("lab")?.problem).toMatch(/not on GitHub or Bitbucket/);
    expect(byPath("private")?.problem).toMatch(/can't reach acme\/secret/);
    expect(byPath("local")?.problem).toBe("No origin remote");
    expect(byPath("done")).toBeUndefined();
    expect(found).toHaveLength(4);
  });

  it("asks for a repository the list left out, and says why it is unreachable", async () => {
    const asked: string[] = [];
    const found = await discoverProjects({
      folders: [
        { path: join(dir, "app"), lastUsed: 2 },
        { path: join(dir, "private"), lastUsed: 1 },
      ],
      exclude: [],
      existing: new Set(),
      repos: async () => [],
      lookup: async (_, fullName) => {
        asked.push(fullName);
        return fullName === "acme/app" ? repoOf("acme/app") : "GitHub says no (404)";
      },
    });
    expect(asked).toEqual(["acme/app", "acme/secret"]);
    expect(found[0]?.repo?.fullName).toBe("acme/app");
    expect(found[1]?.problem).toBe("GitHub says no (404)");
  });

  it("asks to connect the code host when it isn't", async () => {
    const [found] = await discoverProjects({
      folders: [{ path: join(dir, "app"), lastUsed: 0 }],
      exclude: [],
      existing: new Set(),
      repos: async () => undefined,
    });
    expect(found?.problem).toBe("Connect GitHub to use it");
    expect(found?.jiraKeys).toEqual(["PROJ", "OPS"]);
  });
});

describe("unreachable", () => {
  it("explains a 404 as a token without access, naming the account", () => {
    const text = unreachable("github", "Krymum/App", "Krymum", new HttpError(404, "Not Found"));
    expect(text).toContain("connected as Krymum");
    expect(text).toContain("can't see Krymum/App (404)");
    expect(text).toContain("Repository access");
  });

  it("asks to reconnect an expired or regenerated token", () => {
    expect(unreachable("github", "a/b", undefined, new HttpError(401, "x"))).toMatch(
      /Connect GitHub again/,
    );
  });

  it("passes other answers on as they are", () => {
    expect(
      unreachable("github", "a/b", undefined, new HttpError(403, "Resource not accessible")),
    ).toContain("Resource not accessible");
    expect(unreachable("bitbucket", "ws/r", "me", new HttpError(404, "x"))).toMatch(/workspace/);
  });
});
