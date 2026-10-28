import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNotice, waitingNotice } from "../src/main/work/notices";
import { loadHistory } from "../src/main/work/runner";
import type { OfficeEvent } from "../src/shared/protocol/schema";
import type { RunView } from "../src/shared/work/types";

const run = (patch: Partial<RunView>): RunView => ({
  id: "r1",
  projectId: "p1",
  issueKey: "PROJ-7",
  issueSummary: "Add dark mode",
  sessionId: "s1",
  status: "done",
  branch: "agent/PROJ-7-add-dark-mode",
  worktree: "/wt",
  startedAt: 1,
  log: [],
  ...patch,
});

describe("runNotice", () => {
  it("announces a pull request, a run without one, and a failure", () => {
    expect(runNotice(run({ pullRequestUrl: "https://x/pr/1" }))).toEqual({
      title: "PROJ-7: pull request ready",
      body: "PROJ-7 · Add dark mode",
    });
    expect(runNotice(run({ result: "Nothing to change" }))?.body).toBe(
      "PROJ-7 · Add dark mode Nothing to change",
    );
    expect(runNotice(run({ status: "failed", error: "git push failed" }))).toEqual({
      title: "PROJ-7: the agent failed",
      body: "git push failed",
    });
  });

  it("speaks French on a French system", () => {
    expect(runNotice(run({ pullRequestUrl: "https://x/pr/1" }), "fr")?.title).toBe(
      "PROJ-7 : pull request prête",
    );
    expect(runNotice(run({ status: "failed" }), "fr")?.title).toBe("PROJ-7 : l’agent a échoué");
  });

  it("stays quiet for runs still going or stopped by hand", () => {
    expect(runNotice(run({ status: "running" }))).toBeUndefined();
    expect(runNotice(run({ status: "cancelled" }))).toBeUndefined();
  });
});

describe("waitingNotice", () => {
  const event = (patch: Partial<OfficeEvent>): OfficeEvent => ({
    v: 1,
    type: "agent.waiting",
    source: "claude-code",
    sessionId: "s",
    agentId: "s",
    agentName: "PROJ-7",
    timestamp: new Date().toISOString(),
    detail: { message: "Allow npm test?" },
    ...patch,
  });

  it("only speaks up for agents waiting on you", () => {
    expect(waitingNotice(event({}))).toEqual({
      title: "PROJ-7 is waiting for you",
      body: "Allow npm test?",
    });
    expect(waitingNotice(event({ type: "agent.tool" }))).toBeUndefined();
  });
});

describe("loadHistory", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("restores runs and marks those cut short as failed", () => {
    dir = mkdtempSync(join(tmpdir(), "office-runs-"));
    const path = join(dir, "runs.json");
    writeFileSync(path, JSON.stringify([run({}), run({ id: "r2", status: "running" })]));
    const [done, cut] = loadHistory(path);
    expect(done?.status).toBe("done");
    expect(cut).toMatchObject({ status: "failed", error: "Interrupted: the app was closed" });
    expect(cut?.endedAt).toBeGreaterThan(0);
  });

  it("starts empty without a readable file", () => {
    dir = mkdtempSync(join(tmpdir(), "office-runs-"));
    expect(loadHistory(undefined)).toEqual([]);
    expect(loadHistory(join(dir, "missing.json"))).toEqual([]);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(loadHistory(join(dir, "bad.json"))).toEqual([]);
  });
});
