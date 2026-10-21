import type { OfficeEvent, Source } from "../protocol/schema";

export type AgentStatus = "idle" | "thinking" | "working" | "waiting" | "error";

export interface AgentRecord {
  id: string;
  sessionId: string;
  source: Source;
  name: string;
  role: string;
  parentId?: string;
  cwd?: string;
  status: AgentStatus;
  /** Last mode reported by the CLI, e.g. "plan". Kept until a new one arrives. */
  mode?: string;
  /** Short text for the speech bubble. */
  summary?: string;
  /** Epoch ms. */
  startedAt: number;
  lastEventAt: number;
  /** Most recent events, newest last. */
  history: OfficeEvent[];
}

export interface OfficeState {
  agents: Record<string, AgentRecord>;
}

export interface ReducerOptions {
  /** Decides the role of a newly seen agent. */
  resolveRole?: (event: OfficeEvent) => string;
  historyLimit?: number;
}

export const DEFAULT_ROLE = "dev";

export const emptyOffice = (): OfficeState => ({ agents: {} });

const STATUS_BY_TYPE: Partial<Record<OfficeEvent["type"], AgentStatus>> = {
  "agent.started": "idle",
  "agent.thinking": "thinking",
  "agent.tool": "working",
  "agent.waiting": "waiting",
  "agent.idle": "idle",
  "agent.error": "error",
  "subagent.started": "working",
};

const DEFAULT_SUMMARY: Partial<Record<AgentStatus, string>> = {
  thinking: "…",
  waiting: "?",
};

function defaultName(event: OfficeEvent): string {
  if (event.agentName) return event.agentName;
  return event.parentAgentId ? "subagent" : event.source;
}

/** Removes an agent and, recursively, every subagent it spawned. */
function removeTree(agents: Record<string, AgentRecord>, id: string): Record<string, AgentRecord> {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of Object.values(agents)) {
      if (a.parentId && doomed.has(a.parentId) && !doomed.has(a.id)) {
        doomed.add(a.id);
        grew = true;
      }
    }
  }
  return Object.fromEntries(Object.entries(agents).filter(([key]) => !doomed.has(key)));
}

/** Pure reducer: applies one protocol event to the office. */
export function applyEvent(
  state: OfficeState,
  event: OfficeEvent,
  options: ReducerOptions = {},
): OfficeState {
  const { resolveRole = (e) => e.role ?? DEFAULT_ROLE, historyLimit = 50 } = options;

  if (event.type === "agent.ended" || event.type === "subagent.ended") {
    if (!state.agents[event.agentId]) return state;
    return { agents: removeTree(state.agents, event.agentId) };
  }

  const ts = Date.parse(event.timestamp);
  const existing = state.agents[event.agentId];
  const status = STATUS_BY_TYPE[event.type] ?? existing?.status ?? "idle";
  const base: AgentRecord = existing ?? {
    id: event.agentId,
    sessionId: event.sessionId,
    source: event.source,
    name: defaultName(event),
    role: resolveRole(event),
    status,
    startedAt: ts,
    lastEventAt: ts,
    history: [],
  };

  const next: AgentRecord = {
    ...base,
    parentId: base.parentId ?? event.parentAgentId,
    cwd: event.cwd ?? base.cwd,
    name: event.agentName ?? base.name,
    status,
    mode: event.detail.mode ?? base.mode,
    summary: event.detail.summary ?? DEFAULT_SUMMARY[status],
    lastEventAt: Math.max(base.lastEventAt, ts),
    history: [...base.history, event].slice(-historyLimit),
  };

  return { agents: { ...state.agents, [next.id]: next } };
}
