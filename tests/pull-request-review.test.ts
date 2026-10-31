import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../src/main/work/runner";
import type { RunView } from "../src/shared/work/types";

const dir = mkdtempSync(join(tmpdir(), "office-review-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (patch: Partial<RunView>): RunView => ({
  id: "r1",
  projectId: "p1",
  issueKey: "#7",
  issueSummary: "Add dark mode",
  sessionId: "s1",
  status: "done",
  branch: "agent/7",
  worktree: "/wt",
  startedAt: 1,
  endedAt: Date.now(),
  pullRequestUrl: "https://github.com/acme/app/pull/8",
  log: [],
  ...patch,
});

function office(runs: RunView[], state: "open" | "merged") {
  const historyPath = join(dir, `${Math.random()}.json`);
  writeFileSync(historyPath, JSON.stringify(runs));
  const host = {
    pullRequestView: vi.fn(async (_: string, url: string) => ({
      url,
      state,
      conflicts: false,
      files: [],
    })),
    merge: vi.fn(async () => {}),
    closePullRequest: vi.fn(async () => {}),
  };
  const tracker = { advance: vi.fn(async () => ({ moved: "Done" })) };
  const runner = new AgentRunner({
    accounts: { git: () => host, tracker: () => tracker } as never,
    workspace: {
      get: () => ({ id: "p1", repo: { provider: "github", fullName: "acme/app" } }),
      view: () => ({ maxAgents: 2, runBudgetUsd: 0, fixCi: true }),
    } as never,
    worktreesDir: "/wt",
    claude: "claude",
    historyPath,
    onChange: () => {},
    onSession: () => {},
  });
  return { runner, host, tracker };
}

describe("pull request review", () => {
  it("merges the pull request, then moves the ticket to done", async () => {
    const { runner, host, tracker } = office([run({})], "open");
    await runner.mergePullRequest("r1");
    expect(host.merge).toHaveBeenCalledWith("acme/app", "https://github.com/acme/app/pull/8");
    expect(tracker.advance).toHaveBeenCalledWith("#7", "done");
    expect(runner.list()[0]!.prState).toBe("merged");
  });

  it("refuses while an agent is still on the ticket", async () => {
    const { runner } = office([run({})], "open");
    runner.list()[0]!.status = "running";
    await expect(runner.closePullRequest("r1")).rejects.toThrow("still on #7");
  });

  it("learns which pull requests were merged elsewhere, ticket by ticket", async () => {
    const { runner, host } = office(
      [
        // Oldest first, as the history is saved.
        run({ id: "gone", issueKey: "#9", endedAt: 1, pullRequestUrl: "https://x/pull/1" }),
        run({ id: "old" }),
        run({ id: "new" }),
      ],
      "merged",
    );
    await runner.refreshPullRequests();
    // The latest run of #7 only; #9 ended too long ago to matter.
    expect(host.pullRequestView).toHaveBeenCalledTimes(1);
    expect(runner.list().map((r) => [r.id, r.prState])).toEqual([
      ["new", "merged"],
      ["old", "merged"],
      ["gone", undefined],
    ]);
  });
});
