import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IssueType } from "../../shared/work/types";
import type { IssueTracker } from "../integrations/trackers";

/**
 * Tickets an agent asks for. The agent has no tracker access of its own (no gh, no token):
 * it writes them to this file in its worktree, and the app creates them with the project's
 * account once the agent is done. The file is never committed.
 */
export const TICKETS_FILE = ".mypixelteam/tickets.json";

const MAX_TICKETS = 30;

const Draft = z.object({
  summary: z.string().trim().min(1).max(250),
  description: z.string().optional(),
});

const Epic = Draft.extend({ tickets: z.array(Draft).optional() });

export const TicketDrafts = z
  .array(Epic)
  .refine(
    (epics) => epics.reduce((n, e) => n + 1 + (e.tickets?.length ?? 0), 0) <= MAX_TICKETS,
    `at most ${MAX_TICKETS} tickets in one run`,
  );
export type TicketDrafts = z.infer<typeof TicketDrafts>;

/** What the prompt tells the agent about the file. */
export const ticketsInstructions = (): string =>
  [
    `Create tickets only when the ticket explicitly asks for them (an epic, follow-up tasks…), and never one that already exists. Then do not use gh, curl or any tracker API: you have no access to them. Write the tickets instead to ${TICKETS_FILE} in the worktree, as JSON:`,
    '[{"summary": "Epic title", "description": "Markdown", "tickets": [{"summary": "Child ticket", "description": "Markdown"}]}]',
    `Each top-level entry becomes a ticket; one with "tickets" becomes an epic holding them. They are created for you when you finish, with the project's account: this is the expected way, no need to ask first. The file is not committed. At most ${MAX_TICKETS} tickets.`,
    "When the ticket only asks for tickets (planning, an epic, a breakdown), that file is your whole answer: do not write them to a document and do not change any file of the repository, so no pull request is opened. Your summary is posted on the ticket.",
  ].join("\n");

/** Reads and removes the agent's ticket file. Absent: nothing to create. */
export function takeTicketDrafts(worktree: string): TicketDrafts | undefined {
  const path = join(worktree, TICKETS_FILE);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  rmSync(join(worktree, ".mypixelteam"), { recursive: true, force: true });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${TICKETS_FILE} is not valid JSON`);
  }
  const parsed = TicketDrafts.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `${TICKETS_FILE} is not a list of tickets: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  return parsed.data;
}

/** The Jira types to use: "Epic" for a parent, "Task" (or the first type) otherwise. */
export function pickTypes(types: IssueType[]): { epic: string; ticket: string } {
  const named = (re: RegExp) => types.find((t) => re.test(t.name))?.id;
  const ticket = named(/^(task|tâche)$/i) ?? named(/^story$/i) ?? types[0]?.id ?? "";
  return { epic: named(/^epic$/i) ?? ticket, ticket };
}

export interface CreatedTicket {
  key: string;
  summary: string;
  parent?: string;
}

/**
 * Creates the drafts in order, epics first. `onCreated` hears of each one, so a failure
 * halfway still says what exists.
 */
export async function createTickets(
  tracker: IssueTracker,
  drafts: TicketDrafts,
  onCreated: (ticket: CreatedTicket) => void,
): Promise<CreatedTicket[]> {
  const types = pickTypes(await tracker.issueTypes());
  const created: CreatedTicket[] = [];
  const add = async (
    draft: z.infer<typeof Draft>,
    issueTypeId: string,
    parent?: string,
  ): Promise<string> => {
    const key = await tracker.create({
      issueTypeId,
      summary: draft.summary,
      description: draft.description,
      parentKey: parent,
    });
    const ticket = { key, summary: draft.summary.trim(), parent };
    created.push(ticket);
    onCreated(ticket);
    return key;
  };
  for (const epic of drafts) {
    const children = epic.tickets ?? [];
    const key = await add(epic, children.length ? types.epic : types.ticket);
    for (const child of children) await add(child, types.ticket, key);
  }
  return created;
}

/** The comment left on the agent's ticket. */
export function createdComment(created: CreatedTicket[]): string {
  const lines = ["An agent created these tickets:"];
  for (const t of created) lines.push(`${t.parent ? "  - " : "- "}${t.key} ${t.summary}`);
  return lines.join("\n");
}
