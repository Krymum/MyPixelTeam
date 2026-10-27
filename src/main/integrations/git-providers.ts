import type { CiState, GitProviderId, RepoSummary } from "../../shared/work/types";
import type { FailedCheck, ReviewComment } from "../work/agent-protocol";
import { basicAuth, HttpError, jsonClient, type Fetch } from "./http";
import { isTrustedAuthor } from "./trackers";

/** What the runner needs from a code host: repositories, git credentials, pull requests. */
export interface GitProvider {
  readonly id: GitProviderId;
  whoami(): Promise<string>;
  repos(): Promise<RepoSummary[]>;
  /** One repository asked for directly; rejects with the service's answer (404 when unseen). */
  repo(fullName: string): Promise<RepoSummary>;
  /** Username/password pair for git over HTTPS. */
  gitAuth(): { username: string; password: string };
  /** Opens a pull request, or returns the open one for that branch. */
  pullRequest(fullName: string, pr: PullRequestInput): Promise<string>;
  /** Comments left on a pull request, given its web URL, oldest first. */
  reviewComments(fullName: string, pullRequestUrl: string): Promise<ReviewComment[]>;
  /** The checks reported on a commit; "none" while (or when) the repository runs none. */
  checks(fullName: string, sha: string): Promise<CiReport>;
}

export interface CiReport {
  state: CiState | "none";
  /** Filled once every check is done. */
  failed: FailedCheck[];
}

/** Lines of a failing job's log handed to the agent: the error is nearly always at the end. */
const LOG_LINES = 120;
const LOG_CHECKS = 3;

/** All done: failed if any failed. */
export function ciReport(checks: { state: CiState }[], failed: FailedCheck[]): CiReport {
  if (!checks.length) return { state: "none", failed: [] };
  if (checks.some((c) => c.state === "pending")) return { state: "pending", failed: [] };
  return failed.length ? { state: "failure", failed } : { state: "success", failed: [] };
}

/** The end of a log, without GitHub's timestamps and ANSI colours. */
export function logTail(text: string, lines = LOG_LINES): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ""))
      .slice(-lines)
      .join("\n")
      .trim()
  );
}

/** The pull request number in its web URL (".../pull/12", ".../pull-requests/12"). */
export function pullRequestNumber(url: string): number {
  const m = /\/pull(?:-requests)?\/(\d+)/.exec(url);
  if (!m) throw new Error(`Not a pull request URL: ${url}`);
  return Number(m[1]);
}

export interface PullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
}

const MAX_PAGES = 10;

interface GhRepo {
  full_name: string;
  default_branch: string;
  clone_url: string;
  html_url: string;
  private: boolean;
  owner: { login: string };
}

/** github.com with a personal access token (contents and pull requests read/write). */
export class GitHubProvider implements GitProvider {
  readonly id = "github";
  private readonly call;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.call = jsonClient(
      "https://api.github.com",
      {
        Authorization: `Bearer ${token.trim()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MyPixelTeam",
      },
      fetchImpl,
    );
  }

  async whoami(): Promise<string> {
    return (await this.call<{ login: string }>("GET", "/user")).login;
  }

  async repos(): Promise<RepoSummary[]> {
    const found: RepoSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.call<GhRepo[]>(
        "GET",
        `/user/repos?per_page=100&sort=updated&page=${page}`,
      );
      found.push(...batch.map(githubRepo));
      if (batch.length < 100) break;
    }
    return found;
  }

  async repo(fullName: string): Promise<RepoSummary> {
    return githubRepo(await this.call<GhRepo>("GET", `/repos/${fullName}`));
  }

  gitAuth() {
    return { username: "x-access-token", password: this.token.trim() };
  }

  async reviewComments(fullName: string, pullRequestUrl: string): Promise<ReviewComment[]> {
    const n = pullRequestNumber(pullRequestUrl);
    type Gh = {
      user?: { login: string } | null;
      author_association?: string;
      body?: string | null;
      path?: string;
      line?: number | null;
      created_at?: string;
      submitted_at?: string;
    };
    const [inline, reviews, general] = await Promise.all([
      this.call<Gh[]>("GET", `/repos/${fullName}/pulls/${n}/comments?per_page=100`),
      this.call<Gh[]>("GET", `/repos/${fullName}/pulls/${n}/reviews?per_page=100`),
      this.call<Gh[]>("GET", `/repos/${fullName}/issues/${n}/comments?per_page=100`),
    ]);
    const at = (c: Gh) => c.created_at ?? c.submitted_at ?? "";
    return [...inline, ...reviews, ...general]
      .filter((c) => c.body?.trim())
      .sort((a, b) => at(a).localeCompare(at(b)))
      .map((c) => ({
        author: c.user?.login ?? "someone",
        body: c.body!,
        path: c.path,
        line: c.line ?? undefined,
        trusted: isTrustedAuthor(c.author_association),
      }));
  }

  async checks(fullName: string, sha: string): Promise<CiReport> {
    type Run = {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      html_url?: string;
      output?: { summary?: string | null };
      app?: { slug?: string };
    };
    type Status = { context: string; state: string; target_url?: string; description?: string };
    const [runs, combined] = await Promise.all([
      this.call<{ check_runs: Run[] }>(
        "GET",
        `/repos/${fullName}/commits/${sha}/check-runs?per_page=100`,
      ),
      this.call<{ statuses: Status[] }>("GET", `/repos/${fullName}/commits/${sha}/status`),
    ]);
    const failedRun = (r: Run) => r.conclusion === "failure" || r.conclusion === "timed_out";
    const checks = [
      ...runs.check_runs.map((r) => ({
        state: (r.status !== "completed"
          ? "pending"
          : failedRun(r)
            ? "failure"
            : "success") as CiState,
      })),
      ...combined.statuses.map((s) => ({
        state: (s.state === "pending"
          ? "pending"
          : s.state === "success"
            ? "success"
            : "failure") as CiState,
      })),
    ];
    const failed: FailedCheck[] = [
      ...(await Promise.all(
        runs.check_runs.filter(failedRun).map(async (r, i) => ({
          name: r.name,
          url: r.html_url,
          summary: r.output?.summary ?? undefined,
          // A GitHub Actions check run is a job: its log is one call away.
          log:
            r.app?.slug === "github-actions" && i < LOG_CHECKS
              ? await this.jobLog(fullName, r.id)
              : undefined,
        })),
      )),
      ...combined.statuses
        .filter((s) => s.state === "failure" || s.state === "error")
        .map((s) => ({ name: s.context, url: s.target_url, summary: s.description })),
    ];
    return ciReport(checks, failed);
  }

  /** The end of an Actions job's log; undefined when it can't be read. */
  private async jobLog(fullName: string, jobId: number): Promise<string | undefined> {
    try {
      // Answers with a redirect to the log file; fetch drops the token on the way there.
      const res = await this.fetchImpl(
        `https://api.github.com/repos/${fullName}/actions/jobs/${jobId}/logs`,
        {
          headers: {
            Authorization: `Bearer ${this.token.trim()}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "MyPixelTeam",
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      return res.ok ? logTail(await res.text()) : undefined;
    } catch {
      return undefined;
    }
  }

  async pullRequest(fullName: string, pr: PullRequestInput): Promise<string> {
    try {
      const created = await this.call<{ html_url: string }>("POST", `/repos/${fullName}/pulls`, {
        title: pr.title,
        body: pr.body,
        head: pr.head,
        base: pr.base,
      });
      return created.html_url;
    } catch (err) {
      const owner = fullName.split("/")[0];
      const head = encodeURIComponent(`${owner}:${pr.head}`);
      const open = await this.call<{ html_url: string }[]>(
        "GET",
        `/repos/${fullName}/pulls?state=open&head=${head}`,
      ).catch(() => []);
      if (open[0]) return open[0].html_url;
      throw err;
    }
  }
}

const githubRepo = (r: GhRepo): RepoSummary => ({
  provider: "github",
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  cloneUrl: r.clone_url,
  webUrl: r.html_url,
  private: r.private,
});

interface BbRepo {
  full_name: string;
  is_private: boolean;
  mainbranch?: { name: string } | null;
  links: { html: { href: string }; clone?: { name: string; href: string }[] };
}

function bitbucketRepo(r: BbRepo): RepoSummary {
  const https = r.links.clone?.find((c) => c.name === "https")?.href;
  return {
    provider: "bitbucket",
    fullName: r.full_name,
    defaultBranch: r.mainbranch?.name ?? "main",
    // Clone links embed the username ("https://user@bitbucket.org/..."): drop it.
    cloneUrl: https
      ? https.replace(/\/\/[^@/]+@/, "//")
      : `https://bitbucket.org/${r.full_name}.git`,
    webUrl: r.links.html.href,
    private: r.is_private,
  };
}

/** Newest first. Each lists workspaces as `{ workspace: { slug } }` or `{ slug }`. */
const WORKSPACE_ENDPOINTS = [
  "/user/workspaces?pagelen=100",
  "/user/permissions/workspaces?pagelen=100",
  "/workspaces?role=member&pagelen=100",
];

interface BbWorkspaceEntry {
  slug?: string;
  workspace?: { slug?: string };
}

interface BbPage<T> {
  values: T[];
  next?: string;
}

/** bitbucket.org with an Atlassian API token that has Bitbucket scopes. */
export class BitbucketProvider implements GitProvider {
  readonly id = "bitbucket";
  private readonly call;
  /** Bitbucket username, used for git over HTTPS; filled by whoami(). */
  username?: string;

  constructor(
    email: string,
    private readonly token: string,
    username?: string,
    fetchImpl?: Fetch,
  ) {
    this.username = username;
    this.call = jsonClient(
      "https://api.bitbucket.org/2.0",
      { Authorization: basicAuth(email.trim(), token.trim()) },
      fetchImpl,
    );
  }

  async whoami(): Promise<string> {
    const me = await this.call<{ username: string; display_name?: string }>("GET", "/user");
    this.username = me.username;
    return me.username;
  }

  /**
   * Bitbucket removed the cross-workspace listing (`GET /repositories?role=member`): list
   * the account's workspaces, then each one's repositories.
   */
  async repos(): Promise<RepoSummary[]> {
    const found: RepoSummary[] = [];
    for (const workspace of await this.workspaces()) {
      const first = `/repositories/${encodeURIComponent(workspace)}?pagelen=100&sort=-updated_on`;
      found.push(...(await this.pages<BbRepo>(first)).map(bitbucketRepo));
    }
    return found;
  }

  /** Workspace slugs, from the current endpoint or, on older deployments, the previous ones. */
  async workspaces(): Promise<string[]> {
    for (const path of WORKSPACE_ENDPOINTS) {
      try {
        const values = await this.pages<BbWorkspaceEntry>(path);
        return [...new Set(values.flatMap((v) => v.workspace?.slug ?? v.slug ?? []))];
      } catch (err) {
        // Endpoint gone: try the next one. Anything else (bad token, scopes) is the answer.
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    }
    throw new Error("Bitbucket offers no way to list your workspaces: please report this");
  }

  private async pages<T>(first: string): Promise<T[]> {
    const values: T[] = [];
    let path: string | undefined = first;
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const res: BbPage<T> = await this.call<BbPage<T>>("GET", path);
      values.push(...res.values);
      path = res.next;
    }
    return values;
  }

  async repo(fullName: string): Promise<RepoSummary> {
    return bitbucketRepo(await this.call<BbRepo>("GET", `/repositories/${fullName}`));
  }

  async reviewComments(fullName: string, pullRequestUrl: string): Promise<ReviewComment[]> {
    const id = pullRequestNumber(pullRequestUrl);
    type Bb = {
      deleted?: boolean;
      user?: { display_name?: string; nickname?: string };
      content?: { raw?: string };
      inline?: { path?: string; to?: number | null; from?: number | null };
    };
    // Bitbucket gives no author role: on a private repository only members can comment,
    // on a public one anyone with an account can, so none of those reach an agent.
    const [repo, comments] = await Promise.all([
      this.repo(fullName),
      this.pages<Bb>(`/repositories/${fullName}/pullrequests/${id}/comments?pagelen=100`),
    ]);
    return comments
      .filter((c) => !c.deleted && c.content?.raw?.trim())
      .map((c) => ({
        author: c.user?.display_name ?? c.user?.nickname ?? "someone",
        body: c.content!.raw!,
        path: c.inline?.path,
        line: c.inline?.to ?? c.inline?.from ?? undefined,
        trusted: repo.private,
      }));
  }

  /** Bitbucket gives each build's state and link, not its log. */
  async checks(fullName: string, sha: string): Promise<CiReport> {
    type Status = { state: string; name?: string; key: string; url?: string; description?: string };
    const statuses = await this.pages<Status>(
      `/repositories/${fullName}/commit/${sha}/statuses?pagelen=100`,
    );
    const stateOf = (s: Status): CiState =>
      s.state === "INPROGRESS" ? "pending" : s.state === "SUCCESSFUL" ? "success" : "failure";
    return ciReport(
      statuses.map((s) => ({ state: stateOf(s) })),
      statuses
        .filter((s) => stateOf(s) === "failure")
        .map((s) => ({ name: s.name ?? s.key, url: s.url, summary: s.description })),
    );
  }

  gitAuth() {
    if (!this.username) throw new Error("Bitbucket username unknown: reconnect the account");
    return { username: this.username, password: this.token.trim() };
  }

  async pullRequest(fullName: string, pr: PullRequestInput): Promise<string> {
    const base = `/repositories/${fullName}/pullrequests`;
    try {
      const created = await this.call<{ links: { html: { href: string } } }>("POST", base, {
        title: pr.title,
        description: pr.body,
        source: { branch: { name: pr.head } },
        destination: { branch: { name: pr.base } },
        close_source_branch: true,
      });
      return created.links.html.href;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const q = encodeURIComponent(`source.branch.name="${pr.head}" AND state="OPEN"`);
      const open = await this.call<BbPage<{ links: { html: { href: string } } }>>(
        "GET",
        `${base}?q=${q}`,
      ).catch(() => ({ values: [] }));
      if (open.values[0]) return open.values[0].links.html.href;
      throw err;
    }
  }
}
