import type {
  IssueChanges,
  IssueDetail,
  IssueQuery,
  IssueSummary,
  IssueType,
  JiraProject,
  NewIssue,
  StatusCategory,
  Transition,
} from "../../shared/work/types";
import { adfToText, textToAdf } from "./adf";
import { basicAuth, errorMessage, HttpError, jsonClient, type Fetch } from "./http";

/** Larger files are left to the Jira web page. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Jira Cloud REST API v3 with an Atlassian account email and API token. */

export interface JiraCredentials {
  site: string;
  email: string;
  token: string;
}

/** "acme", "acme.atlassian.net" or a full URL -> "https://acme.atlassian.net". */
export function normalizeSite(input: string): string {
  let site = input.trim().replace(/\/+$/, "");
  if (!site) throw new Error("Jira site is required");
  if (!/^[a-z]+:\/\//i.test(site))
    site = site.includes(".") ? `https://${site}` : `https://${site}.atlassian.net`;
  const url = new URL(site);
  if (url.protocol !== "https:") throw new Error("Jira site must use https");
  return url.origin;
}

const SUMMARY_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name: string; statusCategory?: { key?: string } };
    issuetype?: { name: string };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
    updated?: string;
    description?: unknown;
    comment?: { comments: RawComment[] };
    attachment?: RawAttachment[];
    parent?: RawIssue;
  };
}

interface RawAttachment {
  id: string | number;
  filename: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: { displayName?: string };
}

interface RawComment {
  author?: { displayName?: string };
  created: string;
  body?: unknown;
}

interface RawTransition {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

const category = (key: string | undefined): StatusCategory =>
  key === "done" || key === "indeterminate" ? key : "new";

/** Quotes a value for JQL. */
export const jqlString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function buildJql(projectKey: string, query: IssueQuery = {}): string {
  const clauses = [`project = ${jqlString(projectKey)}`];
  if (!query.includeDone) clauses.push("statusCategory != Done");
  const text = query.text?.trim();
  if (text) {
    // An issue key typed in the search box finds that issue directly.
    clauses.push(
      /^[A-Z][A-Z0-9_]+-\d+$/i.test(text)
        ? `key = ${jqlString(text.toUpperCase())}`
        : `text ~ ${jqlString(text)}`,
    );
  }
  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

/**
 * Picks the transition to apply when an agent starts ("start") or hands its work back
 * ("review"). Workflows differ per project, so this goes by status category and name.
 */
export function pickTransition(
  transitions: (Transition & { toCategory?: StatusCategory })[],
  goal: "start" | "review",
): Transition | undefined {
  const matches = (t: Transition, re: RegExp) => re.test(t.to) || re.test(t.name);
  if (goal === "start") {
    const started = transitions.filter((t) => t.toCategory === "indeterminate");
    return started.find((t) => matches(t, /progress|cours|doing|develop/i)) ?? started[0];
  }
  return transitions.find((t) => matches(t, /review|revue|relecture/i));
}

export class JiraClient {
  readonly site: string;
  private readonly call;
  private readonly auth: string;

  constructor(
    credentials: JiraCredentials,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.site = normalizeSite(credentials.site);
    this.auth = basicAuth(credentials.email.trim(), credentials.token.trim());
    this.call = jsonClient(`${this.site}/rest/api/3`, { Authorization: this.auth }, fetchImpl);
  }

  async myself(): Promise<string> {
    const me = await this.call<{ displayName?: string; emailAddress?: string }>("GET", "/myself");
    return me.displayName ?? me.emailAddress ?? "Jira user";
  }

  async projects(): Promise<JiraProject[]> {
    const found: JiraProject[] = [];
    for (let startAt = 0; ;) {
      const page = await this.call<{ values: JiraProject[]; isLast?: boolean; total?: number }>(
        "GET",
        `/project/search?orderBy=name&maxResults=100&startAt=${startAt}`,
      );
      found.push(...page.values.map(({ key, name }) => ({ key, name })));
      startAt += page.values.length;
      if (page.isLast !== false || page.values.length === 0 || startAt >= 1000) return found;
    }
  }

  async search(projectKey: string, query: IssueQuery = {}): Promise<IssueSummary[]> {
    const params = new URLSearchParams({
      jql: buildJql(projectKey, query),
      fields: SUMMARY_FIELDS.join(","),
      maxResults: "50",
    });
    const res = await this.call<{ issues: RawIssue[] }>("GET", `/search/jql?${params}`);
    return res.issues.map((i) => this.summary(i));
  }

  async issue(key: string): Promise<IssueDetail> {
    const k = encodeURIComponent(key);
    const projectKey = key.replace(/-\d+$/, "");
    const children = new URLSearchParams({
      jql: `parent = "${key}" ORDER BY created ASC`,
      fields: SUMMARY_FIELDS.join(","),
      maxResults: "100",
    });
    const [raw, transitions, permissions, childIssues] = await Promise.all([
      this.call<RawIssue>(
        "GET",
        `/issue/${k}?fields=${[...SUMMARY_FIELDS, "description", "comment", "attachment", "parent"].join(",")}`,
      ),
      this.transitions(key),
      this.permissions(projectKey),
      // Not every Jira answers `parent =`: then the ticket just shows no children.
      this.call<{ issues: RawIssue[] }>("GET", `/search/jql?${children}`).then(
        (r) => r.issues,
        () => [],
      ),
    ]);
    const comments = raw.fields.comment?.comments ?? [];
    return {
      ...this.summary(raw),
      parent: raw.fields.parent ? this.summary(raw.fields.parent) : undefined,
      children: childIssues.map((i) => this.summary(i)),
      description: adfToText(raw.fields.description),
      transitions: transitions.map(({ id, name, to }) => ({ id, name, to })),
      attachments: (raw.fields.attachment ?? []).map((a) => ({
        id: String(a.id),
        filename: a.filename,
        mimeType: a.mimeType ?? "application/octet-stream",
        size: a.size ?? 0,
        author: a.author?.displayName,
        created: a.created,
        url: `${this.site}/rest/api/3/attachment/content/${encodeURIComponent(String(a.id))}`,
      })),
      comments: comments.slice(-20).map((c) => ({
        author: c.author?.displayName ?? "unknown",
        created: c.created,
        text: adfToText(c.body),
        trusted: true,
      })),
      trusted: true,
      permissions,
    };
  }

  async transitions(key: string): Promise<(Transition & { toCategory: StatusCategory })[]> {
    const res = await this.call<{ transitions: RawTransition[] }>(
      "GET",
      `/issue/${encodeURIComponent(key)}/transitions`,
    );
    return res.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to?.name ?? t.name,
      toCategory: category(t.to?.statusCategory?.key),
    }));
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.call("POST", `/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  async update(key: string, changes: IssueChanges): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (changes.summary !== undefined) fields.summary = changes.summary.trim();
    if (changes.description !== undefined) fields.description = textToAdf(changes.description);
    if (Object.keys(fields).length === 0) return;
    await this.call("PUT", `/issue/${encodeURIComponent(key)}`, { fields });
  }

  async comment(key: string, text: string): Promise<void> {
    await this.call("POST", `/issue/${encodeURIComponent(key)}/comment`, {
      body: textToAdf(text),
    });
  }

  async issueTypes(projectKey: string): Promise<IssueType[]> {
    const res = await this.call<{ issueTypes?: RawType[]; values?: RawType[] }>(
      "GET",
      `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
    );
    return (res.issueTypes ?? res.values ?? [])
      .filter((t) => !t.subtask)
      .map(({ id, name }) => ({ id, name }));
  }

  async create(projectKey: string, issue: NewIssue): Promise<string> {
    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      issuetype: { id: issue.issueTypeId },
      summary: issue.summary.trim(),
    };
    if (issue.description?.trim()) fields.description = textToAdf(issue.description);
    if (issue.parentKey) fields.parent = { key: issue.parentKey };
    const res = await this.call<{ key: string }>("POST", "/issue", { fields });
    return res.key;
  }

  async permissions(projectKey: string): Promise<IssueDetail["permissions"]> {
    const keys = ["EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS", "CREATE_ISSUES"];
    const params = new URLSearchParams({ projectKey, permissions: keys.join(",") });
    const res = await this.call<{ permissions: Record<string, { havePermission?: boolean }> }>(
      "GET",
      `/mypermissions?${params}`,
    );
    const has = (k: string) => res.permissions[k]?.havePermission === true;
    return {
      edit: has("EDIT_ISSUES"),
      transition: has("TRANSITION_ISSUES"),
      comment: has("ADD_COMMENTS"),
      create: has("CREATE_ISSUES"),
    };
  }

  /** An attachment's bytes. Jira redirects to its media store, which fetch follows. */
  async attachment(id: string): Promise<{ mimeType: string; data: Buffer }> {
    if (!/^\d+$/.test(id)) throw new Error(`Not an attachment id: ${id}`);
    const res = await this.fetchImpl(`${this.site}/rest/api/3/attachment/content/${id}`, {
      headers: { Authorization: this.auth, Accept: "*/*" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok)
      throw new HttpError(
        res.status,
        errorMessage(res.status, await res.json().catch(() => undefined)),
      );
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > MAX_ATTACHMENT_BYTES) throw new Error("This attachment is too big to download here");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_ATTACHMENT_BYTES)
      throw new Error("This attachment is too big to download here");
    return { mimeType: res.headers.get("content-type") ?? "application/octet-stream", data };
  }

  issueUrl(key: string): string {
    return `${this.site}/browse/${encodeURIComponent(key)}`;
  }

  private summary(raw: RawIssue): IssueSummary {
    const f = raw.fields;
    return {
      key: raw.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      statusCategory: category(f.status?.statusCategory?.key),
      type: f.issuetype?.name ?? "",
      priority: f.priority?.name,
      assignee: f.assignee?.displayName,
      updated: f.updated ?? "",
      url: this.issueUrl(raw.key),
    };
  }
}

interface RawType {
  id: string;
  name: string;
  subtask?: boolean;
}
