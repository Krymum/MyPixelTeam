import type { ToolKind } from "../protocol/schema";

/**
 * Turns a tool call from any CLI into a coarse kind and a few words for the speech
 * bubble ("edit src/app.ts", "npm test"). Tool names cover Claude Code, Codex and Gemini.
 */

export interface ToolSummary {
  tool: ToolKind;
  summary: string;
}

const MAX = 48;

type Input = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function clip(text: string, max = MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Shows a path relative to the project when possible, with forward slashes. */
export function displayPath(path: string, cwd?: string): string {
  const p = path.replace(/\\/g, "/");
  const root = cwd?.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return p.slice(root.length + 1);
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Pulls the first file path out of an apply_patch body ("*** Update File: x"). */
function patchTarget(patch: string): string | undefined {
  return /\*\*\* (?:Add|Update|Delete) File: (.+)/.exec(patch)?.[1]?.trim();
}

function commandText(input: Input): string | undefined {
  const cmd = input.command ?? input.cmd;
  if (Array.isArray(cmd)) {
    // Codex runs ["bash", "-lc", "npm test"]: show the script, not the shell.
    const script = cmd.at(-1);
    return typeof script === "string" ? script : cmd.join(" ");
  }
  return str(cmd);
}

export function summarizeTool(name: string, rawInput: unknown, cwd?: string): ToolSummary {
  const input: Input = rawInput && typeof rawInput === "object" ? (rawInput as Input) : {};
  const path = str(input.file_path ?? input.path ?? input.absolute_path ?? input.notebook_path);
  const shown = path ? displayPath(path, cwd) : undefined;

  switch (name) {
    case "Read":
    case "read_file":
    case "read_many_files":
    case "NotebookRead":
      return { tool: "read", summary: clip(`read ${shown ?? "file"}`) };
    case "LS":
    case "list_directory":
      return { tool: "read", summary: clip(`ls ${shown ?? "."}`) };
    case "Write":
    case "write_file":
      return { tool: "edit", summary: clip(`write ${shown ?? "file"}`) };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
    case "replace":
      return { tool: "edit", summary: clip(`edit ${shown ?? "file"}`) };
    case "apply_patch": {
      const target = patchTarget(str(input.input ?? input.patch) ?? "");
      return {
        tool: "edit",
        summary: clip(`patch ${target ? displayPath(target, cwd) : "files"}`),
      };
    }
    case "Bash":
    case "PowerShell":
    case "shell":
    case "exec_command":
    case "local_shell":
    case "run_shell_command": {
      // Short commands speak for themselves ("npm test"); for scripts, the CLI's own
      // description ("Run the migration") reads better than a clipped first line.
      const command = commandText(input);
      const description = str(input.description);
      const isShort = !!command && command.length <= 40 && !command.includes("\n");
      return {
        tool: "bash",
        summary: clip((isShort ? command : description) ?? command ?? "run command"),
      };
    }
    case "Grep":
    case "search_file_content":
    case "grep":
      return { tool: "search", summary: clip(`grep "${str(input.pattern) ?? ""}"`) };
    case "Glob":
    case "glob":
      return { tool: "search", summary: clip(`glob ${str(input.pattern) ?? ""}`) };
    case "WebFetch":
    case "web_fetch": {
      const url = str(input.url) ?? str(input.prompt)?.match(/https?:\/\/\S+/)?.[0];
      return { tool: "web", summary: clip(`fetch ${url ? host(url) : "page"}`) };
    }
    case "WebSearch":
    case "web_search":
    case "google_web_search":
      return { tool: "web", summary: clip(`search "${str(input.query) ?? ""}"`) };
    case "Agent":
    case "Task":
      return { tool: "agent", summary: clip(`spawn ${str(input.subagent_type) ?? "agent"}`) };
    case "TodoWrite":
    case "update_plan":
    case "write_todos":
      return { tool: "other", summary: "update todo list" };
  }

  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { tool: "other", summary: clip(`${mcp[1]}: ${mcp[2]}`) };
  return { tool: "other", summary: clip(name) };
}
