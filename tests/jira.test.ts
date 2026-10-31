import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/main/integrations/http";
import { buildJql, JiraClient, normalizeSite, pickTransition } from "../src/main/integrations/jira";
import { fakeFetch } from "./work-helpers";

const creds = { site: "acme", email: "me@acme.com", token: "tok" };
const adf = (t: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
});

const rawIssue = {
  key: "PROJ-1",
  fields: {
    summary: "Fix login",
    status: { name: "To Do", statusCategory: { key: "new" } },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: null,
    updated: "2026-10-27T10:00:00.000+0200",
    description: adf("Broken"),
    attachment: [
      {
        id: 10042,
        filename: "screen.png",
        mimeType: "image/png",
        size: 2048,
        created: "2026-10-26T09:00:00.000+0200",
        author: { displayName: "Ana" },
      },
    ],
    comment: {
      comments: [
        {
          author: { displayName: "Ana" },
          created: "2026-10-26T09:00:00.000+0200",
          body: adf("Please"),
        },
      ],
    },
  },
};

describe("normalizeSite", () => {
  it("accepts a name, a host or a URL", () => {
    expect(normalizeSite("acme")).toBe("https://acme.atlassian.net");
    expect(normalizeSite("acme.atlassian.net/")).toBe("https://acme.atlassian.net");
    expect(normalizeSite(" https://acme.atlassian.net/jira/your-work ")).toBe(
      "https://acme.atlassian.net",
    );
  });

  it("refuses http and empty sites", () => {
    expect(() => normalizeSite("http://acme.atlassian.net")).toThrow(/https/);
    expect(() => normalizeSite(" ")).toThrow(/required/);
  });
});

describe("buildJql", () => {
  it("hides done tickets unless asked", () => {
    expect(buildJql("PROJ")).toBe(
      'project = "PROJ" AND statusCategory != Done ORDER BY updated DESC',
    );
    expect(buildJql("PROJ", { includeDone: true })).toBe('project = "PROJ" ORDER BY updated DESC');
  });

  it("searches text, or goes straight to a typed key", () => {
    expect(buildJql("PROJ", { text: 'say "hi"' })).toContain('text ~ "say \\"hi\\""');
    expect(buildJql("PROJ", { text: "proj-12" })).toContain('key = "PROJ-12"');
  });
});

describe("pickTransition", () => {
  const transitions = [
    { id: "1", name: "Start", to: "Doing", toCategory: "indeterminate" as const },
    { id: "2", name: "Begin work", to: "In Progress", toCategory: "indeterminate" as const },
    { id: "3", name: "Review", to: "Code Review", toCategory: "indeterminate" as const },
    { id: "4", name: "Done", to: "Done", toCategory: "done" as const },
  ];

  it("prefers an in-progress status to start", () => {
    expect(pickTransition(transitions, "start")?.id).toBe("1");
    expect(pickTransition(transitions.slice(1), "start")?.id).toBe("2");
    expect(pickTransition([transitions[2]!], "start")?.id).toBe("3");
  });

  it("only hands back to a review status, never to done", () => {
    expect(pickTransition(transitions, "review")?.id).toBe("3");
    expect(pickTransition([transitions[3]!], "review")).toBeUndefined();
  });

  it("closes a merged ticket with a done status", () => {
    expect(pickTransition(transitions, "done")?.id).toBe("4");
    expect(pickTransition(transitions.slice(0, 3), "done")).toBeUndefined();
  });
});

describe("JiraClient", () => {
  it("authenticates with email and token", async () => {
    const { fetch, calls } = fakeFetch({ "GET /rest/api/3/myself": { displayName: "Me" } });
    expect(await new JiraClient(creds, fetch).myself()).toBe("Me");
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(calls[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`,
    );
  });

  it("searches with the JQL endpoint", async () => {
    const { fetch, calls } = fakeFetch({ "GET /rest/api/3/search/jql": { issues: [rawIssue] } });
    const issues = await new JiraClient(creds, fetch).search("PROJ");
    expect(issues).toEqual([
      {
        key: "PROJ-1",
        summary: "Fix login",
        status: "To Do",
        statusCategory: "new",
        type: "Bug",
        priority: "High",
        assignee: undefined,
        updated: "2026-10-27T10:00:00.000+0200",
        url: "https://acme.atlassian.net/browse/PROJ-1",
      },
    ]);
    expect(new URL(calls[0]!.url).searchParams.get("jql")).toContain('project = "PROJ"');
  });

  it("loads an issue with transitions, comments and permissions", async () => {
    const { fetch } = fakeFetch({
      "GET /rest/api/3/issue/PROJ-1/transitions": {
        transitions: [
          {
            id: "11",
            name: "Start",
            to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          },
        ],
      },
      "GET /rest/api/3/issue/PROJ-1": rawIssue,
      "GET /rest/api/3/mypermissions": {
        permissions: {
          EDIT_ISSUES: { havePermission: true },
          TRANSITION_ISSUES: { havePermission: false },
          ADD_COMMENTS: { havePermission: true },
          CREATE_ISSUES: { havePermission: true },
        },
      },
    });
    const issue = await new JiraClient(creds, fetch).issue("PROJ-1");
    expect(issue.description).toBe("Broken");
    expect(issue.transitions).toEqual([{ id: "11", name: "Start", to: "In Progress" }]);
    expect(issue.comments).toEqual([
      { author: "Ana", created: "2026-10-26T09:00:00.000+0200", text: "Please", trusted: true },
    ]);
    expect(issue.permissions).toEqual({
      edit: true,
      transition: false,
      comment: true,
      create: true,
    });
  });

  it("writes descriptions and comments as ADF", async () => {
    const { fetch, calls } = fakeFetch({
      "PUT /rest/api/3/issue/PROJ-1": undefined,
      "POST /rest/api/3/issue/PROJ-1/comment": {},
      "POST /rest/api/3/issue": { key: "PROJ-2" },
    });
    const jira = new JiraClient(creds, fetch);
    await jira.update("PROJ-1", { summary: " New ", description: "Text" });
    await jira.comment("PROJ-1", "Hi");
    const key = await jira.create("PROJ", {
      issueTypeId: "10001",
      summary: "Add",
      description: "",
    });
    expect(key).toBe("PROJ-2");
    expect(calls[0]!.body).toEqual({ fields: { summary: "New", description: adf("Text") } });
    expect(calls[1]!.body).toEqual({ body: adf("Hi") });
    expect(calls[2]!.body).toEqual({
      fields: { project: { key: "PROJ" }, issuetype: { id: "10001" }, summary: "Add" },
    });
  });

  it("lists creatable issue types without subtasks", async () => {
    const { fetch } = fakeFetch({
      "GET /rest/api/3/issue/createmeta/PROJ/issuetypes": {
        issueTypes: [
          { id: "1", name: "Task" },
          { id: "2", name: "Sub-task", subtask: true },
        ],
      },
    });
    expect(await new JiraClient(creds, fetch).issueTypes("PROJ")).toEqual([
      { id: "1", name: "Task" },
    ]);
  });

  it("reports Jira's error messages", async () => {
    const { fetch } = fakeFetch({
      "GET /rest/api/3/myself": [401, { errorMessages: ["Bad token"] }],
    });
    await expect(new JiraClient(creds, fetch).myself()).rejects.toThrow(
      "Invalid credentials (Bad token)",
    );
  });
});

describe("errorMessage", () => {
  it("reads the error shapes of the three services", () => {
    expect(errorMessage(400, { errors: { summary: "Required" } })).toBe("Required");
    expect(
      errorMessage(422, { message: "Validation Failed", errors: [{ message: "exists" }] }),
    ).toBe("exists · Validation Failed");
    expect(errorMessage(400, { error: { message: "Bad branch" } })).toBe("Bad branch");
    expect(errorMessage(403, {})).toBe("Not allowed for this account");
    expect(errorMessage(500, undefined)).toBe("HTTP 500");
  });
});

describe("Jira attachments", () => {
  it("lists them with the issue", async () => {
    const { fetch } = fakeFetch({
      "GET /rest/api/3/issue/PROJ-1/transitions": { transitions: [] },
      "GET /rest/api/3/issue/PROJ-1": rawIssue,
      "GET /rest/api/3/mypermissions": { permissions: {} },
    });
    const issue = await new JiraClient(creds, fetch).issue("PROJ-1");
    expect(issue.attachments).toEqual([
      {
        id: "10042",
        filename: "screen.png",
        mimeType: "image/png",
        size: 2048,
        author: "Ana",
        created: "2026-10-26T09:00:00.000+0200",
        url: "https://acme.atlassian.net/rest/api/3/attachment/content/10042",
      },
    ]);
  });

  /** Answers attachment downloads with raw bytes. */
  const bytes = (body: Uint8Array, headers: Record<string, string> = {}, status = 200) =>
    (async (input: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: (init?.headers as Record<string, string>).Authorization,
      });
      return new Response(body, { status, headers: { "content-type": "image/png", ...headers } });
    }) as typeof fetch;
  let seen: { url: string; auth?: string }[] = [];

  it("downloads one with the account", async () => {
    seen = [];
    const png = new Uint8Array([137, 80, 78, 71]);
    const file = await new JiraClient(creds, bytes(png)).attachment("10042");
    expect(file.mimeType).toBe("image/png");
    expect([...file.data]).toEqual([137, 80, 78, 71]);
    expect(seen[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/attachment/content/10042");
    expect(seen[0]!.auth).toMatch(/^Basic /);
  });

  it("refuses odd ids, missing files and huge files", async () => {
    const jira = new JiraClient(creds, bytes(new Uint8Array()));
    await expect(jira.attachment("../secrets")).rejects.toThrow(/Not an attachment id/);
    await expect(
      new JiraClient(creds, bytes(new Uint8Array(), {}, 404)).attachment("1"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new JiraClient(
        creds,
        bytes(new Uint8Array(), { "content-length": String(80 * 1024 * 1024) }),
      ).attachment("1"),
    ).rejects.toThrow(/too big/);
  });
});
