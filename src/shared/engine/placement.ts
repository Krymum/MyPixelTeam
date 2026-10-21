import type { AgentRecord } from "./office-state";
import { isWalkable, SEATS, ZONES, type Facing, type ZoneId } from "./office-map";

export interface Spot {
  seatId?: string;
  x: number;
  y: number;
  facing: Facing;
  sit: boolean;
  offsetX: number;
}

const ROLE_ZONES: Record<string, ZoneId> = {
  dev: "dev",
  qa: "qa",
  ops: "ops",
  research: "research",
};

/** The room an agent works in: its role's room, or the meeting room while planning. */
export function workZone(agent: AgentRecord): ZoneId {
  if (agent.mode === "plan") return "meeting";
  return ROLE_ZONES[agent.role] ?? "dev";
}

/**
 * Where an agent should go now, or undefined to stay where it is.
 * Idle agents linger at their desk for `idleDelayMs` before heading for coffee; waiting
 * and failing agents stay put so you can spot them at their desk.
 */
export function desiredZone(
  agent: AgentRecord,
  now: number,
  idleDelayMs: number,
): ZoneId | undefined {
  switch (agent.status) {
    case "idle":
      return now - agent.lastEventAt >= idleDelayMs ? "kitchen" : undefined;
    case "waiting":
    case "error":
      return undefined;
    case "thinking":
    case "working":
      return workZone(agent);
  }
}

export const spotKey = (p: { x: number; y: number }) => `${p.x},${p.y}`;

function isSeatTile(x: number, y: number): boolean {
  return SEATS.some((s) => s.x === x && s.y === y);
}

/**
 * Picks a free seat in the zone, or any free walkable tile there when every seat is
 * taken. `taken` holds the tiles already claimed by other agents.
 */
export function chooseSpot(zone: ZoneId, taken: ReadonlySet<string>): Spot | undefined {
  const seat = SEATS.find((s) => s.zone === zone && !taken.has(spotKey(s)));
  if (seat) return { seatId: seat.id, ...seat };

  const z = ZONES[zone];
  for (let y = z.y + z.h - 1; y >= z.y; y--) {
    for (let x = z.x; x < z.x + z.w; x++) {
      if (isWalkable(x, y) && !taken.has(spotKey({ x, y })) && !isSeatTile(x, y)) {
        return { x, y, facing: "down", sit: false, offsetX: 0 };
      }
    }
  }
  return undefined;
}
