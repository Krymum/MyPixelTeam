// Pure helpers that add/remove the Agent Office hooks in a Claude Code settings object.
// Docs: https://code.claude.com/docs/en/hooks
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd",
];

/** Events whose matcher filters on tool name; "*" means every tool. */
const TOOL_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);

const OURS = /adapters[\\/]+claude-code\.mjs/;

export function settingsPath(scope, projectDir = process.cwd()) {
  return scope === "project"
    ? join(projectDir, ".claude", "settings.local.json")
    : join(homedir(), ".claude", "settings.json");
}

export function isOurs(handler) {
  return typeof handler?.command === "string" && OURS.test(handler.command);
}

/** Returns a copy of `settings` without any Agent Office hook, pruning empty groups. */
export function uninstall(settings) {
  const next = structuredClone(settings ?? {});
  if (!next.hooks || typeof next.hooks !== "object") return next;
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

/** Returns a copy of `settings` with the Agent Office hooks (re)installed. */
export function install(settings, command) {
  const next = uninstall(settings);
  next.hooks ??= {};
  for (const event of CLAUDE_EVENTS) {
    // async: never make Claude wait on us; the adapter also exits 0 on any failure.
    const group = { hooks: [{ type: "command", command, async: true, timeout: 10 }] };
    if (TOOL_EVENTS.has(event)) group.matcher = "*";
    next.hooks[event] = [...(next.hooks[event] ?? []), group];
  }
  return next;
}
