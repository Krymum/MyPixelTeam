import { z } from "zod";
import type { EventDetail, OfficeEvent } from "../protocol/schema";
import { summarizeTool } from "./tool-summary";

/**
 * Claude Code hook payload -> protocol events.
 * Reference: https://code.claude.com/docs/en/hooks
 *
 * Every hook shares session_id/cwd/permission_mode. Hooks fired inside a subagent also
 * carry agent_id + agent_type, which is how subagents become their own characters.
 */

const HookInput = z.looseObject({
  session_id: z.string().min(1),
  hook_event_name: z.string(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  prompt: z.string().optional(),
  message: z.string().optional(),
  notification_type: z.string().optional(),
  error: z.unknown().optional(),
  is_interrupt: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
});

type HookInput = z.infer<typeof HookInput>;

const MAIN_AGENT_NAME = "Claude";

/** Notifications that mean "a human needs to act". */
const WAITING_NOTIFICATIONS = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

function excerpt(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return excerpt(value.split("\n").find((l) => l.trim()));
}

export function normalizeClaudeCode(raw: unknown, now: Date): OfficeEvent[] {
  const parsed = HookInput.safeParse(raw);
  if (!parsed.success) return [];
  const hook = parsed.data;

  const inSubagent = !!hook.agent_id;
  const sessionId = hook.session_id;
  const agentId = inSubagent ? `${sessionId}/${hook.agent_id}` : sessionId;

  const make = (type: OfficeEvent["type"], detail: EventDetail = {}): OfficeEvent => ({
    v: 1,
    type,
    source: "claude-code",
    sessionId,
    agentId,
    parentAgentId: inSubagent ? sessionId : undefined,
    // Main agents started with --agent also report agent_type.
    agentName: hook.agent_type ?? (inSubagent ? "subagent" : MAIN_AGENT_NAME),
    cwd: hook.cwd,
    timestamp: now.toISOString(),
    detail: hook.permission_mode ? { ...detail, mode: hook.permission_mode } : detail,
  });

  return toEvents(hook, make);
}

function toEvents(
  hook: HookInput,
  make: (type: OfficeEvent["type"], detail?: EventDetail) => OfficeEvent,
): OfficeEvent[] {
  switch (hook.hook_event_name) {
    case "SessionStart":
      return [make("agent.started")];
    case "SessionEnd":
      return [make("agent.ended")];
    case "UserPromptSubmit":
      return [make("agent.thinking", { message: excerpt(hook.prompt) })];
    case "PreToolUse": {
      if (!hook.tool_name) return [];
      return [make("agent.tool", summarizeTool(hook.tool_name, hook.tool_input, hook.cwd))];
    }
    case "PostToolUse":
      // The tool is done; the model is reading its output. Also clears "waiting".
      return [make("agent.thinking")];
    case "PostToolUseFailure":
      if (hook.is_interrupt) return [make("agent.idle", { message: "Interrupted" })];
      return [make("agent.error", { message: firstLine(hook.error) ?? "Tool failed" })];
    case "PermissionRequest": {
      const what = hook.tool_name
        ? summarizeTool(hook.tool_name, hook.tool_input, hook.cwd)
        : undefined;
      return [
        make("agent.waiting", { message: what ? `Allow ${what.summary}?` : "Permission needed" }),
      ];
    }
    case "Notification":
      if (hook.notification_type === "idle_prompt") return [make("agent.idle")];
      if (hook.notification_type && WAITING_NOTIFICATIONS.has(hook.notification_type)) {
        return [make("agent.waiting", { message: excerpt(hook.message) })];
      }
      return [];
    case "Stop":
      return [make("agent.idle")];
    case "StopFailure":
      return [
        make("agent.error", {
          message: excerpt(hook.last_assistant_message) ?? firstLine(hook.error) ?? "API error",
        }),
      ];
    case "SubagentStart":
      return [make("subagent.started")];
    case "SubagentStop":
      return [make("subagent.ended")];
    default:
      return [];
  }
}
