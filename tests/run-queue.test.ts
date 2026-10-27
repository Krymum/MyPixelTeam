import { describe, expect, it } from "vitest";
import { isUsageLimit, resetTime } from "../src/main/work/agent-protocol";
import { AgentRunner } from "../src/main/work/runner";
import type { Project } from "../src/shared/work/types";

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

/** A runner whose tracker answers only when told to fail: started runs stay "preparing". */
function runner(maxAgents: number, fail: ((err: Error) => void)[] = []) {
  const tracker = { issue: () => new Promise((_, reject) => fail.push(reject)) };
  return new AgentRunner({
    accounts: { tracker: () => tracker, git: () => ({ gitAuth: () => ({}) }) } as never,
    workspace: { get: () => project, view: () => ({ maxAgents }) } as never,
    worktreesDir: "/wt",
    claude: "claude",
    onChange: () => {},
    onSession: () => {},
  });
}

describe("run queue", () => {
  it("starts as many agents as allowed and queues the rest", async () => {
    const fail: ((err: Error) => void)[] = [];
    const office = runner(2, fail);
    const [a, b, c] = ["#1", "#2", "#3"].map((key) => office.start("p1", key));
    expect([a!.status, b!.status, c!.status]).toEqual(["preparing", "preparing", "queued"]);
    expect(c!.log.at(-1)).toMatch(/waiting: other agents are working/);

    // The desk frees once the stopped run has ended.
    office.cancel(a!.id);
    expect(c!.status).toBe("queued");
    fail[0]!(new Error("stopped"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(a!.status).toBe("cancelled");
    expect(c!.status).toBe("preparing");
  });

  it("takes a queued run out without starting it", () => {
    const office = runner(1);
    office.start("p1", "#1");
    const queued = office.start("p1", "#2");
    office.cancel(queued.id);
    expect(queued.status).toBe("cancelled");
    expect(queued.agentStarted).toBeUndefined();
  });

  it("runs on Sonnet unless the project or the ticket picks another model", () => {
    const office = runner(3);
    expect(office.start("p1", "#1").model).toBe("sonnet");
    expect(office.start("p1", "#2", { model: "opus" }).model).toBe("opus");
    expect(() => office.start("p1", "#3", { model: "opus; rm -rf /" })).toThrow(/Not a model/);
  });
});

describe("usage limit", () => {
  it("recognises the limit and reads when it resets", () => {
    const text = "You've hit your session limit · resets 8:40pm (Europe/Paris)";
    expect(isUsageLimit(text)).toBe(true);
    expect(isUsageLimit("Tests failed")).toBe(false);

    const afternoon = new Date(2026, 9, 27, 17, 58);
    expect(new Date(resetTime(text, afternoon)!)).toEqual(new Date(2026, 9, 27, 20, 40));
    // Already past today: tomorrow.
    const night = new Date(2026, 9, 27, 21, 0);
    expect(new Date(resetTime(text, night)!)).toEqual(new Date(2026, 9, 28, 20, 40));
    expect(new Date(resetTime("Weekly limit reached · resets Nov 3, 9am", afternoon)!)).toEqual(
      new Date(2026, 10, 3, 9, 0),
    );
    expect(resetTime("limit reached", afternoon)).toBeUndefined();
  });
});
