import { summarizeTool } from "../../shared/normalize/tool-summary";
import type { IssueDetail, Project } from "../../shared/work/types";

/** The prompt a ticket becomes, and how the runner reads `claude -p` stream-json output. */

export function buildPrompt(
  issue: IssueDetail,
  project: Project,
  where: { branch: string; base: string; existing: boolean },
): string {
  const lines = [
    `You are working on the ${project.tracker.kind === "jira" ? "Jira ticket" : "GitHub issue"} ${issue.key} (${issue.type}${issue.priority ? `, priority ${issue.priority}` : ""}).`,
    "",
    `Title: ${issue.summary}`,
    "",
    "Description:",
    issue.description.trim() || "(no description)",
  ];
  // Only people trusted with the repository get to talk to the agent.
  const comments = issue.comments.filter((c) => c.trusted).slice(-5);
  if (comments.length) {
    lines.push("", "Latest comments:");
    for (const c of comments) lines.push(`- ${c.author}: ${c.text.replace(/\s+/g, " ").trim()}`);
  }
  lines.push(
    "",
    where.existing
      ? `You are in a git worktree of ${project.repo.fullName} on the existing branch ${where.branch}, where work on this ticket may already have started: \`git log origin/${where.base}..HEAD\` shows it. Build on it rather than starting over.`
      : `You are in a git worktree of ${project.repo.fullName} on the branch ${where.branch}, created from ${where.base}.`,
    "Implement the ticket in this repository. Follow the conventions of the existing code and run the relevant tests or checks if the project has them.",
    "Do not commit, push or open a pull request: this is done for you when you finish.",
    "If the ticket is unclear or can't be done, change nothing and explain why.",
    "End with a short summary of what you changed and how you checked it; it becomes the pull request description.",
  );
  if (project.agent.instructions?.trim())
    lines.push("", "Project instructions:", project.agent.instructions.trim());
  return lines.join("\n");
}

export interface StreamResult {
  text: string;
  isError: boolean;
  costUsd?: number;
}

export interface StreamUpdate {
  /** Human-readable progress line. */
  log?: string;
  result?: StreamResult;
}

const clip = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

interface StreamLine {
  type?: string;
  subtype?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: { type: string; text?: string; name?: string; input?: unknown }[] };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  errors?: string[];
}

/** One line of `claude -p --output-format stream-json --verbose`. */
export function readStreamLine(raw: string, cwd?: string): StreamUpdate {
  let line: StreamLine;
  try {
    line = JSON.parse(raw);
  } catch {
    return raw.trim() ? { log: clip(raw) } : {};
  }
  if (line.type === "system" && line.subtype === "init")
    return { log: `session started${line.model ? ` (${line.model})` : ""}` };
  if (line.type === "assistant" && !line.parent_tool_use_id) {
    const blocks = line.message?.content ?? [];
    const tool = blocks.findLast((b) => b.type === "tool_use" && b.name);
    if (tool?.name) return { log: `→ ${summarizeTool(tool.name, tool.input, cwd).summary}` };
    const text = blocks.find((b) => b.type === "text" && b.text?.trim())?.text;
    return text ? { log: clip(text) } : {};
  }
  if (line.type === "result") {
    const isError =
      line.is_error === true || (line.subtype !== undefined && line.subtype !== "success");
    const text = line.result ?? line.errors?.join("\n") ?? line.subtype ?? "";
    return {
      log: isError ? `agent stopped: ${clip(text || "error")}` : "agent finished",
      result: { text, isError, costUsd: line.total_cost_usd },
    };
  }
  return {};
}

/** `reference` points at the ticket: a Jira link, or "Closes #12". */
export function pullRequestBody(reference: string, result: string): string {
  return [
    reference,
    "",
    result.trim() || "_The agent left no summary._",
    "",
    "---",
    "Opened by a MyPixelTeam agent (Claude Code).",
  ].join("\n");
}
