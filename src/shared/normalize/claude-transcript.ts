import { z } from "zod";
import type { EventDetail, OfficeEvent } from "../protocol/schema";
import { summarizeTool } from "./tool-summary";

/**
 * Claude Code transcript line -> protocol events.
 *
 * Claude Code appends every session to ~/.claude/projects/<project>/<session>.jsonl, and
 * each subagent to <session>/subagents/agent-<id>.jsonl. Reading those files shows every
 * agent on the machine without installing hooks. The format is internal to Claude Code, so
 * anything unexpected is ignored rather than rejected. Unlike hooks, transcripts do not
 * show permission prompts or session ends (the office expires idle agents on its own).
 */

/** What the watcher knows about the file a line comes from. Updated as lines are read. */
export interface TranscriptContext {
  sessionId: string;
  agentId: string;
  /** Set for subagent files. */
  parentAgentId?: string;
  agentName: string;
  cwd?: string;
  mode?: string;
}

const Block = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  text: z.string().optional(),
});

const Line = z.looseObject({
  type: z.string(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  permissionMode: z.string().optional(),
  isMeta: z.boolean().optional(),
  isApiErrorMessage: z.boolean().optional(),
  subtype: z.string().optional(),
  origin: z.looseObject({ kind: z.string().optional() }).optional(),
  message: z
    .looseObject({
      content: z.union([z.string(), z.array(Block)]).optional(),
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
});

type Line = z.infer<typeof Line>;

/** Marks the end of a turn in the main session. */
const TURN_END_SUBTYPES = new Set(["turn_duration", "stop_hook_summary"]);

/** Subagents report back with this tool, which ends their run. */
const HANDBACK_TOOL = "SubagentHandback";

function excerpt(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat || undefined;
}

type Content = NonNullable<Line["message"]>["content"];

function textOf(content: Content): string | undefined {
  if (typeof content === "string") return content;
  return content?.find((b) => b.type === "text")?.text;
}

export function normalizeTranscriptLine(
  raw: unknown,
  ctx: TranscriptContext,
  now: Date,
): OfficeEvent[] {
  const parsed = Line.safeParse(raw);
  if (!parsed.success) return [];
  const line = parsed.data;

  // "permission-mode" lines and user prompts both carry the current mode (e.g. "plan").
  if (line.cwd) ctx.cwd = line.cwd;
  if (line.permissionMode) ctx.mode = line.permissionMode;

  const stamp = line.timestamp ? Date.parse(line.timestamp) : NaN;
  const time = Number.isNaN(stamp) ? now : new Date(stamp);
  const make = (type: OfficeEvent["type"], detail: EventDetail = {}): OfficeEvent => ({
    v: 1,
    type,
    source: "claude-code",
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    parentAgentId: ctx.parentAgentId,
    agentName: ctx.agentName,
    cwd: ctx.cwd,
    timestamp: time.toISOString(),
    detail: ctx.mode ? { ...detail, mode: ctx.mode } : detail,
  });

  switch (line.type) {
    case "user":
      return userEvents(line, make);
    case "assistant":
      return assistantEvents(line, ctx, make);
    case "system":
      if (!ctx.parentAgentId && line.subtype && TURN_END_SUBTYPES.has(line.subtype))
        return [make("agent.idle")];
      return [];
    default:
      return [];
  }
}

type Make = (type: OfficeEvent["type"], detail?: EventDetail) => OfficeEvent;

function userEvents(line: Line, make: Make): OfficeEvent[] {
  if (line.isMeta) return [];
  const content = line.message?.content;
  if (Array.isArray(content) && content.some((b) => b.type === "tool_result"))
    // A tool finished; the model is reading its output.
    return [make("agent.thinking")];
  const text = textOf(content);
  if (text?.startsWith("[Request interrupted by user"))
    return [make("agent.idle", { message: "Interrupted" })];
  // Only show what a person typed: command tags and task notifications are noise.
  const typed = line.origin?.kind === "human" && text && !text.startsWith("<");
  return [make("agent.thinking", typed ? { message: excerpt(text) } : {})];
}

function assistantEvents(line: Line, ctx: TranscriptContext, make: Make): OfficeEvent[] {
  const content = Array.isArray(line.message?.content) ? line.message.content : [];
  if (line.isApiErrorMessage)
    return [make("agent.error", { message: excerpt(textOf(content)) ?? "API error" })];

  const tool = content.findLast((b) => b.type === "tool_use" && b.name);
  if (tool?.name === HANDBACK_TOOL && ctx.parentAgentId) return [make("subagent.ended")];
  if (tool?.name) return [make("agent.tool", summarizeTool(tool.name, tool.input, ctx.cwd))];

  if (line.message?.stop_reason === "end_turn")
    return [make(ctx.parentAgentId ? "subagent.ended" : "agent.idle")];
  return [];
}
