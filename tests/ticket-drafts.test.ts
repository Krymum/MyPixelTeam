import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubIssues } from "../src/main/integrations/trackers";
import {
  createdComment,
  createTickets,
  pickTypes,
  takeTicketDrafts,
  TICKETS_FILE,
} from "../src/main/work/ticket-drafts";
import { fakeFetch } from "./work-helpers";

const worktreeWith = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "drafts-"));
  mkdirSync(join(dir, ".mypixelteam"));
  writeFileSync(join(dir, TICKETS_FILE), content);
  return dir;
};

describe("ticket drafts", () => {
  it("reads the agent's file and removes it so it is never committed", () => {
    const dir = worktreeWith(
      JSON.stringify([{ summary: "Epic", tickets: [{ summary: "A", description: "x" }] }]),
    );
    expect(takeTicketDrafts(dir)).toEqual([
      { summary: "Epic", tickets: [{ summary: "A", description: "x" }] },
    ]);
    expect(existsSync(join(dir, ".mypixelteam"))).toBe(false);
    expect(takeTicketDrafts(dir)).toBeUndefined();
  });

  it("refuses a file that isn't a list of tickets", () => {
    expect(() => takeTicketDrafts(worktreeWith("{"))).toThrow(/not valid JSON/);
    expect(() => takeTicketDrafts(worktreeWith('[{"title": "x"}]'))).toThrow(/not a list/);
    const many = Array.from({ length: 31 }, (_, i) => ({ summary: `T${i}` }));
    expect(() => takeTicketDrafts(worktreeWith(JSON.stringify(many)))).toThrow(/at most 30/);
  });

  it("picks Jira's Epic and Task types", () => {
    expect(
      pickTypes([
        { id: "1", name: "Story" },
        { id: "2", name: "Epic" },
        { id: "3", name: "Tâche" },
      ]),
    ).toEqual({ epic: "2", ticket: "3" });
    expect(pickTypes([])).toEqual({ epic: "", ticket: "" });
  });

  it("creates an epic on GitHub with its tickets as sub-issues", async () => {
    let next = 10;
    const { fetch, calls } = fakeFetch({
      "POST /repos/acme/app/issues/10/sub_issues": {},
      get "POST /repos/acme/app/issues"() {
        const n = next++;
        return { id: 1000 + n, number: n, title: "", state: "open", html_url: "", updated_at: "" };
      },
    });
    const created = await createTickets(
      new GitHubIssues("acme/app", "t", fetch),
      [
        { summary: "Epic", description: "Why", tickets: [{ summary: "Child" }] },
        { summary: "Solo" },
      ],
      () => {},
    );
    expect(created).toEqual([
      { key: "#10", summary: "Epic", parent: undefined },
      { key: "#11", summary: "Child", parent: "#10" },
      { key: "#12", summary: "Solo", parent: undefined },
    ]);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["POST", "/repos/acme/app/issues", { title: "Epic", body: "Why" }],
      ["POST", "/repos/acme/app/issues", { title: "Child", body: "Part of #10" }],
      ["POST", "/repos/acme/app/issues/10/sub_issues", { sub_issue_id: 1011 }],
      ["POST", "/repos/acme/app/issues", { title: "Solo", body: "" }],
    ]);
    expect(createdComment(created)).toBe(
      "An agent created these tickets:\n- #10 Epic\n  - #11 Child\n- #12 Solo",
    );
  });

  it("tells the token's missing permission when GitHub refuses to write issues", async () => {
    const { fetch } = fakeFetch({
      "POST /repos/acme/app/issues": [
        403,
        { message: "Resource not accessible by personal access token" },
      ],
    });
    await expect(
      new GitHubIssues("acme/app", "t", fetch).create({ issueTypeId: "", summary: "x" }),
    ).rejects.toThrow(/Issues to "Read and write"/);
  });
});
