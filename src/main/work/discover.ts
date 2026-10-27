import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DiscoveredProject, GitProviderId, RepoSummary } from "../../shared/work/types";
import { HttpError } from "../integrations/http";
import { git } from "./git";

/**
 * Finds the repositories this person already works on, so projects don't have to be typed
 * in: Claude Code transcripts record the folder of every session, the origin remote names
 * the GitHub or Bitbucket repository, and ticket keys in branches and commits give away the
 * Jira project.
 */

const HEAD_BYTES = 64 * 1024;
const MAX_FOLDERS = 30;

/** "git@github.com:acme/app.git", "https://me@bitbucket.org/ws/app" -> host and full name. */
export function parseRemote(
  url: string,
): { provider: GitProviderId; fullName: string } | undefined {
  const m =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(github\.com|bitbucket\.org)[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  if (!m) return undefined;
  return {
    provider: m[1]!.toLowerCase() === "github.com" ? "github" : "bitbucket",
    fullName: m[2]!,
  };
}

/** Jira keys in branch names and commit messages, most frequent first. */
export function guessJiraKeys(texts: string[], known?: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts)
    for (const m of text.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{1,9})-\d+(?![A-Za-z])/g))
      counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  const allowed = known && new Set(known);
  return [...counts]
    .filter(([key]) => !allowed || allowed.has(key))
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

/** Working folders of recent Claude Code sessions, newest first. */
export function recentFolders(transcriptRoot: string): { path: string; lastUsed: number }[] {
  if (!existsSync(transcriptRoot)) return [];
  const found = new Map<string, { path: string; lastUsed: number }>();
  for (const entry of readdirSync(transcriptRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(transcriptRoot, entry.name);
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    const cwd = newest && readCwd(newest.file);
    if (!cwd) continue;
    const key = cwd.toLowerCase();
    if ((found.get(key)?.lastUsed ?? 0) < newest.mtime)
      found.set(key, { path: cwd, lastUsed: newest.mtime });
  }
  return [...found.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** First `cwd` recorded in a transcript. */
function readCwd(file: string): string | undefined {
  const buffer = Buffer.alloc(HEAD_BYTES);
  const fd = openSync(file, "r");
  let read: number;
  try {
    read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
  } finally {
    closeSync(fd);
  }
  for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      // First or cut line: keep looking.
    }
  }
  return undefined;
}

const isInside = (path: string, folder: string): boolean => {
  const p = resolve(path).toLowerCase();
  const f = resolve(folder).toLowerCase();
  return p === f || p.startsWith(`${f}\\`) || p.startsWith(`${f}/`);
};

export interface DiscoverOptions {
  folders: { path: string; lastUsed: number }[];
  /** Folders to ignore, such as the agents' own worktrees. */
  exclude: string[];
  /** Repositories already set up as projects ("github:acme/app"). */
  existing: Set<string>;
  /** Repositories each connected account can reach; absent when not connected. */
  repos: (provider: GitProviderId) => Promise<RepoSummary[] | undefined>;
  /**
   * Asks for one repository missing from the list: lists can leave some out. Resolves with
   * the repository, or with why the account can't see it.
   */
  lookup?: (provider: GitProviderId, fullName: string) => Promise<RepoSummary | string>;
  /** Jira project keys of the connected account, when there is one. */
  jiraKeys?: string[];
}

export async function discoverProjects(options: DiscoverOptions): Promise<DiscoveredProject[]> {
  const seen = new Set<string>();
  const results: DiscoveredProject[] = [];
  for (const folder of options.folders) {
    if (results.length >= MAX_FOLDERS) break;
    if (!existsSync(folder.path) || options.exclude.some((x) => isInside(folder.path, x))) continue;
    const root = await checkoutRoot(folder.path);
    if (!root || seen.has(root.toLowerCase())) continue;
    seen.add(root.toLowerCase());
    const found = await inspect(root, folder.lastUsed, options);
    if (found) results.push(found);
  }
  return results;
}

/** Main checkout of the repository containing `path`; a worktree leads to its repository. */
async function checkoutRoot(path: string): Promise<string | undefined> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: path,
    allowFailure: true,
  });
  if (!common || !/[\\/]\.git$/.test(common)) return undefined;
  return resolve(dirname(common));
}

async function inspect(
  path: string,
  lastUsed: number,
  options: DiscoverOptions,
): Promise<DiscoveredProject | undefined> {
  const [origin, subjects, branches] = await Promise.all([
    git(["remote", "get-url", "origin"], { cwd: path, allowFailure: true }),
    git(["log", "-300", "--format=%s"], { cwd: path, allowFailure: true }),
    git(["branch", "-a", "--format=%(refname:short)"], { cwd: path, allowFailure: true }),
  ]);
  const base: DiscoveredProject = {
    path,
    lastUsed,
    jiraKeys: guessJiraKeys([...subjects.split("\n"), ...branches.split("\n")], options.jiraKeys),
  };
  if (!origin) return { ...base, problem: "No origin remote" };
  const remote = parseRemote(origin);
  if (!remote) return { ...base, problem: "Its origin is not on GitHub or Bitbucket" };
  if (options.existing.has(`${remote.provider}:${remote.fullName.toLowerCase()}`)) return undefined;
  const name = remote.provider === "github" ? "GitHub" : "Bitbucket";
  const repos = await options.repos(remote.provider);
  if (!repos) return { ...base, remote, problem: `Connect ${name} to use it` };
  let repo: RepoSummary | undefined = repos.find(
    (r) => r.fullName.toLowerCase() === remote.fullName.toLowerCase(),
  );
  if (!repo) {
    const found = options.lookup
      ? await options.lookup(remote.provider, remote.fullName)
      : `Your ${name} account can't reach ${remote.fullName}`;
    if (typeof found === "string") return { ...base, remote, problem: found };
    repo = found;
  }
  const { provider, fullName, defaultBranch, cloneUrl, webUrl } = repo;
  return { ...base, remote, repo: { provider, fullName, defaultBranch, cloneUrl, webUrl } };
}

/** Why a repository is out of the account's reach, with what to do about it. */
export function unreachable(
  provider: GitProviderId,
  fullName: string,
  user: string | undefined,
  err: unknown,
): string {
  const who = user ? ` (connected as ${user})` : "";
  const status = err instanceof HttpError ? err.status : undefined;
  if (provider === "bitbucket")
    return `Bitbucket${who} can't reach ${fullName}${status ? ` (HTTP ${status})` : ""}: check the account is a member of that workspace and the token has read:workspace and read:repository, then search again.`;
  if (status === 404)
    return `GitHub says the token${who} can't see ${fullName} (404). Add it under "Repository access" of that very token on github.com/settings/personal-access-tokens. A regenerated token has a new value: connect GitHub again in Settings with it.`;
  if (status === 401)
    return `GitHub refused the token${who} (401): it expired or was regenerated. Connect GitHub again in Settings.`;
  const detail = err instanceof Error ? err.message : String(err);
  return `GitHub refused ${fullName}${who}: ${detail}`;
}
