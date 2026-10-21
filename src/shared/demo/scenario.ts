import type { EventDetail, OfficeEvent, Source } from "../protocol/schema";

/**
 * Deterministic fake office used by `npm run demo`. Pure: call `step(now)` on a timer and
 * feed the returned events through the normal pipeline.
 */

type Phase = "start" | "think" | "tool" | "wait" | "error" | "idle" | "end";

interface Actor {
  agentId: string;
  sessionId: string;
  source: Source;
  agentName: string;
  /** Omitted for most agents so office.config.json decides, like for real CLIs. */
  role?: string;
  /** Alternates between plan mode (meeting room) and normal work. */
  planner?: boolean;
  mode?: string;
  cwd: string;
  parentAgentId?: string;
  /** Main agents that occasionally spawn subagents. */
  spawns?: { agentName: string }[];
  phase: Phase;
  toolsLeft: number;
  nextAt: number;
}

type ToolSample = Required<Pick<EventDetail, "tool" | "summary">>;

const TOOLS: ToolSample[] = [
  { tool: "read", summary: "read src/app.ts" },
  { tool: "read", summary: "read package.json" },
  { tool: "edit", summary: "edit src/api/routes.ts" },
  { tool: "edit", summary: "edit src/components/Cart.tsx" },
  { tool: "bash", summary: "npm test" },
  { tool: "bash", summary: "git status" },
  { tool: "bash", summary: "docker compose up -d" },
  { tool: "search", summary: 'grep "TODO"' },
  { tool: "search", summary: "glob **/*.spec.ts" },
  { tool: "web", summary: "fetch docs.python.org" },
];

const WAIT_MESSAGES = ["Allow Bash: rm -rf dist?", "Approve edit to .env?", "Which DB to use?"];
const ERROR_MESSAGES = ["Exit code 1: 3 tests failed", "ENOENT: config.yml", "Rate limited"];

/** Small seeded PRNG (mulberry32) so demo runs and tests are reproducible. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ActorSeed = Pick<Actor, "source" | "agentName" | "role" | "cwd" | "spawns" | "planner">;

const CAST: ActorSeed[] = [
  {
    source: "claude-code",
    agentName: "Claude",
    planner: true,
    cwd: "~/projects/shop",
    spawns: [{ agentName: "code-reviewer" }, { agentName: "Explore" }],
  },
  { source: "codex", agentName: "Codex", cwd: "~/projects/api" },
  { source: "gemini", agentName: "Gemini", role: "research", cwd: "~/projects/docs" },
  { source: "claude-code", agentName: "deploy-bot", cwd: "~/infra" },
  { source: "codex", agentName: "test-runner", cwd: "~/projects/api" },
  { source: "custom", agentName: "my-agent", role: "ops", cwd: "~/scripts" },
];

export interface DemoScenario {
  step(now: number): OfficeEvent[];
}

export function createDemoScenario(seed = 42, startAt = Date.now()): DemoScenario {
  const rng = createRng(seed);
  const between = (min: number, max: number) => min + rng() * (max - min);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  let counter = 0;

  const actors: Actor[] = CAST.map((seedActor, i) => {
    const sessionId = `demo-${i + 1}`;
    return {
      ...seedActor,
      sessionId,
      agentId: sessionId,
      phase: "start",
      toolsLeft: 0,
      // Stagger arrivals so agents walk in one by one.
      nextAt: startAt + i * 1500,
    };
  });

  const emit = (
    actor: Actor,
    type: OfficeEvent["type"],
    now: number,
    detail: EventDetail = {},
  ) => ({
    v: 1 as const,
    type,
    source: actor.source,
    sessionId: actor.sessionId,
    agentId: actor.agentId,
    parentAgentId: actor.parentAgentId,
    agentName: actor.agentName,
    role: actor.role,
    cwd: actor.cwd,
    timestamp: new Date(now).toISOString(),
    detail: actor.mode ? { ...detail, mode: actor.mode } : detail,
  });

  const maybeSpawn = (parent: Actor, now: number): OfficeEvent[] => {
    if (!parent.spawns || rng() > 0.3) return [];
    if (actors.some((a) => a.parentAgentId === parent.agentId)) return [];
    const spec = pick(parent.spawns);
    const child: Actor = {
      ...spec,
      source: parent.source,
      cwd: parent.cwd,
      sessionId: parent.sessionId,
      agentId: `${parent.sessionId}/sub-${++counter}`,
      parentAgentId: parent.agentId,
      phase: "tool",
      toolsLeft: 2 + Math.floor(rng() * 4),
      nextAt: now + between(800, 1500),
    };
    actors.push(child);
    return [
      emit(parent, "agent.tool", now, { tool: "agent", summary: `spawn ${spec.agentName}` }),
      emit(child, "subagent.started", now),
    ];
  };

  /** Emits the events for the actor's current phase and schedules the next one. */
  const advance = (actor: Actor, now: number): OfficeEvent[] => {
    const isSub = actor.parentAgentId !== undefined;
    switch (actor.phase) {
      case "start":
        actor.phase = "think";
        actor.nextAt = now + between(2000, 4000);
        return [emit(actor, "agent.started", now)];
      case "think":
        if (actor.planner) actor.mode = rng() < 0.4 ? "plan" : "default";
        actor.phase = "tool";
        actor.toolsLeft = 2 + Math.floor(rng() * 4);
        actor.nextAt = now + between(1500, 3000);
        return [emit(actor, "agent.thinking", now, { summary: "thinking…" })];
      case "tool": {
        if (actor.toolsLeft > 0) {
          actor.toolsLeft--;
          actor.nextAt = now + between(1500, 4000);
          const spawned = isSub ? [] : maybeSpawn(actor, now);
          return spawned.length ? spawned : [emit(actor, "agent.tool", now, pick(TOOLS))];
        }
        const roll = rng();
        actor.phase = isSub ? "end" : roll < 0.15 ? "wait" : roll < 0.25 ? "error" : "idle";
        return advance(actor, now);
      }
      case "wait":
        actor.phase = "tool";
        actor.toolsLeft = 1 + Math.floor(rng() * 2);
        actor.nextAt = now + between(4000, 7000);
        return [emit(actor, "agent.waiting", now, { message: pick(WAIT_MESSAGES) })];
      case "error":
        actor.phase = "think";
        actor.nextAt = now + between(2500, 4000);
        return [emit(actor, "agent.error", now, { message: pick(ERROR_MESSAGES) })];
      case "idle":
        actor.phase = "think";
        actor.nextAt = now + between(18000, 32000);
        return [emit(actor, "agent.idle", now)];
      case "end":
        actors.splice(actors.indexOf(actor), 1);
        return [emit(actor, "subagent.ended", now)];
    }
  };

  return {
    step(now) {
      const due = actors.filter((a) => a.nextAt <= now);
      return due.flatMap((actor) => advance(actor, now));
    },
  };
}
