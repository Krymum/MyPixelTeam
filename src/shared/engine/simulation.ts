import type { OfficeEvent } from "../protocol/schema";
import { findPath, type Point } from "./astar";
import { ENTRANCE, feetOf, isWalkable, type Facing, type ZoneId } from "./office-map";
import {
  applyEvent,
  emptyOffice,
  type AgentRecord,
  type OfficeState,
  type ReducerOptions,
} from "./office-state";
import { chooseSpot, desiredZone, spotKey, workZone, type Spot } from "./placement";

/**
 * Renderer-independent office simulation: turns protocol events into characters that
 * walk (A*) between seats, sit, take coffee breaks and leave through the front door.
 * Positions are feet coordinates in 1x pixels on the 16 px tile grid.
 */

export type Activity =
  "walking" | "typing" | "standing" | "thinking" | "waiting" | "error" | "coffee";

export interface Actor {
  id: string;
  /** Latest record; kept after the agent ended so it can walk out. */
  agent: AgentRecord;
  x: number;
  y: number;
  /** Last tile reached. */
  tile: Point;
  path: Point[];
  spot?: Spot & { zone: ZoneId };
  direction: Facing;
  /** Pixels walked, drives the walk cycle. */
  walked: number;
  moving: boolean;
  leaving: boolean;
}

export interface SimulationOptions {
  /** Walking speed in px per second. */
  speed?: number;
  /** How long an idle agent stays at its desk before going for coffee. */
  idleDelayMs?: number;
  /** Agents silent for this long are assumed gone (SessionEnd can be missed). */
  staleMs?: number;
  reducer?: ReducerOptions;
}

export class OfficeSimulation {
  state: OfficeState = emptyOffice();
  readonly actors = new Map<string, Actor>();
  private readonly speed: number;
  private readonly idleDelayMs: number;
  private readonly staleMs: number;

  constructor(private readonly options: SimulationOptions = {}) {
    this.speed = options.speed ?? 64;
    this.idleDelayMs = options.idleDelayMs ?? 15_000;
    this.staleMs = options.staleMs ?? 30 * 60_000;
  }

  ingest(event: OfficeEvent): void {
    this.apply(applyEvent(this.state, event, this.options.reducer));
  }

  /** Advances time: re-plans destinations, then moves everyone. */
  tick(dtSeconds: number, now: number): void {
    this.expireStale(now);
    this.plan(now);
    for (const actor of [...this.actors.values()]) {
      this.move(actor, dtSeconds);
      if (actor.leaving && !actor.moving) this.actors.delete(actor.id);
    }
  }

  activity(actor: Actor): Activity {
    if (actor.moving) return "walking";
    const { status } = actor.agent;
    if (status === "thinking" || status === "waiting" || status === "error") return status;
    if (status === "working") return this.isSeated(actor) ? "typing" : "standing";
    return actor.spot?.zone === "kitchen" ? "coffee" : "standing";
  }

  isSeated(actor: Actor): boolean {
    return !actor.moving && actor.path.length === 0 && !!actor.spot?.sit && !actor.leaving;
  }

  /** Swaps in a new reducer state, spawning newcomers and sending removed agents home. */
  private apply(next: OfficeState): void {
    const before = this.state;
    this.state = next;
    for (const agent of Object.values(next.agents)) {
      const actor = this.actors.get(agent.id);
      if (actor) {
        actor.agent = agent;
        actor.leaving = false;
        continue;
      }
      // Subagents pop up next to their parent, everyone else comes in the front door.
      const parent = agent.parentId ? this.actors.get(agent.parentId) : undefined;
      const tile = { ...(parent?.tile ?? ENTRANCE) };
      this.actors.set(agent.id, {
        id: agent.id,
        agent,
        ...feetOf(tile),
        tile,
        path: [],
        direction: "up",
        walked: 0,
        moving: false,
        leaving: false,
      });
    }
    for (const id of Object.keys(before.agents)) {
      if (next.agents[id]) continue;
      const actor = this.actors.get(id);
      if (!actor) continue;
      actor.leaving = true;
      actor.spot = undefined;
      actor.path = findPath(actor.tile, ENTRANCE, isWalkable) ?? [];
    }
  }

  private expireStale(now: number): void {
    let state = this.state;
    for (const agent of Object.values(state.agents)) {
      if (agent.parentId || now - agent.lastEventAt < this.staleMs) continue;
      state = applyEvent(state, {
        v: 1,
        type: "agent.ended",
        source: agent.source,
        sessionId: agent.sessionId,
        agentId: agent.id,
        timestamp: new Date(now).toISOString(),
        detail: { message: "No activity, assumed gone" },
      });
    }
    if (state !== this.state) this.apply(state);
  }

  private plan(now: number): void {
    const taken = new Set<string>();
    for (const actor of this.actors.values()) if (actor.spot) taken.add(spotKey(actor.spot));

    const agents = Object.values(this.state.agents).sort((a, b) => a.startedAt - b.startedAt);
    for (const agent of agents) {
      const actor = this.actors.get(agent.id)!;
      // Newcomers always head for their desk first.
      const zone =
        desiredZone(agent, now, this.idleDelayMs) ?? (actor.spot ? undefined : workZone(agent));
      if (!zone || actor.spot?.zone === zone) continue;

      if (actor.spot) taken.delete(spotKey(actor.spot));
      const spot = chooseSpot(zone, taken);
      if (!spot) continue;
      taken.add(spotKey(spot));
      actor.spot = { ...spot, zone };
      actor.path = findPath(actor.tile, spot, isWalkable) ?? [spot];
    }
  }

  private move(actor: Actor, dt: number): void {
    const next = actor.path[0];
    if (!next) {
      actor.moving = false;
      actor.walked = 0;
      if (actor.spot) actor.direction = actor.spot.facing;
      return;
    }
    const isLast = actor.path.length === 1;
    const target = feetOf({ ...next, offsetX: isLast ? actor.spot?.offsetX : 0 });
    const dx = target.x - actor.x;
    const dy = target.y - actor.y;
    const dist = Math.hypot(dx, dy);
    const len = Math.min(dist, this.speed * Math.max(0, dt));
    actor.moving = true;
    if (dist > 0) {
      actor.x += (dx / dist) * len;
      actor.y += (dy / dist) * len;
      actor.direction =
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    }
    actor.walked += len;
    if (len >= dist) {
      actor.tile = next;
      actor.path.shift();
      if (actor.path.length === 0) actor.moving = false;
    }
  }
}
