import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildContinuePrompt, buildPrompt } from "../src/main/work/agent-protocol";
import { git, mergeFrom } from "../src/main/work/git";
import { AgentRunner } from "../src/main/work/runner";
import { createTickets } from "../src/main/work/ticket-drafts";
import type { IssueDetail, Project, RunView } from "../src/shared/work/types";

const dir = mkdtempSync(join(tmpdir(), "office-plan-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const project = {
  id: "p1",
  name: "App",
  tracker: { kind: "github" },
  repo: {
    provider: "github",
    fullName: "acme/app",
    defaultBranch: "main",
    cloneUrl: "https://github.com/acme/app.git",
    webUrl: "https://github.com/acme/app",
  },
  localPath: "/repo",
  agent: { permissionMode: "acceptEdits", openPullRequest: true },
} as Project;

const issue = {
  key: "#6",
  summary: "Public site",
  type: "Issue",
  description: "A public site with a home page and a contact form.",
  comments: [],
} as unknown as IssueDetail;

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

async function commit(cwd: string, file: string, text: string): Promise<void> {
  writeFileSync(join(cwd, file), text);
  await git(["add", "."], { cwd });
  await git([...identity, "commit", "-q", "-m", file], { cwd });
}

/** A remote with main, and a clone of it. */
async function repository(name: string): Promise<{ remote: string; repo: string }> {
  const root = join(dir, name);
  const seed = join(root, "seed");
  await git(["init", "-q", "-b", "main", seed]);
  await commit(seed, "README.md", "hello\n");
  const remote = join(root, "remote.git");
  await git(["clone", "-q", "--bare", seed, remote]);
  const repo = join(root, "clone");
  await git(["clone", "-q", remote, repo]);
  await git(["config", "user.email", "test@example.com"], { cwd: repo });
  await git(["config", "user.name", "Test"], { cwd: repo });
  return { remote, repo };
}

const auth = { username: "u", password: "p" };

describe("planning runs", () => {
  it("only asks for the tickets, under the ticket", () => {
    const prompt = buildPrompt(issue, project, {
      branch: "agent/issue-6-public-site",
      base: "main",
      existing: false,
      planOnly: true,
    });
    expect(prompt).toMatch(/only job is to break #6 into tickets/);
    expect(prompt).toContain(".mypixelteam/tickets.json");
    expect(prompt).not.toMatch(/Implement the ticket/);
    expect(buildContinuePrompt(issue, project, "b", "Add one for the footer", [], true)).toMatch(
      /only write tickets.*Write only the new ones/,
    );
  });

  it("creates the tickets as children of the ticket", async () => {
    const made: { summary: string; parentKey?: string }[] = [];
    const tracker = {
      issueTypes: async () => [],
      create: async (t: { summary: string; parentKey?: string }) => {
        made.push(t);
        return `#${10 + made.length}`;
      },
    };
    await createTickets(
      tracker as never,
      [{ summary: "Home page" }, { summary: "Contact form" }],
      () => {},
      "#6",
    );
    expect(made.map((t) => [t.summary, t.parentKey])).toEqual([
      ["Home page", "#6"],
      ["Contact form", "#6"],
    ]);
  });

  it("runs on the planning model, and stays a planning run when continued", () => {
    const office = new AgentRunner({
      accounts: { tracker: () => ({ issue: () => new Promise(() => {}) }) } as never,
      workspace: {
        get: () => project,
        view: () => ({ maxAgents: 2, runBudgetUsd: 0, fixCi: true }),
      } as never,
      worktreesDir: "/wt",
      claude: "claude",
      onChange: () => {},
      onSession: () => {},
    });
    const run = office.start("p1", "#6", { planOnly: true });
    expect(run).toMatchObject({ model: "haiku", planOnly: true });
    expect(office.start("p1", "#7", { model: "opus" }).planOnly).toBeUndefined();
    Object.assign(run, { status: "done", agentStarted: true, branch: "b" });
    expect(office.continueRun(run.id, "Add one for the footer").planOnly).toBe(true);
  });
});

describe("stacked branches", () => {
  it("merges the latest of the branch below, and leaves conflicts alone", async () => {
    const { repo } = await repository("merge");
    await git(["checkout", "-q", "-b", "a"], { cwd: repo });
    await commit(repo, "a.txt", "a\n");
    await git(["push", "-q", "-u", "origin", "a"], { cwd: repo });
    const b = join(dir, "merge", "b");
    await git(["worktree", "add", "-q", "-b", "b", b, "origin/a"], { cwd: repo });
    await commit(b, "b.txt", "b\n");

    expect(await mergeFrom(b, "a", auth)).toBe("current");
    // A fix lands on a after b was built on it.
    await commit(repo, "a.txt", "a, fixed\n");
    await git(["push", "-q", "origin", "a"], { cwd: repo });
    expect(await mergeFrom(b, "a", auth)).toBe("merged");
    expect(await git(["show", "HEAD:a.txt"], { cwd: b })).toBe("a, fixed");

    await commit(repo, "b.txt", "a's take\n");
    await git(["push", "-q", "origin", "a"], { cwd: repo });
    expect(await mergeFrom(b, "a", auth)).toBe("conflict");
    expect(await git(["status", "--porcelain"], { cwd: b })).toBe("");
    expect(await mergeFrom(b, "gone", auth)).toBe("gone");
  });

  it("pushes a fix down to the epic's tickets built on it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { remote, repo } = await repository("sync");
    const worktree = (name: string) => join(dir, "sync", name);
    // #7 on a, #8 built on a, #9 built on #8's branch: all pushed, all done.
    await git(["worktree", "add", "-q", "-b", "a", worktree("a"), "origin/main"], { cwd: repo });
    await commit(worktree("a"), "a.txt", "a\n");
    await git(["push", "-q", "-u", "origin", "a"], { cwd: worktree("a") });
    await git(["worktree", "add", "-q", "-b", "b", worktree("b"), "origin/a"], { cwd: repo });
    await commit(worktree("b"), "b.txt", "b\n");
    await git(["push", "-q", "-u", "origin", "b"], { cwd: worktree("b") });
    await git(["worktree", "add", "-q", "-b", "c", worktree("c"), "origin/b"], { cwd: repo });
    await commit(worktree("c"), "c.txt", "c\n");
    await git(["push", "-q", "-u", "origin", "c"], { cwd: worktree("c") });

    const comments: string[] = [];
    const office = new AgentRunner({
      accounts: {
        tracker: () => ({ comment: async (_: string, text: string) => comments.push(text) }),
        git: () => ({
          gitAuth: () => auth,
          checks: async () => ({ state: "pending", failed: [] }),
        }),
      } as never,
      workspace: {
        get: () => project,
        view: () => ({ maxAgents: 2, runBudgetUsd: 0, fixCi: true }),
      } as never,
      worktreesDir: dir,
      claude: "claude",
      onChange: () => {},
      onSession: () => {},
    });
    const runs = office as unknown as {
      runs: Map<string, RunView>;
      syncDependents(r: RunView, p: Project): Promise<void>;
    };
    const run = (id: string, issueKey: string, branch: string, from?: string) => {
      const r = {
        id,
        projectId: "p1",
        issueKey,
        branch,
        from,
        worktree: worktree(branch),
        status: "done",
        pullRequestUrl: `https://github.com/acme/app/pull/${id}`,
        startedAt: 0,
        log: [],
      } as unknown as RunView;
      runs.runs.set(id, r);
      return r;
    };
    const seven = run("7", "#7", "a");
    const eight = run("8", "#8", "b", "a");
    const nine = run("9", "#9", "c", "b");

    // The agent fixed #7's checks and pushed a.
    await commit(worktree("a"), "a.txt", "a, fixed\n");
    await git(["push", "-q", "origin", "a"], { cwd: worktree("a") });
    await runs.syncDependents(seven, project);

    const onOrigin = (branch: string) =>
      git(["--git-dir", remote, "show", `${branch}:a.txt`]).catch(() => "");
    expect(await onOrigin("b")).toBe("a, fixed");
    expect(await onOrigin("c")).toBe("a, fixed");
    expect(eight.log.at(-1)).toMatch(/pushed with the latest of a/);
    expect(nine.ci).toBe("pending");
    expect(comments).toEqual([]);
    expect(existsSync(join(worktree("c"), "a.txt"))).toBe(true);
    vi.useRealTimers();
  });
});
