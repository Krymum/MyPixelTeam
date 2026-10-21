import { describe, expect, it } from "vitest";
import { ENTRANCE, SEATS, zoneAt } from "../src/shared/engine/office-map";
import { OfficeSimulation } from "../src/shared/engine/simulation";
import type { OfficeEvent } from "../src/shared/protocol/schema";

const T0 = Date.parse("2026-10-21T20:00:00Z");

function ev(type: OfficeEvent["type"], at: number, extra: Partial<OfficeEvent> = {}): OfficeEvent {
  return {
    v: 1,
    type,
    source: "claude-code",
    sessionId: "s1",
    agentId: "s1",
    timestamp: new Date(at).toISOString(),
    detail: {},
    ...extra,
  };
}

/** Runs the simulation in 100 ms steps until `until` (epoch ms). */
function run(sim: OfficeSimulation, from: number, until: number): number {
  for (let now = from; now < until; now += 100) sim.tick(0.1, now);
  return until;
}

const zoneOf = (sim: OfficeSimulation, id: string) => {
  const a = sim.actors.get(id)!;
  return zoneAt(a.tile.x, a.tile.y);
};

describe("OfficeSimulation", () => {
  it("spawns at the entrance and walks to a desk in its role's room", () => {
    const sim = new OfficeSimulation();
    sim.ingest(ev("agent.started", T0, { role: "qa" }));
    const actor = sim.actors.get("s1")!;
    expect(actor.tile).toEqual(ENTRANCE);

    sim.ingest(ev("agent.tool", T0, { detail: { tool: "bash", summary: "npm test" } }));
    run(sim, T0, T0 + 20_000);
    const seat = SEATS.find((s) => s.id === actor.spot?.seatId)!;
    expect(seat.zone).toBe("qa");
    expect(actor.tile).toEqual({ x: seat.x, y: seat.y });
    expect(sim.isSeated(actor)).toBe(true);
    expect(sim.activity(actor)).toBe("typing");
  });

  it("goes for coffee only after staying idle for a while, then returns to work", () => {
    const sim = new OfficeSimulation({ idleDelayMs: 5000 });
    sim.ingest(ev("agent.tool", T0));
    let now = run(sim, T0, T0 + 15_000);
    sim.ingest(ev("agent.idle", now));
    now = run(sim, now, now + 3000);
    expect(zoneOf(sim, "s1")).toBe("dev");

    now = run(sim, now, now + 25_000);
    expect(zoneOf(sim, "s1")).toBe("kitchen");
    expect(sim.activity(sim.actors.get("s1")!)).toBe("coffee");

    sim.ingest(ev("agent.thinking", now));
    run(sim, now, now + 25_000);
    expect(zoneOf(sim, "s1")).toBe("dev");
  });

  it("stays at its desk while waiting for a human", () => {
    const sim = new OfficeSimulation({ idleDelayMs: 1000 });
    sim.ingest(ev("agent.tool", T0, { role: "ops" }));
    const now = run(sim, T0, T0 + 20_000);
    sim.ingest(ev("agent.waiting", now, { detail: { message: "Allow rm?" } }));
    run(sim, now, now + 20_000);
    expect(zoneOf(sim, "s1")).toBe("ops");
    expect(sim.activity(sim.actors.get("s1")!)).toBe("waiting");
  });

  it("moves to the meeting room in plan mode", () => {
    const sim = new OfficeSimulation();
    sim.ingest(ev("agent.thinking", T0, { detail: { mode: "plan" } }));
    run(sim, T0, T0 + 25_000);
    expect(zoneOf(sim, "s1")).toBe("meeting");
  });

  it("spawns subagents next to their parent, then sends them to their own room", () => {
    const sim = new OfficeSimulation();
    sim.ingest(ev("agent.tool", T0));
    const now = run(sim, T0, T0 + 15_000);
    const parentTile = { ...sim.actors.get("s1")!.tile };
    sim.ingest(
      ev("subagent.started", now, { agentId: "s1/a", parentAgentId: "s1", role: "research" }),
    );
    expect(sim.actors.get("s1/a")!.tile).toEqual(parentTile);
    run(sim, now, now + 25_000);
    expect(zoneOf(sim, "s1/a")).toBe("research");
  });

  it("walks ended agents out through the entrance before removing them", () => {
    const sim = new OfficeSimulation();
    sim.ingest(ev("agent.tool", T0));
    let now = run(sim, T0, T0 + 15_000);
    sim.ingest(ev("agent.ended", now));
    expect(sim.state.agents.s1).toBeUndefined();
    const actor = sim.actors.get("s1")!;
    expect(actor.leaving).toBe(true);
    now = run(sim, now, now + 500);
    expect(sim.actors.has("s1")).toBe(true);
    run(sim, now, now + 30_000);
    expect(sim.actors.has("s1")).toBe(false);
  });

  it("assumes long-silent sessions are gone", () => {
    const sim = new OfficeSimulation({ staleMs: 60_000 });
    sim.ingest(ev("agent.tool", T0));
    run(sim, T0, T0 + 61_000);
    expect(sim.state.agents.s1).toBeUndefined();
  });

  it("never seats two agents on the same tile", () => {
    const sim = new OfficeSimulation();
    for (let i = 0; i < 9; i++) {
      sim.ingest(ev("agent.tool", T0, { sessionId: `s${i}`, agentId: `s${i}`, role: "dev" }));
    }
    run(sim, T0, T0 + 30_000);
    const tiles = [...sim.actors.values()].map((a) => `${a.tile.x},${a.tile.y}`);
    expect(new Set(tiles).size).toBe(tiles.length);
  });
});
