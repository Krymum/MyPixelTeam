import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authEnv,
  branchesForIssue,
  branchName,
  commitAll,
  commitsAhead,
  ensureClone,
  git,
  headCommit,
  prepareWorktree,
  push,
  remoteBranches,
  unpublishedCommits,
} from "../src/main/work/git";

describe("branchName", () => {
  it("makes a readable, safe branch from the ticket", () => {
    expect(branchName("PROJ-42", "Fix the login page!")).toBe("agent/PROJ-42-fix-the-login-page");
    expect(branchName("PROJ-1", "Écran « paramètres » trop lent")).toBe(
      "agent/PROJ-1-ecran-parametres-trop-lent",
    );
    expect(branchName("PROJ-2", "???")).toBe("agent/PROJ-2");
    expect(branchName("PROJ-3", "a".repeat(80)).length).toBeLessThanOrEqual(
      "agent/PROJ-3-".length + 40,
    );
  });
});

describe("branchesForIssue", () => {
  const names = [
    "develop",
    "feature/HOT-1279-benchmark",
    "hot-1279",
    "bugfix/HOT-12790-other",
    "HOT-127",
    "agent/issue-12-fix",
    "fix/#12",
    "12-login",
    "release/1.12",
    "issue-123",
  ];

  it("finds a Jira ticket's branches, not its neighbours'", () => {
    expect(branchesForIssue(names, "HOT-1279")).toEqual(["feature/HOT-1279-benchmark", "hot-1279"]);
  });

  it("finds a GitHub issue's branches", () => {
    expect(branchesForIssue(names, "#12")).toEqual(["agent/issue-12-fix", "fix/#12", "12-login"]);
  });
});

describe("authEnv", () => {
  it("sends credentials as a header and disables prompts and helpers", () => {
    const env = authEnv({ username: "x-access-token", password: "tok" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_VALUE_1).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:tok").toString("base64")}`,
    );
    expect(authEnv().GIT_CONFIG_COUNT).toBeUndefined();
  });
});

// A real repository: a bare "remote", the user's clone and an agent worktree.
describe("worktree flow", () => {
  let dir: string;
  const auth = { username: "u", password: "p" };
  const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "office-git-"));
    const seed = join(dir, "seed");
    await git(["init", "-q", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "hello\n");
    await git(["add", "."], { cwd: seed });
    await git([...identity, "commit", "-q", "-m", "init"], { cwd: seed });
    await git(["clone", "-q", "--bare", seed, join(dir, "remote.git")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("clones, works in a worktree, commits and pushes the branch", async () => {
    const repo = join(dir, "clone");
    const worktree = join(dir, "worktrees", "PROJ-1");
    await ensureClone(join(dir, "remote.git"), repo, auth);
    await ensureClone("unused: already cloned", repo, auth);

    await prepareWorktree({
      repoPath: repo,
      worktree,
      branch: "agent/PROJ-1-x",
      base: "main",
      auth,
    });
    expect(await git(["branch", "--show-current"], { cwd: worktree })).toBe("agent/PROJ-1-x");
    expect(await commitAll(worktree, "nothing")).toBe(false);

    writeFileSync(join(worktree, "feature.txt"), "done\n");
    await git(["config", "user.email", "test@example.com"], { cwd: worktree });
    await git(["config", "user.name", "Test"], { cwd: worktree });
    expect(await commitAll(worktree, "PROJ-1: x")).toBe(true);
    expect(await commitsAhead(worktree, "main")).toBe(1);

    await push(worktree, "agent/PROJ-1-x", auth);
    const remote = await git(["branch", "--list"], { cwd: join(dir, "remote.git") });
    expect(remote).toContain("agent/PROJ-1-x");

    // Running the ticket again reuses the worktree; the main checkout was never touched.
    await prepareWorktree({
      repoPath: repo,
      worktree,
      branch: "agent/PROJ-1-x",
      base: "main",
      auth,
    });
    expect(existsSync(join(worktree, "feature.txt"))).toBe(true);
    expect(existsSync(join(repo, "feature.txt"))).toBe(false);
  });

  it("works on a branch someone already pushed, and only counts new commits", async () => {
    // A colleague started the ticket on origin.
    const colleague = join(dir, "colleague");
    await git(["clone", "-q", join(dir, "remote.git"), colleague]);
    await git(["checkout", "-q", "-b", "feature/PROJ-2-start"], { cwd: colleague });
    writeFileSync(join(colleague, "started.txt"), "half done\n");
    await git(["add", "."], { cwd: colleague });
    await git([...identity, "commit", "-q", "-m", "PROJ-2 start"], { cwd: colleague });
    await git(["push", "-q", "origin", "feature/PROJ-2-start"], { cwd: colleague });

    const repo = join(dir, "clone");
    expect(branchesForIssue(await remoteBranches(repo, auth), "PROJ-2")).toEqual([
      "feature/PROJ-2-start",
    ]);
    const worktree = join(dir, "worktrees", "PROJ-2");
    await prepareWorktree({
      repoPath: repo,
      worktree,
      branch: "feature/PROJ-2-start",
      base: "main",
      auth,
      existing: true,
    });
    expect(existsSync(join(worktree, "started.txt"))).toBe(true);
    // The colleague's commit is already on origin: nothing to publish yet.
    const start = await headCommit(worktree);
    expect(await unpublishedCommits(worktree, "feature/PROJ-2-start", "main")).toBe(0);
    writeFileSync(join(worktree, "more.txt"), "agent\n");
    await git(["add", "."], { cwd: worktree });
    await git([...identity, "commit", "-q", "-m", "more"], { cwd: worktree });
    expect(await headCommit(worktree)).not.toBe(start);
    expect(await unpublishedCommits(worktree, "feature/PROJ-2-start", "main")).toBe(1);

    // Switching the ticket to another branch: fine when clean, refused with uncommitted work.
    await prepareWorktree({
      repoPath: repo,
      worktree,
      branch: "agent/PROJ-2-x",
      base: "main",
      auth,
    });
    expect(await git(["branch", "--show-current"], { cwd: worktree })).toBe("agent/PROJ-2-x");
    writeFileSync(join(worktree, "dirty.txt"), "wip\n");
    await expect(
      prepareWorktree({
        repoPath: repo,
        worktree,
        branch: "feature/PROJ-2-start",
        base: "main",
        auth,
        existing: true,
      }),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it("explains git failures", async () => {
    await expect(git(["rev-parse", "--verify", "nope"], { cwd: dir })).rejects.toThrow(
      /git rev-parse failed/,
    );
  });
});
