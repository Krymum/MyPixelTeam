import { describe, expect, it } from "vitest";
import { createDemoScenario } from "../src/shared/demo/scenario";
import { applyEvent, emptyOffice } from "../src/shared/engine/office-state";
import { OfficeEvent } from "../src/shared/protocol/schema";

function simulate(seconds: number, seed = 7) {
  const start = Date.parse("2026-10-21T20:00:00Z");
  const scenario = createDemoScenario(seed, start);
  const events = [];
  for (let t = 0; t <= seconds * 1000; t += 200) events.push(...scenario.step(start + t));
  return events;
}

describe("demo scenario", () => {
  it("only emits schema-valid events", () => {
    for (const e of simulate(120)) expect(OfficeEvent.safeParse(e).success).toBe(true);
  });

  it("brings in six agents from every source", () => {
    const events = simulate(30);
    const started = events.filter((e) => e.type === "agent.started");
    expect(started).toHaveLength(6);
    expect(new Set(started.map((e) => e.source))).toEqual(
      new Set(["claude-code", "codex", "gemini", "custom"]),
    );
  });

  it("spawns subagents that end and keeps the office consistent", () => {
    const events = simulate(300);
    expect(events.some((e) => e.type === "subagent.started")).toBe(true);
    expect(events.some((e) => e.type === "subagent.ended")).toBe(true);
    const office = events.reduce((s, e) => applyEvent(s, e), emptyOffice());
    const ids = Object.keys(office.agents);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(ids.length).toBeLessThanOrEqual(7);
  });

  it("is deterministic for a given seed", () => {
    expect(simulate(60, 3)).toEqual(simulate(60, 3));
  });
});
