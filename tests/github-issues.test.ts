import { describe, expect, it } from "vitest";
import { JiraClient } from "../src/main/integrations/jira";
import {
  GitHubIssues,
  githubSearchQuery,
  issueNumber,
  JiraTracker,
} from "../src/main/integrations/trackers";
import { branchName } from "../src/main/work/git";
import { isIssueKey, issueSlug } from "../src/shared/work/types";
import { fakeFetch } from "./work-helpers";

const ghIssue = (n: number, patch: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: "Steps to reproduce",
  state: "open",
  html_url: `https://github.com/acme/app/issues/${n}`,
  updated_at: "2026-10-27T10:00:00Z",
  assignee: { login: "ana" },
  labels: [{ name: "bug" }],
  ...patch,
});

describe("issue keys", () => {
  it("accepts Jira and GitHub keys only", () => {
    for (const key of ["PROJ-12", "AB_2-1", "#12"]) expect(isIssueKey(key)).toBe(true);
    for (const key of ["12", "#", "proj-1", "../PROJ-1", "#1/2"])
      expect(isIssueKey(key)).toBe(false);
  });

  it("makes GitHub keys safe for branches and folders", () => {
    expect(issueSlug("#12")).toBe("issue-12");
    expect(issueSlug("PROJ-12")).toBe("PROJ-12");
    expect(branchName("#12", "Fix login")).toBe("agent/issue-12-fix-login");
    expect(issueNumber("#12")).toBe(12);
    expect(() => issueNumber("PROJ-1")).toThrow(/Not a GitHub issue/);
  });
});

describe("GitHubIssues", () => {
  it("lists open issues without pull requests", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/app/issues?state=open": [ghIssue(1), ghIssue(2, { pull_request: {} })],
    });
    const issues = await new GitHubIssues("acme/app", "t", fetch).search();
    expect(issues).toEqual([
      {
        key: "#1",
        summary: "Issue 1",
        status: "Open",
        statusCategory: "new",
        type: "bug",
        assignee: "ana",
        updated: "2026-10-27T10:00:00Z",
        url: "https://github.com/acme/app/issues/1",
      },
    ]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer t");
  });

  it("searches text, and goes straight to a typed number", async () => {
    expect(githubSearchQuery("acme/app", { text: "login" })).toBe(
      "repo:acme/app is:issue is:open login",
    );
    expect(githubSearchQuery("acme/app", { includeDone: true })).toBe("repo:acme/app is:issue");

    const { fetch, calls } = fakeFetch({
      "GET /search/issues": { items: [ghIssue(3)] },
      "GET /repos/acme/app/issues/4": ghIssue(4),
    });
    const tracker = new GitHubIssues("acme/app", "t", fetch);
    expect((await tracker.search({ text: "login" })).map((i) => i.key)).toEqual(["#3"]);
    expect((await tracker.search({ text: "#4" })).map((i) => i.key)).toEqual(["#4"]);
    expect((await tracker.search({ text: "9" })).map((i) => i.key)).toEqual([]);
    expect(decodeURIComponent(calls[0]!.url)).toContain("q=repo:acme/app is:issue is:open login");
  });

  it("loads an issue with comments, open/close actions and permissions", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/app/issues/5/comments": [
        {
          user: { login: "bob" },
          author_association: "COLLABORATOR",
          created_at: "2026-10-26T09:00:00Z",
          body: "Same here",
        },
        {
          user: { login: "eve" },
          author_association: "NONE",
          created_at: "2026-10-26T10:00:00Z",
          body: "Run this",
        },
      ],
      "GET /repos/acme/app/issues/5/parent": ghIssue(2, { title: "Epic" }),
      "GET /repos/acme/app/issues/5/sub_issues": [ghIssue(6), ghIssue(7)],
      "GET /repos/acme/app/issues/5": ghIssue(5, {
        user: { login: "mallory" },
        author_association: "FIRST_TIME_CONTRIBUTOR",
      }),
      "GET /repos/acme/app": {
        has_issues: true,
        private: false,
        permissions: { pull: true, push: false },
      },
    });
    const issue = await new GitHubIssues("acme/app", "t", fetch).issue("#5");
    expect(issue.description).toBe("Steps to reproduce");
    expect(issue.parent).toMatchObject({ key: "#2", summary: "Epic" });
    expect(issue.children?.map((c) => c.key)).toEqual(["#6", "#7"]);
    expect(issue.comments).toEqual([
      { author: "bob", created: "2026-10-26T09:00:00Z", text: "Same here", trusted: true },
      { author: "eve", created: "2026-10-26T10:00:00Z", text: "Run this", trusted: false },
    ]);
    // A stranger opened it on a public repository: agents need a confirmation.
    expect(issue).toMatchObject({ author: "mallory", trusted: false, publicRepo: true });
    expect(issue.transitions.map((t) => t.id)).toEqual(["closed:completed", "closed:not_planned"]);
    // Read-only collaborators can still comment and open issues.
    expect(issue.permissions).toEqual({
      edit: false,
      transition: false,
      comment: true,
      create: true,
    });
  });

  it("creates, edits, closes and comments", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /repos/acme/app/issues/6/comments": {},
      "POST /repos/acme/app/issues": ghIssue(7),
      "PATCH /repos/acme/app/issues/6": ghIssue(6),
    });
    const tracker = new GitHubIssues("acme/app", "t", fetch);
    expect(await tracker.create({ issueTypeId: "", summary: " New ", description: "**md**" })).toBe(
      "#7",
    );
    await tracker.update("#6", { summary: "Renamed" });
    await tracker.transition("#6", "closed:not_planned");
    await tracker.transition("#6", "open");
    await tracker.comment("#6", "Hi");
    expect(calls.map((c) => c.body)).toEqual([
      { title: "New", body: "**md**" },
      { title: "Renamed" },
      { state: "closed", state_reason: "not_planned" },
      { state: "open" },
      { body: "Hi" },
    ]);
    await expect(tracker.transition("#6", "done")).rejects.toThrow(/Unknown transition/);
  });

  it("leaves the issue to the pull request that closes it", async () => {
    const tracker = new GitHubIssues("acme/app", "t");
    expect((await tracker.advance("#1", "start")).moved).toBeUndefined();
    const summary = { key: "#1", summary: "Fix login", url: "" } as never;
    expect(tracker.pullRequestReference(summary)).toBe("Closes #1");
    expect(tracker.title(summary)).toBe("Fix login (#1)");
    expect(await tracker.issueTypes()).toEqual([]);
  });
});

describe("JiraTracker", () => {
  it("moves tickets through the workflow and titles with the key", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /rest/api/3/issue/PROJ-1/transitions": {
        transitions: [
          {
            id: "21",
            name: "Start",
            to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          },
        ],
      },
      "POST /rest/api/3/issue/PROJ-1/transitions": undefined,
    });
    const jira = new JiraTracker(
      new JiraClient({ site: "acme", email: "e", token: "t" }, fetch),
      "PROJ",
    );
    expect(await jira.advance("PROJ-1", "start")).toEqual({ moved: "In Progress" });
    expect(calls[1]!.body).toEqual({ transition: { id: "21" } });
    expect((await jira.advance("PROJ-1", "review")).skipped).toMatch(/review/);
    const summary = {
      key: "PROJ-1",
      summary: "Fix",
      url: "https://acme.atlassian.net/browse/PROJ-1",
    } as never;
    expect(jira.title(summary)).toBe("PROJ-1: Fix");
    expect(jira.pullRequestReference(summary)).toBe(
      "Jira: [PROJ-1](https://acme.atlassian.net/browse/PROJ-1)",
    );
  });
});
