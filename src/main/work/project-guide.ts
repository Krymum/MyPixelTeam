import { existsSync } from "node:fs";
import { join } from "node:path";
import { baseBranchOf, type Project } from "../../shared/work/types";
import type { IssueTracker } from "../integrations/trackers";
import { git } from "./git";
import { pickTypes } from "./ticket-drafts";

/**
 * Without a map of the repository, every agent spends its first minutes rediscovering it.
 * A CLAUDE.md, which Claude Code loads in every session, saves that on each ticket: the app
 * offers a ticket that has an agent write one.
 */

const GUIDE_FILES = ["CLAUDE.md", "AGENTS.md"];

export const GUIDE_TICKET = {
  summary: "Write a CLAUDE.md map of the repository for agents",
  description: [
    "Agents working on tickets in this repository spend their first minutes rediscovering it. Write a CLAUDE.md at the root of the repository (Claude Code loads it in every session) so they can start right away.",
    "",
    "Keep it short, under about 150 lines, and specific to this repository:",
    "- What the project is, in two or three sentences.",
    "- The layout: the main folders, what lives in each, the entry points.",
    "- Commands: install, build, type-check, lint, unit tests (and how to run a single test file), end-to-end tests, and how to start the stack locally if there is one.",
    "- Conventions a newcomer would get wrong: naming, patterns to follow, where tests go, generated files not to edit.",
    "- Pitfalls: environment variables, services it needs, slow or flaky steps.",
    "",
    "Only write what you checked in the code or by running a command. Change no other file.",
  ].join("\n"),
};

/** The base branch on origin has a CLAUDE.md or AGENTS.md; false before the first clone. */
export async function hasAgentGuide(project: Project): Promise<boolean> {
  if (!existsSync(join(project.localPath, ".git"))) return false;
  const found = await git(
    ["ls-tree", "--name-only", `origin/${baseBranchOf(project)}`, "--", ...GUIDE_FILES],
    { cwd: project.localPath, allowFailure: true },
  );
  return found.trim().length > 0;
}

/** The open guide ticket from an earlier offer, or a new one; returns its key. */
export async function guideTicket(tracker: IssueTracker): Promise<string> {
  const open = await tracker.search({ text: GUIDE_TICKET.summary });
  const earlier = open.find((i) => i.summary === GUIDE_TICKET.summary);
  if (earlier) return earlier.key;
  const { ticket } = pickTypes(await tracker.issueTypes());
  return tracker.create({ issueTypeId: ticket, ...GUIDE_TICKET });
}
