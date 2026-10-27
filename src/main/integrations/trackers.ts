import type {
  IssueChanges,
  IssueDetail,
  IssueQuery,
  IssueSummary,
  IssueType,
  NewIssue,
} from "../../shared/work/types";
import { HttpError, jsonClient, type Fetch } from "./http";
import { JiraClient, pickTransition } from "./jira";

/**
 * Where tickets live. A project uses Jira, or the GitHub Issues of its repository, so a
 * team with only GitHub needs nothing else.
 */
/** The new status, or why the ticket did not move. */
export interface Advance {
  moved?: string;
  skipped?: string;
}

export interface IssueTracker {
  readonly kind: "jira" | "github";
  search(query?: IssueQuery): Promise<IssueSummary[]>;
  issue(key: string): Promise<IssueDetail>;
  /** Empty when the tracker has no issue types. */
  issueTypes(): Promise<IssueType[]>;
  /** Returns the new issue's key. */
  create(issue: NewIssue): Promise<string>;
  update(key: string, changes: IssueChanges): Promise<void>;
  transition(key: string, transitionId: string): Promise<void>;
  comment(key: string, text: string): Promise<void>;
  /** One attachment's bytes. */
  attachment(id: string): Promise<{ mimeType: string; data: Buffer }>;
  /**
   * Moves the ticket when an agent starts or hands its work back. Returns the new status,
   * or why nothing moved.
   */
  advance(key: string, goal: "start" | "review"): Promise<Advance>;
  /** Pull request text pointing at the ticket ("Closes #12" closes it on merge). */
  pullRequestReference(issue: IssueSummary): string;
  /** Pull request and commit title. */
  title(issue: IssueSummary): string;
}

export class JiraTracker implements IssueTracker {
  readonly kind = "jira";

  constructor(
    private readonly jira: JiraClient,
    private readonly projectKey: string,
  ) {}

  search(query?: IssueQuery) {
    return this.jira.search(this.projectKey, query);
  }
  issue(key: string) {
    return this.jira.issue(key);
  }
  issueTypes() {
    return this.jira.issueTypes(this.projectKey);
  }
  create(issue: NewIssue) {
    return this.jira.create(this.projectKey, issue);
  }
  update(key: string, changes: IssueChanges) {
    return this.jira.update(key, changes);
  }
  transition(key: string, id: string) {
    return this.jira.transition(key, id);
  }
  comment(key: string, text: string) {
    return this.jira.comment(key, text);
  }
  attachment(id: string) {
    return this.jira.attachment(id);
  }

  async advance(key: string, goal: "start" | "review"): Promise<Advance> {
    const transition = pickTransition(await this.jira.transitions(key), goal);
    if (!transition)
      return { skipped: `no "${goal === "start" ? "in progress" : "review"}" transition` };
    await this.jira.transition(key, transition.id);
    return { moved: transition.to };
  }

  pullRequestReference(issue: IssueSummary): string {
    return `Jira: [${issue.key}](${issue.url})`;
  }

  title(issue: IssueSummary): string {
    return `${issue.key}: ${issue.summary}`;
  }
}

interface GhIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  updated_at: string;
  user?: { login: string } | null;
  author_association?: string;
  assignee?: { login: string } | null;
  labels?: (string | { name?: string })[];
  pull_request?: unknown;
}

interface GhComment {
  user?: { login: string } | null;
  author_association?: string;
  created_at: string;
  body?: string | null;
}

/**
 * People whose words may become an agent's instructions. Anyone can open an issue or comment
 * on a public repository; an agent running their text could run their commands.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export const isTrustedAuthor = (association: string | undefined): boolean =>
  TRUSTED_ASSOCIATIONS.has(association ?? "");

/** "#12" or "12" -> 12. */
export function issueNumber(key: string): number {
  const n = Number(key.replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a GitHub issue: ${key}`);
  return n;
}

/** Search box text -> GitHub search query for this repository's issues. */
export function githubSearchQuery(fullName: string, query: IssueQuery): string {
  const parts = [`repo:${fullName}`, "is:issue"];
  if (!query.includeDone) parts.push("is:open");
  const text = query.text?.trim();
  if (text) parts.push(text);
  return parts.join(" ");
}

/** The GitHub Issues of one repository, with the GitHub account's token. */
export class GitHubIssues implements IssueTracker {
  readonly kind = "github";
  private readonly call;

  constructor(
    private readonly fullName: string,
    token: string,
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

  private path(suffix = ""): string {
    return `/repos/${this.fullName}/issues${suffix}`;
  }

  /** A write to the issues, saying which token permission is missing when GitHub refuses it. */
  private async write<T>(method: string, path: string, body: unknown): Promise<T> {
    try {
      return await this.call<T>(method, path, body);
    } catch (err) {
      if (
        err instanceof HttpError &&
        err.status === 403 &&
        /personal access token/i.test(err.message)
      )
        throw new HttpError(
          403,
          `The GitHub token can read ${this.fullName} but not write its issues. On github.com/settings/personal-access-tokens, edit that token: under "Repository permissions" set Issues to "Read and write", and check ${this.fullName} is under "Repository access".`,
        );
      throw err;
    }
  }

  async search(query: IssueQuery = {}): Promise<IssueSummary[]> {
    const text = query.text?.trim() ?? "";
    // "#12" or "12" goes straight to that issue.
    if (/^#?\d+$/.test(text)) {
      const issue = await this.call<GhIssue>("GET", this.path(`/${issueNumber(text)}`)).catch(
        () => undefined,
      );
      return issue && !issue.pull_request ? [this.summary(issue)] : [];
    }
    if (text) {
      const q = encodeURIComponent(githubSearchQuery(this.fullName, query));
      const res = await this.call<{ items: GhIssue[] }>(
        "GET",
        `/search/issues?q=${q}&sort=updated&per_page=50`,
      );
      return res.items.map((i) => this.summary(i));
    }
    const state = query.includeDone ? "all" : "open";
    const issues = await this.call<GhIssue[]>(
      "GET",
      this.path(`?state=${state}&sort=updated&per_page=50`),
    );
    // This endpoint also lists pull requests.
    return issues.filter((i) => !i.pull_request).map((i) => this.summary(i));
  }

  async issue(key: string): Promise<IssueDetail> {
    const n = issueNumber(key);
    const [issue, comments, repo, parent, children] = await Promise.all([
      this.call<GhIssue>("GET", this.path(`/${n}`)),
      this.call<GhComment[]>("GET", this.path(`/${n}/comments?per_page=100`)),
      this.call<{ permissions?: Record<string, boolean>; has_issues?: boolean; private?: boolean }>(
        "GET",
        `/repos/${this.fullName}`,
      ),
      // Sub-issues can be off for the repository: no parent, no children then.
      this.call<GhIssue>("GET", this.path(`/${n}/parent`)).catch(() => undefined),
      this.call<GhIssue[]>("GET", this.path(`/${n}/sub_issues?per_page=100`)).catch(() => []),
    ]);
    const p = repo.permissions ?? {};
    const triage = Boolean(p.admin || p.maintain || p.push || p.triage);
    return {
      ...this.summary(issue),
      description: issue.body ?? "",
      author: issue.user?.login,
      parent: parent ? this.summary(parent) : undefined,
      children: children.map((c) => this.summary(c)),
      // Files on GitHub are links in the Markdown, opened in the browser.
      attachments: [],
      trusted: isTrustedAuthor(issue.author_association),
      publicRepo: repo.private === false,
      transitions:
        issue.state === "open"
          ? [
              { id: "closed:completed", name: "Close as completed", to: "Closed" },
              { id: "closed:not_planned", name: "Close as not planned", to: "Closed" },
            ]
          : [{ id: "open", name: "Reopen", to: "Open" }],
      comments: comments.slice(-20).map((c) => ({
        author: c.user?.login ?? "unknown",
        created: c.created_at,
        text: c.body ?? "",
        trusted: isTrustedAuthor(c.author_association),
      })),
      permissions: {
        edit: triage,
        transition: triage,
        comment: true,
        create: repo.has_issues !== false,
      },
    };
  }

  async issueTypes(): Promise<IssueType[]> {
    return [];
  }

  async attachment(): Promise<{ mimeType: string; data: Buffer }> {
    throw new Error("GitHub issues keep their files as links: open them from the description");
  }

  async create(issue: NewIssue): Promise<string> {
    const parent = issue.parentKey ? issueNumber(issue.parentKey) : undefined;
    const created = await this.write<GhIssue>("POST", this.path(), {
      title: issue.summary.trim(),
      body: [parent ? `Part of #${parent}` : "", issue.description ?? ""]
        .filter(Boolean)
        .join("\n\n"),
    });
    // Sub-issues may be off for the repository: the "Part of" line still links them.
    if (parent)
      await this.call("POST", this.path(`/${parent}/sub_issues`), {
        sub_issue_id: created.id,
      }).catch(() => undefined);
    return `#${created.number}`;
  }

  async update(key: string, changes: IssueChanges): Promise<void> {
    const body: Record<string, string> = {};
    if (changes.summary !== undefined) body.title = changes.summary.trim();
    if (changes.description !== undefined) body.body = changes.description;
    if (Object.keys(body).length === 0) return;
    await this.write("PATCH", this.path(`/${issueNumber(key)}`), body);
  }

  async transition(key: string, transitionId: string): Promise<void> {
    const [state, reason] = transitionId.split(":");
    if (state !== "open" && state !== "closed")
      throw new Error(`Unknown transition ${transitionId}`);
    await this.write("PATCH", this.path(`/${issueNumber(key)}`), {
      state,
      ...(reason ? { state_reason: reason } : {}),
    });
  }

  async comment(key: string, text: string): Promise<void> {
    await this.write("POST", this.path(`/${issueNumber(key)}/comments`), { body: text });
  }

  async advance(_key: string, goal: "start" | "review"): Promise<Advance> {
    // GitHub issues are only open or closed; the pull request closes it when merged.
    return {
      skipped:
        goal === "start"
          ? "GitHub issues have no in-progress status"
          : "the issue closes when the pull request is merged",
    };
  }

  pullRequestReference(issue: IssueSummary): string {
    return `Closes ${issue.key}`;
  }

  title(issue: IssueSummary): string {
    return `${issue.summary} (${issue.key})`;
  }

  private summary(issue: GhIssue): IssueSummary {
    const labels = (issue.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .filter(Boolean);
    return {
      key: `#${issue.number}`,
      summary: issue.title,
      status: issue.state === "open" ? "Open" : "Closed",
      statusCategory: issue.state === "open" ? "new" : "done",
      type: labels.join(", ") || "Issue",
      assignee: issue.assignee?.login,
      updated: issue.updated_at,
      url: issue.html_url,
    };
  }
}
