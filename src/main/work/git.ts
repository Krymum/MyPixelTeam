import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { issueSlug } from "../../shared/work/types";

/**
 * The few git commands the runner needs. Credentials are passed per command as an HTTP
 * header through GIT_CONFIG_* variables: they never land in .git/config, in a remote URL or
 * on the command line, and credential helpers are switched off so no login window opens.
 */

export interface GitAuth {
  username: string;
  password: string;
}

export function authEnv(auth?: GitAuth): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  if (!auth) return env;
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.extraHeader",
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
  };
}

/** Commits made for the agent when git has no identity configured. */
const FALLBACK_IDENTITY = ["-c", "user.name=MyPixelTeam", "-c", "user.email=mypixelteam@localhost"];

export async function git(
  args: string[],
  options: { cwd?: string; auth?: GitAuth; allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: { ...process.env, ...authEnv(options.auth) },
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && !options.allowFailure) {
          const detail = stderr.trim() || err.message;
          reject(new Error(`git ${args[0]} failed: ${detail}`));
        } else resolve(stdout.trim());
      },
    );
  });
}

/** Clones the repository into `path` unless a git checkout is already there. */
export async function ensureClone(cloneUrl: string, path: string, auth: GitAuth): Promise<void> {
  if (existsSync(join(path, ".git"))) return;
  mkdirSync(dirname(path), { recursive: true });
  await git(["clone", "--no-tags", cloneUrl, path], { auth });
}

/** "PROJ-42" + "Fix the login page!" -> "agent/PROJ-42-fix-the-login-page"; "#7" -> "agent/issue-7-…". */
export function branchName(issueKey: string, summary: string): string {
  const slug = summary
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `agent/${issueSlug(issueKey)}${slug ? `-${slug}` : ""}`;
}

/** Branch names on origin, asked live (`git ls-remote`), so colleagues' new branches count. */
export async function remoteBranches(repoPath: string, auth: GitAuth): Promise<string[]> {
  const out = await git(["ls-remote", "--heads", "origin"], { cwd: repoPath, auth });
  return out
    .split("\n")
    .map((line) =>
      line
        .split("\t")[1]
        ?.trim()
        .replace(/^refs\/heads\//, ""),
    )
    .filter((name): name is string => Boolean(name));
}

/**
 * Branches that belong to a ticket: "feature/HOT-1279-x" or "HOT-1279" for Jira keys,
 * "issue-12-x", "12-fix" or "fix/#12" for GitHub issues. The ticket's own branch counts too.
 */
export function branchesForIssue(names: string[], issueKey: string): string[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = issueKey.startsWith("#")
    ? new RegExp(`(^|[/_-])(issue-|#)?${escape(issueKey.slice(1))}(?![0-9])(?=$|[/_-])`, "i")
    : new RegExp(`(^|[^A-Za-z0-9])${escape(issueKey)}(?![0-9])`, "i");
  return names.filter((name) => pattern.test(name));
}

export async function headCommit(worktree: string): Promise<string> {
  return git(["rev-parse", "HEAD"], { cwd: worktree });
}

/**
 * A worktree per ticket, so agents never touch the main checkout and several tickets can
 * run side by side. The branch is new (from the up-to-date base) or `existing` on origin,
 * where the ticket's work may already have started. Returns a note worth logging.
 */
export async function prepareWorktree(options: {
  repoPath: string;
  worktree: string;
  branch: string;
  base: string;
  auth: GitAuth;
  /** The branch is already on origin: start from its latest commit. */
  existing?: boolean;
  /** A new run on the ticket: a branch pushed before and gone from origin starts over. */
  fresh?: boolean;
}): Promise<string | undefined> {
  const { repoPath, branch, base, auth, existing } = options;
  await git(["fetch", "origin", base, ...(existing ? [branch] : [])], { cwd: repoPath, auth });

  const restarted = options.fresh && !existing && (await dropGoneBranch(options));
  const note = await openWorktree(options);
  return restarted || note;
}

/**
 * The local branch was pushed (push sets its upstream) and is no longer on origin: its pull
 * request was merged or closed, so the ticket's new run starts again from the base. A
 * worktree with uncommitted changes is kept, whatever the branch.
 */
async function dropGoneBranch(options: {
  repoPath: string;
  worktree: string;
  branch: string;
  base: string;
}): Promise<string | undefined> {
  const { repoPath, worktree, branch, base } = options;
  // `push -u` points the upstream at the branch itself; a branch made from origin/<base>
  // tracks the base until then.
  const upstream = await git(["config", "--get", `branch.${branch}.merge`], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (upstream !== `refs/heads/${branch}`) return undefined;
  if (existsSync(join(worktree, ".git"))) {
    if (await git(["status", "--porcelain"], { cwd: worktree })) return undefined;
    await git(["worktree", "remove", worktree], { cwd: repoPath });
  }
  await git(["worktree", "prune"], { cwd: repoPath });
  await git(["branch", "-D", branch], { cwd: repoPath });
  return `${branch} was gone from origin (its pull request merged or closed): started it again from ${base}`;
}

async function openWorktree(options: {
  repoPath: string;
  worktree: string;
  branch: string;
  base: string;
  existing?: boolean;
}): Promise<string | undefined> {
  const { repoPath, worktree, branch, base, existing } = options;
  if (existsSync(join(worktree, ".git"))) {
    const current = await git(["branch", "--show-current"], { cwd: worktree });
    if (current === branch) return existing ? fastForward(worktree, branch) : undefined;
    // The ticket ran on another branch before: switch, unless that would lose work.
    if (await git(["status", "--porcelain"], { cwd: worktree }))
      throw new Error(
        `The worktree of this ticket has uncommitted changes on ${current}: commit or discard them in ${worktree} first`,
      );
    await git(["worktree", "remove", worktree], { cwd: repoPath });
  }

  await git(["worktree", "prune"], { cwd: repoPath });
  mkdirSync(dirname(worktree), { recursive: true });
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (local) {
    await git(["worktree", "add", worktree, branch], { cwd: repoPath });
    return existing ? fastForward(worktree, branch) : undefined;
  }
  await git(
    existing
      ? ["worktree", "add", "--track", "-b", branch, worktree, `origin/${branch}`]
      : ["worktree", "add", "-b", branch, worktree, `origin/${base}`],
    { cwd: repoPath },
  );
  return undefined;
}

/** Brings a local branch up to its origin counterpart when that needs no merge. */
async function fastForward(worktree: string, branch: string): Promise<string | undefined> {
  try {
    await git(["merge", "--ff-only", "-q", `origin/${branch}`], { cwd: worktree });
    return undefined;
  } catch {
    return `${branch} has local commits that origin doesn't: kept as they are`;
  }
}

/** Commits whatever the agent left uncommitted. Returns false when there was nothing. */
export async function commitAll(worktree: string, message: string): Promise<boolean> {
  if (!(await git(["status", "--porcelain"], { cwd: worktree }))) return false;
  await git(["add", "-A"], { cwd: worktree });
  const email = await git(["config", "user.email"], { cwd: worktree, allowFailure: true });
  await git([...(email ? [] : FALLBACK_IDENTITY), "commit", "-q", "-m", message], {
    cwd: worktree,
  });
  return true;
}

/**
 * Merges the latest of `from` on origin into the worktree's branch, for a branch built on
 * another one that moved since (an epic's earlier ticket fixed after review or checks).
 * A conflict is left alone: the merge is aborted and the worktree stays as it was.
 */
export async function mergeFrom(
  worktree: string,
  from: string,
  auth: GitAuth,
): Promise<"merged" | "current" | "conflict" | "gone"> {
  const fetched = await git(["fetch", "origin", from], { cwd: worktree, auth })
    .then(() => true)
    .catch(() => false);
  if (!fetched) return "gone";
  const behind = await git(["merge-base", "--is-ancestor", `origin/${from}`, "HEAD"], {
    cwd: worktree,
  })
    .then(() => false)
    .catch(() => true);
  if (!behind) return "current";
  const email = await git(["config", "user.email"], { cwd: worktree, allowFailure: true });
  try {
    await git([...(email ? [] : FALLBACK_IDENTITY), "merge", "--no-edit", "-q", `origin/${from}`], {
      cwd: worktree,
    });
    return "merged";
  } catch {
    await git(["merge", "--abort"], { cwd: worktree, allowFailure: true });
    return "conflict";
  }
}

/** Number of commits on the branch that the default branch doesn't have. */
export async function commitsAhead(worktree: string, base: string): Promise<number> {
  return Number(await git(["rev-list", "--count", `origin/${base}..HEAD`], { cwd: worktree }));
}

/**
 * Commits on the branch that origin hasn't got yet: compared with the branch on origin when
 * it exists there, with the base otherwise.
 */
export async function unpublishedCommits(
  worktree: string,
  branch: string,
  base: string,
): Promise<number> {
  const onOrigin = await git(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    {
      cwd: worktree,
      allowFailure: true,
    },
  );
  if (!onOrigin) return commitsAhead(worktree, base);
  return Number(await git(["rev-list", "--count", `origin/${branch}..HEAD`], { cwd: worktree }));
}

export async function push(worktree: string, branch: string, auth: GitAuth): Promise<void> {
  await git(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktree, auth });
}
