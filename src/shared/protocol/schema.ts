import { z } from "zod";

/** Current protocol version. Bump on breaking changes to OfficeEvent. */
export const PROTOCOL_VERSION = 1;

export const EVENT_TYPES = [
  "agent.started",
  "agent.ended",
  "agent.thinking",
  "agent.tool",
  "agent.waiting",
  "agent.idle",
  "agent.error",
  "subagent.started",
  "subagent.ended",
] as const;

export const SOURCES = ["claude-code", "codex", "gemini", "custom"] as const;

export const TOOL_KINDS = ["edit", "bash", "read", "search", "web", "agent", "other"] as const;

export const EventType = z.enum(EVENT_TYPES);
export const Source = z.enum(SOURCES);
export const ToolKind = z.enum(TOOL_KINDS);

export const EventDetail = z.object({
  /** Coarse category of the tool being used (agent.tool only). */
  tool: ToolKind.optional(),
  /** A few words shown in the speech bubble, e.g. "edit src/app.ts". */
  summary: z.string().max(80).optional(),
  /** Longer free text: waiting reason, error message, prompt excerpt. */
  message: z.string().max(2000).optional(),
  /** Agent mode reported by the CLI, e.g. "plan". */
  mode: z.string().max(40).optional(),
});

export const OfficeEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: EventType,
  source: Source,
  sessionId: z.string().min(1).max(200),
  /** Stable id of the character. Equals sessionId for a session's main agent. */
  agentId: z.string().min(1).max(200),
  /** Set on subagents: the agentId of the agent that spawned them. */
  parentAgentId: z.string().min(1).max(200).optional(),
  /** Display name, e.g. "Explore" or "code-reviewer". */
  agentName: z.string().max(100).optional(),
  /** Explicit role override. When absent, office.config.json decides. */
  role: z.string().max(40).optional(),
  cwd: z.string().max(1000).optional(),
  timestamp: z.iso.datetime({ offset: true }),
  detail: EventDetail.default({}),
});

export type EventType = z.infer<typeof EventType>;
export type Source = z.infer<typeof Source>;
export type ToolKind = z.infer<typeof ToolKind>;
export type EventDetail = z.infer<typeof EventDetail>;
export type OfficeEvent = z.infer<typeof OfficeEvent>;

/**
 * Lenient variant accepted on POST /events so hand-written producers (curl, scripts)
 * can omit `v`, `timestamp` and `agentId`.
 */
export const OfficeEventInput = OfficeEvent.extend({
  v: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  timestamp: z.iso
    .datetime({ offset: true })
    .optional()
    .transform((t) => t ?? new Date().toISOString()),
  agentId: z.string().min(1).max(200).optional(),
}).transform((e): OfficeEvent => ({ ...e, agentId: e.agentId ?? e.sessionId }));
