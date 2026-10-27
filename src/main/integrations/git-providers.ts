import type { GitProviderId, RepoSummary } from "../../shared/work/types";
import { basicAuth, HttpError, jsonClient, type Fetch } from "./http";

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
    fetchImpl?: Fetch,
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
