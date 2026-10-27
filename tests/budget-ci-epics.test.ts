import { describe, expect, it, vi } from "vitest";
import { ciReport, GitHubProvider, logTail } from "../src/main/integrations/git-providers";
import { ciInstruction, readStreamLine } from "../src/main/work/agent-protocol";
import { AgentRunner } from "../src/main/work/runner";
import type { Project, RunView } from "../src/shared/work/types";
import { fakeFetch } from "./work-helpers";

const project = {
  id: "p1",
  name: "App",
  tracker: { kind: "github" },
  repo: {
    provider: "github",
    fullName: "acme/app",
    defaultBranch: "main",
    cloneUrl: "https://github.com/acme/app.git",
    webUrl: "https://github.com/acme/app",
  },
  localPath: "/repo",
  agent: { permissionMode: "acceptEdits", openPullRequest: true },
} as Project;

const child = (key: string, statusCategory = "new") => ({
  key,
  summary: `Ticket ${key}`,
  statusCategory,
});

/** The epic #6 answers; its tickets never do, so their runs stay "preparing". */
function runner(fixCi = true) {
  const tracker = {
    issue: (key: string) =>
      key === "#6"
        ? Promise.resolve({ key, children: [child("#7"), child("#8"), child("#9", "done")] })
        : new Promise(() => {}),
  };
  return new AgentRunner({
    accounts: { tracker: () => tracker, git: () => ({ gitAuth: () => ({}) }) } as never,
    workspace: {
      get: () => project,
      view: () => ({ maxAgents: 3, runBudgetUsd: 3, fixCi }),
    } as never,
    worktreesDir: "/wt",
    claude: "claude",
    onChange: () => {},
    onSession: () => {},
  });
}

/** Ends a run as the runner would once its agent is done. */
const finish = (office: AgentRunner, run: RunView, status: RunView["status"]) =>
  (office as unknown as { finish(r: RunView, s: string): void }).finish(run, status);

describe("budget and progress", () => {
  it("counts each assistant message once and spots the budget stop", () => {
    const message = (id: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id,
          content: [{ type: "text", text: "Reading" }],
          usage: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 50 },
        },
      });
    expect(readStreamLine(message("m1")).usage).toEqual({ id: "m1", tokens: 1052 });
    const stop = readStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: ["Reached maximum budget ($3)"],
        total_cost_usd: 3.02,
      }),
    );
    expect(stop.result).toMatchObject({ isError: true, budgetReached: true, costUsd: 3.02 });
  });
});

describe("checks", () => {
  it("waits for every check, then reports the failures with their log", async () => {
    expect(ciReport([], []).state).toBe("none");
    expect(ciReport([{ state: "pending" }, { state: "failure" }], []).state).toBe("pending");
    expect(ciReport([{ state: "success" }], []).state).toBe("success");

    const { fetch } = fakeFetch({
      "GET /repos/acme/app/commits/abc/check-runs": {
        check_runs: [
          { id: 1, name: "lint", status: "completed", conclusion: "success" },
          {
            id: 2,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/acme/app/runs/2",
            app: { slug: "github-actions" },
          },
        ],
      },
      "GET /repos/acme/app/commits/abc/status": { statuses: [] },
    });
    // The log is plain text, not JSON.
    const withLog = (async (url: string | URL, init?: RequestInit) =>
      String(url).endsWith("/logs")
        ? new Response(
            "2026-10-27T10:00:00.0000000Z npm test\n2026-10-27T10:00:01.0000000Z FAIL login.test.ts",
          )
        : fetch(url, init)) as typeof fetch;
    const report = await new GitHubProvider("t", withLog).checks("acme/app", "abc");
    expect(report.state).toBe("failure");
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      name: "test",
      url: "https://github.com/acme/app/runs/2",
    });
    expect(report.failed[0]!.log).toContain("FAIL login.test.ts");
    expect(report.failed[0]!.log).not.toContain("2026-10-27T");

    const instruction = ciInstruction(report.failed);
    expect(instruction).toMatch(/checks of your pull request failed/);
    expect(instruction).toContain("FAIL login.test.ts");
  });

  it("keeps the end of long logs, without colours", () => {
    const long = Array.from({ length: 500 }, (_, i) => `\u001b[31mline ${i}\u001b[0m`).join("\n");
    const tail = logTail(long);
    expect(tail.split("\n")).toHaveLength(120);
    expect(tail).toMatch(/^line 380\n/);
    expect(tail.endsWith("line 499")).toBe(true);
  });

  it("puts the agent back on failing checks, twice at most", () => {
    const office = runner();
    const again = vi.spyOn(office, "continueRun").mockReturnValue({} as RunView);
    const fix = (run: Partial<RunView>) =>
      (office as unknown as { fixCi(r: RunView, f: unknown[]): void }).fixCi(
        { log: [], ...run } as RunView,
        [{ name: "test" }],
      );
    fix({ id: "r1" });
    fix({ id: "r2", ciFixes: 1 });
    fix({ id: "r3", ciFixes: 2 });
    expect(again.mock.calls.map((c) => [c[0], c[3]])).toEqual([
      ["r1", { ciFixes: 1 }],
      ["r2", { ciFixes: 2 }],
    ]);

    const off = runner(false);
    const never = vi.spyOn(off, "continueRun");
    (off as unknown as { fixCi(r: RunView, f: unknown[]): void }).fixCi(
      { id: "r1", log: [] } as unknown as RunView,
      [],
    );
    expect(never).not.toHaveBeenCalled();
  });
});

describe("epics", () => {
  it("does the open tickets one after another, each from the branch before", async () => {
    const office = runner();
    const start = vi.spyOn(office, "start");
    const first = await office.startEpic("p1", "#6");
    expect(first).toMatchObject({ issueKey: "#7", epicKey: "#6", status: "preparing" });
    expect(office.list().map((r) => r.issueKey)).toEqual(["#7"]);
    await expect(office.startEpic("p1", "#6")).rejects.toThrow(/already working through #6/);

    Object.assign(first, {
      branch: "agent/issue-7-x",
      pullRequestUrl: "https://github.com/acme/app/pull/20",
      result: "Added the public layout",
    });
    finish(office, first, "done");
    expect(start).toHaveBeenLastCalledWith("p1", "#8", { from: "agent/issue-7-x" }, [
      { key: "#7", summary: "Ticket #7", result: "Added the public layout" },
    ]);
    const second = office.list()[0]!;
    expect(second).toMatchObject({ issueKey: "#8", epicKey: "#6" });

    // The done ticket #9 is skipped: the epic ends after #8.
    finish(office, second, "done");
    expect(office.list()).toHaveLength(2);
  });

  it("stops at a failed ticket and says which ones wait", async () => {
    const office = runner();
    const first = await office.startEpic("p1", "#6");
    finish(office, first, "failed");
    expect(first.log.at(-1)).toMatch(/#6 stopped here: #8 wait for you/);
    expect(office.list()).toHaveLength(1);
  });

  it("waits for a ticket that ran out of budget", async () => {
    const office = runner();
    const first = await office.startEpic("p1", "#6");
    first.stoppedOnBudget = true;
    finish(office, first, "failed");
    expect(first.log.at(-1)).not.toMatch(/stopped here/);
    // Still running through #6: starting it again is refused until the person decides.
    first.status = "running";
    await expect(office.startEpic("p1", "#6")).rejects.toThrow(/already working/);
  });
});
