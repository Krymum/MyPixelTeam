import { isActiveRun, type RunView } from "../../shared/work/types";
import type { AccountStore } from "./accounts";
import type { AgentRunner } from "./runner";
import type { WorkspaceStore } from "./workspace";

/**
 * A comment starting with "@agent", on a ticket or on its pull request, puts the ticket's
 * agent back on it with the comment as its instruction: the work can be steered from the
 * tracker or the code host without opening the app. Only comments from people trusted
 * with the repository count, as for everything else an agent reads.
 */

const POLL_MS = 2 * 60_000;
/** Tickets whose last run ended longer ago are no longer watched. */
const WATCH_MS = 3 * 24 * 60 * 60_000;
/** The most recently worked tickets only: each one costs a few API calls per poll. */
const MAX_TICKETS = 10;
const COMMAND = /^@agent\b[\s:,]*/i;

export interface AgentRequest {
  author: string;
  text: string;
  created: number;
}

interface Comment {
  author: string;
  text: string;
  created?: string;
  trusted: boolean;
}

/** Jira writes offsets as "+0000", which Date.parse doesn't read everywhere. */
const parseTime = (at: string): number => Date.parse(at.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));

/** Trusted "@agent" comments written after `since` (epoch ms), oldest first. */
export function agentRequests(comments: Comment[], since: number): AgentRequest[] {
  return comments
    .filter((c) => c.trusted && c.created && COMMAND.test(c.text.trim()))
    .map((c) => ({
      author: c.author,
      text: c.text.trim().replace(COMMAND, "").trim(),
      created: parseTime(c.created!),
    }))
    .filter((r) => r.created > since && r.text)
    .sort((a, b) => a.created - b.created);
}

/** What the agent is told: each request with who wrote it. */
export function requestInstruction(requests: AgentRequest[]): string {
  return requests.map((r) => `${r.author} wrote in a comment: ${r.text}`).join("\n\n");
}

export class CommentWatcher {
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly deps: {
      runner: AgentRunner;
      accounts: AccountStore;
      workspace: WorkspaceStore;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async poll(now = Date.now()): Promise<void> {
    const { runner, workspace } = this.deps;
    if (this.polling || !workspace.view().commentCommands) return;
    this.polling = true;
    try {
      for (const run of watched(runner.list(), now)) await this.check(run);
    } finally {
      this.polling = false;
    }
  }

  private async check(run: RunView): Promise<void> {
    const { runner, accounts, workspace } = this.deps;
    try {
      const project = workspace.get(run.projectId);
      const issue = await accounts.tracker(project).issue(run.issueKey);
      const review = run.pullRequestUrl
        ? await accounts
            .git(project.repo.provider)
            .reviewComments(project.repo.fullName, run.pullRequestUrl)
            .catch(() => [])
        : [];
      const requests = agentRequests(
        [...issue.comments, ...review.map((c) => ({ ...c, text: c.body }))],
        run.startedAt,
      );
      if (requests.length) runner.continueRun(run.id, requestInstruction(requests));
    } catch (err) {
      console.error(`[mypixelteam] could not read the comments of ${run.issueKey}:`, err);
    }
  }
}

/**
 * Each ticket's latest run, when an agent worked on it lately and nothing else is planned:
 * not running, not about to resume, not waiting for more budget.
 */
export function watched(runs: RunView[], now: number): RunView[] {
  const latest = new Map<string, RunView>();
  for (const run of runs) {
    const key = `${run.projectId}:${run.issueKey}`;
    if (!latest.has(key)) latest.set(key, run);
  }
  return [...latest.values()]
    .filter(
      (r) =>
        !isActiveRun(r) &&
        r.agentStarted &&
        r.branch &&
        !r.resumeAt &&
        (r.endedAt ?? 0) > now - WATCH_MS,
    )
    .slice(0, MAX_TICKETS);
}
