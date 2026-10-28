import { describe, expect, it } from "vitest";
import { GitHubIssues } from "../src/main/integrations/trackers";
import { parseInline, parseMarkdown } from "../src/shared/markdown";
import { latestRuns, needsYou, ticketState } from "../src/shared/work/run-state";
import type { RunView } from "../src/shared/work/types";
import { fakeFetch } from "./work-helpers";

const run = (patch: Partial<RunView>): RunView =>
  ({
    id: patch.issueKey ?? "r",
    projectId: "p1",
    issueKey: "#1",
    issueSummary: "",
    status: "done",
    startedAt: 0,
    log: [],
    ...patch,
  }) as RunView;

describe("ticket state", () => {
  it("says what the ticket's agent is up to", () => {
    expect(ticketState(run({ status: "running" })).label).toBe("Agent working");
    expect(ticketState(run({ status: "queued" })).tone).toBe("waiting");
    expect(
      ticketState(run({ status: "running", questions: [{ tool: "Bash" } as never] })).label,
    ).toBe("Asks you");
    expect(
      ticketState(run({ status: "failed", error: "You've hit your session limit Â· resets 8pm" }))
        .label,
    ).toBe("Usage limit");
    expect(ticketState(run({ pullRequestUrl: "u", ci: "success" })).label).toBe("Ready to review");
    expect(ticketState(run({ pullRequestUrl: "u", ci: "failure" })).tone).toBe("attention");
  });

  it("lists what needs the person, questions first, once per ticket", () => {
    const runs = [
      run({ id: "a2", issueKey: "#2", pullRequestUrl: "u", ci: "success" }),
      run({ id: "a1", issueKey: "#2", status: "failed" }),
      run({ id: "b", issueKey: "#3", status: "failed", stoppedOnBudget: true, budgetUsd: 3 }),
      run({
        id: "c",
        issueKey: "#4",
        status: "running",
        questions: [{ tool: "Bash" } as never],
      }),
      run({ id: "d", issueKey: "#5", status: "running" }),
      run({ id: "e", issueKey: "#6", status: "failed", resumeAt: Date.now() + 1000 }),
      run({ id: "f", issueKey: "#7", pullRequestUrl: "u", ci: "pending" }),
    ];
    expect(latestRuns(runs).map((r) => r.id)).toEqual(["a2", "b", "c", "d", "e", "f"]);
    expect(needsYou(runs).map((n) => [n.run.id, n.kind])).toEqual([
      ["c", "question"],
      ["b", "budget"],
      ["a2", "review"],
    ]);
    expect(needsYou(runs, new Set(["a2"])).map((n) => n.run.id)).toEqual(["c", "b"]);
  });

  it("leaves out runs that ended days ago", () => {
    const now = 10 * 24 * 3600_000;
    const runs = [
      run({ id: "old", issueKey: "#2", status: "failed", endedAt: now - 4 * 24 * 3600_000 }),
      run({ id: "new", issueKey: "#3", status: "failed", endedAt: now - 3600_000 }),
    ];
    expect(needsYou(runs, new Set(), now).map((n) => n.run.id)).toEqual(["new"]);
  });
});

describe("markdown", () => {
  it("reads the Markdown agents and tickets write", () => {
    const blocks = parseMarkdown(
      "## Goal\n\n**What I did**\n- Read `a.ts`\n- Fixed it\n  on two lines\n\n```\nnpm test\n```\n> note",
    );
    expect(blocks.map((b) => b.type)).toEqual(["h", "p", "list", "code", "quote"]);
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [
        [
          { t: "text", v: "Read " },
          { t: "code", v: "a.ts" },
        ],
        [{ t: "text", v: "Fixed it on two lines" }],
      ],
    });
    expect(blocks[3]).toEqual({ type: "code", text: "npm test" });
  });

  it("only links http(s) addresses", () => {
    expect(parseInline("[x](javascript:alert(1)) see https://a.dev/pr/3.")).toEqual([
      { t: "text", v: "[x](javascript:alert(1)) see " },
      { t: "link", href: "https://a.dev/pr/3", c: [{ t: "text", v: "https://a.dev/pr/3" }] },
      { t: "text", v: "." },
    ]);
    expect(parseInline("a snake_case_name and *it*")).toEqual([
      { t: "text", v: "a snake_case_name and " },
      { t: "i", c: [{ t: "text", v: "it" }] },
    ]);
  });
});

describe("GitHub list", () => {
  it("tells each issue's epic and how far its own tickets are", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/app/issues": [
        {
          id: 1,
          number: 7,
          title: "Child",
          state: "open",
          html_url: "u",
          updated_at: "",
          parent_issue_url: "https://api.github.com/repos/acme/app/issues/6",
        },
        {
          id: 2,
          number: 6,
          title: "Epic",
          state: "open",
          html_url: "u",
          updated_at: "",
          sub_issues_summary: { total: 3, completed: 1, percent_completed: 33 },
        },
      ],
    });
    const issues = await new GitHubIssues("acme/app", "t", fetch).search();
    expect(issues.map((i) => [i.key, i.parentKey, i.childCount])).toEqual([
      ["#7", "#6", undefined],
      ["#6", undefined, { total: 3, done: 1 }],
    ]);
  });
});
