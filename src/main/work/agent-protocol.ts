import { summarizeTool } from "../../shared/normalize/tool-summary";
import type { AgentQuestion, IssueDetail, Project } from "../../shared/work/types";
import { MAX_TICKETS, TICKETS_FILE, ticketsInstructions } from "./ticket-drafts";

/** The prompt a ticket becomes, and how the runner reads `claude -p` stream-json output. */

export function buildPrompt(
  issue: IssueDetail,
  project: Project,
  where: {
    branch: string;
    base: string;
    existing: boolean;
    earlier?: EarlierTicket[];
    planOnly?: boolean;
  },
): string {
  const lines = [
    `You are working on the ${project.tracker.kind === "jira" ? "Jira ticket" : "GitHub issue"} ${issue.key} (${issue.type}${issue.priority ? `, priority ${issue.priority}` : ""}).`,
    "",
    `Title: ${issue.summary}`,
    "",
    "Description:",
    issue.description.trim() || "(no description)",
  ];
  if (issue.parent)
    lines.push(
      "",
      `This ticket belongs to the epic ${issue.parent.key} (${issue.parent.summary}). Do only this ticket's part of it.`,
    );
  if (issue.children?.length) {
    lines.push("", "This ticket is an epic. Its tickets already exist:");
    for (const c of issue.children) lines.push(`- ${c.key} ${c.summary} (${c.status})`);
    lines.push(
      where.planOnly
        ? "Do not create them again: add only the tickets the epic still misses, if any."
        : "Do not create them again. An agent works on one ticket at a time, so the work itself is done on those tickets, not here. Unless this epic asks for something of its own that none of them covers, change nothing and end by saying which ticket to start with and why.",
    );
  }
  if (where.earlier?.length) {
    lines.push(
      "",
      "Agents already did the earlier tickets of this epic. Their work is in your branch; build on their decisions rather than redoing them:",
    );
    for (const e of where.earlier) lines.push(`- ${e.key} ${e.summary}: ${clip(e.result, 1200)}`);
  }
  // Only people trusted with the repository get to talk to the agent.
  const comments = issue.comments.filter((c) => c.trusted).slice(-5);
  if (comments.length) {
    lines.push("", "Latest comments:");
    for (const c of comments) lines.push(`- ${c.author}: ${c.text.replace(/\s+/g, " ").trim()}`);
  }
  if (where.planOnly) lines.push("", ...planInstructions(issue.key));
  else
    lines.push(
      "",
      where.existing
        ? `You are in a git worktree of ${project.repo.fullName} on the existing branch ${where.branch}, where work on this ticket may already have started: \`git log origin/${where.base}..HEAD\` shows it. Build on it rather than starting over.`
        : `You are in a git worktree of ${project.repo.fullName} on the branch ${where.branch}, created from ${where.base}.`,
      "Implement the ticket in this repository, following the conventions of the existing code.",
      workingInstructions(),
      "Do not commit, push or open a pull request: this is done for you when you finish.",
      "If the ticket is unclear or can't be done, change nothing and explain why.",
      ticketsInstructions(),
      "End with a summary of what you did, how you checked it, and anything the next person needs to know (decisions taken, what is left, open questions). It becomes the pull request description and is posted on the ticket.",
    );
  if (project.agent.instructions?.trim())
    lines.push("", "Project instructions:", project.agent.instructions.trim());
  return lines.join("\n");
}

/**
 * A planning run only breaks the ticket into tickets: it reads the code to cut the work
 * well, and its tools can't change the repository.
 */
export function planInstructions(key: string): string[] {
  return [
    `Your only job is to break ${key} into tickets; agents do each of them later. You are in a git worktree of the repository and can only read files and write the tickets file: nothing else can change, and you have no shell.`,
    "Read the code just enough to cut the work well: the CLAUDE.md of the repository if there is one, the files the ticket names, targeted searches.",
    `Write the tickets to ${TICKETS_FILE}, as a JSON list: [{"summary": "Title", "description": "Markdown"}]. Each one is created under ${key}, in that order.`,
    "Make each ticket a piece of work one agent can do and check in one go, in the order to do them (each builds on the ones before), with a description saying what to change, where, and how to tell it is done. Nothing the ticket doesn't ask for.",
    `At most ${MAX_TICKETS} tickets. If the ticket is too unclear to break down, write no file and say what is missing.`,
    "End with a short summary of the breakdown; it is posted on the ticket.",
  ];
}

/**
 * Keeps a run cheap: agents tend to tour the repository and rerun everything, which costs
 * more than the change itself.
 */
export function workingInstructions(): string {
  return [
    "Read only what the ticket needs: start from the files it names, the CLAUDE.md of the repository if there is one, and targeted searches, not a tour of the code.",
    "Check your change the cheapest way that proves it: type-check, lint and run the tests that cover what you changed. Leave the full test suite, end-to-end runs and starting the whole stack to CI, unless the ticket is about them or nothing else can check it.",
    "Take screenshots only when the ticket changes what people see, and as few as you need: every image costs a lot.",
  ].join("\n");
}

/** A ticket of the same epic an agent finished before this one, and what it said. */
export interface EarlierTicket {
  key: string;
  summary: string;
  result: string;
}

/** A failing check of the pull request, with the end of its log when the service gives it. */
export interface FailedCheck {
  name: string;
  url?: string;
  summary?: string;
  log?: string;
}

/** What an agent put back on its pull request is told about the failing checks. */
export function ciInstruction(failed: FailedCheck[]): string {
  const lines = [
    "The checks of your pull request failed. Fix the cause in the code (not the checks themselves, unless they are wrong), then check it locally the same way before finishing.",
  ];
  for (const f of failed) {
    lines.push(
      "",
      `Check "${f.name}"${f.url ? ` (${f.url})` : ""}${f.summary ? `: ${clip(f.summary, 300)}` : ""}`,
    );
    if (f.log) lines.push("End of its log:", "```", f.log, "```");
  }
  if (!failed.some((f) => f.log))
    lines.push(
      "",
      "The service gives no log: reproduce the failure by running the same steps locally.",
    );
  return lines.join("\n");
}

/** A comment left on the pull request, inline on a file or on the whole change. */
export interface ReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
  /** ISO date, when the service gives it. */
  created?: string;
  /** Written by someone trusted with the repository; others never reach an agent. */
  trusted: boolean;
}

/** The prompt of a resumed session: the person's instruction, and the review if asked. */
export function buildContinuePrompt(
  issue: { key: string; summary: string },
  project: Project,
  branch: string,
  instruction: string,
  comments: ReviewComment[] = [],
  planOnly = false,
): string {
  const lines = [
    `You are continuing your work on ${issue.key} (${issue.summary}), in the same worktree on the branch ${branch}.`,
  ];
  if (instruction.trim()) lines.push("", "New instruction from the person:", instruction.trim());
  const review = comments.filter((c) => c.trusted && c.body.trim()).slice(-30);
  if (review.length) {
    lines.push("", "Review comments on the pull request:");
    for (const c of review) {
      const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : "";
      lines.push(`- ${c.author}${where}: ${c.body.replace(/\s+/g, " ").trim()}`);
    }
  }
  lines.push(
    "",
    ...(planOnly
      ? [
          `Same rules as before: you only write tickets, to ${TICKETS_FILE}. Write only the new ones: those you wrote before already exist.`,
        ]
      : [
          "Same rules as before: do not commit, push or open a pull request, this is done for you.",
          workingInstructions(),
          ticketsInstructions(),
        ]),
    "End with a summary of what you did this time and anything the next person needs to know; it is posted on the ticket.",
  );
  if (project.agent.instructions?.trim())
    lines.push("", "Project instructions:", project.agent.instructions.trim());
  return lines.join("\n");
}

export interface StreamResult {
  text: string;
  isError: boolean;
  costUsd?: number;
  /** The agent spent its --max-budget-usd before finishing. */
  budgetReached?: boolean;
}

export interface StreamUpdate {
  /** Human-readable progress line. */
  log?: string;
  result?: StreamResult;
  /** An assistant message's tokens; a message arrives once per content block, same id. */
  usage?: { id: string; tokens: number };
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
  message?: {
    id?: string;
    content?: { type: string; text?: string; name?: string; input?: unknown }[];
    usage?: Record<string, unknown>;
  };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  errors?: string[];
}

/** Tokens read and written by one assistant message, cached context included. */
function messageUsage(line: StreamLine): StreamUpdate["usage"] {
  const id = line.message?.id;
  const usage = line.message?.usage;
  if (line.type !== "assistant" || !id || !usage) return undefined;
  const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return {
    id,
    tokens:
      count("input_tokens") +
      count("cache_read_input_tokens") +
      count("cache_creation_input_tokens") +
      count("output_tokens"),
  };
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
  const usage = messageUsage(line);
  if (line.type === "assistant" && !line.parent_tool_use_id) {
    const blocks = line.message?.content ?? [];
    const tool = blocks.findLast((b) => b.type === "tool_use" && b.name);
    if (tool?.name) return { log: `→ ${summarizeTool(tool.name, tool.input, cwd).summary}`, usage };
    const text = blocks.find((b) => b.type === "text" && b.text?.trim())?.text;
    return text ? { log: clip(text), usage } : { usage };
  }
  // Subagents' messages count too.
  if (line.type === "assistant") return { usage };
  if (line.type === "result") {
    const isError =
      line.is_error === true || (line.subtype !== undefined && line.subtype !== "success");
    const text = line.result ?? line.errors?.join("\n") ?? line.subtype ?? "";
    return {
      log: isError ? `agent stopped: ${clip(text || "error")}` : "agent finished",
      result: {
        text,
        isError,
        costUsd: line.total_cost_usd,
        budgetReached: line.subtype === "error_max_budget_usd" || undefined,
      },
    };
  }
  return {};
}

/** Claude Code stopped because the account's session or weekly limit is used up. */
export const isUsageLimit = (text: string): boolean => /hit your .*limit|usage limit/i.test(text);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the limit resets, from "resets 8:40pm (Europe/Paris)" or "resets Nov 3, 9am", read
 * in this machine's time zone. A time without a date is the next one to come.
 */
export function resetTime(text: string, now = new Date()): number | undefined {
  const match =
    /resets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(
      text,
    );
  if (!match) return undefined;
  const [, month, day, hours, minutes, half] = match;
  const at = new Date(now);
  at.setHours(
    (Number(hours) % 12) + (half!.toLowerCase() === "pm" ? 12 : 0),
    Number(minutes ?? 0),
    0,
    0,
  );
  const monthIndex = month ? MONTHS.indexOf(month.toLowerCase()) : -1;
  if (monthIndex >= 0) at.setMonth(monthIndex, Number(day));
  else if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
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

/**
 * Claude Code asks before using a tool its permission mode doesn't allow on its own
 * (`--permission-prompt-tool stdio`): a `control_request` of subtype `can_use_tool`,
 * answered with a `control_response` on stdin.
 */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
  /** Claude Code's own wording of what the call does. */
  description?: string;
  /** Rules Claude Code proposes so the same call isn't asked again. */
  suggestions?: PermissionSuggestion[];
}

interface PermissionSuggestion {
  type?: string;
  behavior?: string;
  rules?: { toolName?: string; ruleContent?: string }[];
  destination?: string;
}

export function readPermissionRequest(line: unknown): PermissionRequest | undefined {
  const j = line as {
    type?: string;
    request_id?: string;
    request?: {
      subtype?: string;
      tool_name?: string;
      input?: unknown;
      description?: string;
      permission_suggestions?: PermissionSuggestion[];
    };
  };
  if (j?.type !== "control_request" || j.request?.subtype !== "can_use_tool") return undefined;
  if (!j.request_id || !j.request.tool_name) return undefined;
  return {
    requestId: j.request_id,
    toolName: j.request.tool_name,
    input: j.request.input,
    description: j.request.description,
    suggestions: Array.isArray(j.request.permission_suggestions)
      ? j.request.permission_suggestions
      : undefined,
  };
}

/** What the person sees: the command, the file, or the tool's input. */
export function describeRequest(
  request: PermissionRequest,
  cwd?: string,
): Omit<AgentQuestion, "askedAt"> {
  const input = (request.input ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const detail =
    text(input.command) ??
    text(input.file_path) ??
    text(input.url) ??
    text(input.pattern) ??
    JSON.stringify(input, null, 2);
  return {
    id: request.requestId,
    tool: request.toolName,
    summary: summarizeTool(request.toolName, request.input, cwd).summary,
    detail: detail.length > 2000 ? `${detail.slice(0, 1999)}…` : detail,
    reason: text(input.description) ?? text(request.description),
    alwaysRule: alwaysRule(request),
  };
}

/** The rule "always allow for this run" adds, as the person would read it. */
function alwaysRule(request: PermissionRequest): string | undefined {
  const rule = request.suggestions?.find((s) => s.type === "addRules" && s.behavior === "allow")
    ?.rules?.[0];
  if (!rule) return undefined;
  return rule.ruleContent ? rule.ruleContent : (rule.toolName ?? request.toolName);
}

/** The answer line written to the agent's stdin. */
export function permissionResponse(
  request: PermissionRequest,
  answer: { allow: true; always?: boolean } | { allow: false; message?: string },
): string {
  // "Always" hands Claude Code its own suggested rules for this session only: nothing is
  // written to any settings file, and the next run asks again.
  const always =
    answer.allow && answer.always
      ? (request.suggestions ?? [])
          .filter((s) => s.type === "addRules" && s.behavior === "allow")
          .map((s) => ({ ...s, destination: "session" }))
      : [];
  const response = answer.allow
    ? {
        behavior: "allow",
        updatedInput: request.input ?? {},
        ...(always.length ? { updatedPermissions: always } : {}),
      }
    : {
        behavior: "deny",
        message: answer.message?.trim() || "Refused by the person in the office.",
      };
  return `${JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: request.requestId, response },
  })}\n`;
}

/** Other control requests this app doesn't handle get an error, so the agent never hangs. */
export function unsupportedResponse(line: unknown): string | undefined {
  const j = line as { type?: string; request_id?: string; request?: { subtype?: string } };
  if (j?.type !== "control_request" || !j.request_id || j.request?.subtype === "can_use_tool")
    return undefined;
  return `${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: j.request_id,
      error: `Not supported: ${j.request?.subtype ?? "unknown"}`,
    },
  })}\n`;
}

/** The ticket, as the first message of a `--input-format stream-json` session. */
export const promptMessage = (prompt: string): string =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`;
