import { describe, expect, it } from "vitest";
import { applyEvent, emptyOffice, type OfficeState } from "../src/shared/engine/office-state";
import type { OfficeEvent } from "../src/shared/protocol/schema";

let clock = Date.parse("2026-10-21T20:00:00Z");

function ev(type: OfficeEvent["type"], extra: Partial<OfficeEvent> = {}): OfficeEvent {
  clock += 1000;
  return {
    v: 1,
    type,
    source: "claude-code",
    sessionId: "s1",
    agentId: "s1",
    timestamp: new Date(clock).toISOString(),
    detail: {},
    ...extra,
  };
}

const run = (...events: OfficeEvent[]): OfficeState =>
  events.reduce((s, e) => applyEvent(s, e), emptyOffice());

describe("applyEvent", () => {
  it("creates an agent on first sight and tracks its status", () => {
    const s = run(
      ev("agent.started"),
      ev("agent.thinking"),
      ev("agent.tool", { detail: { tool: "bash", summary: "npm test" } }),
    );
    expect(s.agents.s1).toMatchObject({ status: "working", summary: "npm test", role: "dev" });
    expect(s.agents.s1!.history).toHaveLength(3);
  });

  it("uses default bubbles for thinking and waiting", () => {
    expect(run(ev("agent.thinking")).agents.s1!.summary).toBe("…");
    expect(run(ev("agent.waiting")).agents.s1!.summary).toBe("?");
    expect(
      run(ev("agent.tool", { detail: { summary: "x" } }), ev("agent.idle")).agents.s1!.summary,
    ).toBeUndefined();
  });

  it("links subagents to their parent and removes them on end", () => {
    const sub = { agentId: "s1/a", parentAgentId: "s1", agentName: "Explore", role: "research" };
    let s = run(ev("agent.started"), ev("subagent.started", sub));
    expect(s.agents["s1/a"]).toMatchObject({ parentId: "s1", name: "Explore", role: "research" });
    s = applyEvent(s, ev("subagent.ended", sub));
    expect(Object.keys(s.agents)).toEqual(["s1"]);
  });

  it("removes the whole subtree when a session ends", () => {
    const s = run(
      ev("agent.started"),
      ev("subagent.started", { agentId: "s1/a", parentAgentId: "s1" }),
      ev("subagent.started", { agentId: "s1/a/b", parentAgentId: "s1/a" }),
      ev("agent.started", { sessionId: "s2", agentId: "s2" }),
      ev("agent.ended"),
    );
    expect(Object.keys(s.agents)).toEqual(["s2"]);
  });

  it("ignores end events for unknown agents", () => {
    const s = emptyOffice();
    expect(applyEvent(s, ev("agent.ended", { agentId: "ghost" }))).toBe(s);
  });

  it("keeps the role chosen at creation and caps history", () => {
    let s = run(ev("agent.started", { role: "qa" }));
    for (let i = 0; i < 60; i++)
      s = applyEvent(s, ev("agent.tool", { role: "ops" }), { historyLimit: 10 });
    expect(s.agents.s1!.role).toBe("qa");
    expect(s.agents.s1!.history).toHaveLength(10);
  });
});
