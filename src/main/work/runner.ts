import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  baseBranchOf,
  isActiveRun,
  isIssueKey,
  issueSlug,
  MAX_CI_FIXES,
  MODEL_PATTERN,
  projectModel,
  type AgentQuestion,
  type IssueDetail,
  type ContinueOptions,
  type Project,
  type QuestionAnswer,
  type RunStatus,
  type StartRunOptions,
  type RunView,
} from "../../shared/work/types";
import type { AccountStore } from "./accounts";
import {
  buildContinuePrompt,
  buildPrompt,
  ciInstruction,
  describeRequest,
  isUsageLimit,
  permissionResponse,
  promptMessage,
  pullRequestBody,
  readPermissionRequest,
  readStreamLine,
  resetTime,
  unsupportedResponse,
  type EarlierTicket,
  type FailedCheck,
  type PermissionRequest,
  type ReviewComment,
  type StreamResult,
} from "./agent-protocol";
import {
  branchName,
  commitAll,
  ensureClone,
  headCommit,
  prepareWorktree,
  push,
  remoteBranches,
  unpublishedCommits,
} from "./git";
import type { CiReport } from "../integrations/git-providers";
import type { IssueTracker } from "../integrations/trackers";
import {
  createdComment,
  createTickets,
  takeTicketDrafts,
  type CreatedTicket,
} from "./ticket-drafts";
import type { WorkspaceStore } from "./workspace";

/**
 * Puts an agent on a Jira ticket: worktree and branch, ticket to "in progress",
 * `claude -p` in the worktree, then commit, push, pull request and ticket to "review".
 * The session writes its transcript like any other, so its character shows up in the office.
 */

export interface RunnerOptions {
  accounts: AccountStore;
  workspace: WorkspaceStore;
  /** Worktrees go to <worktreesDir>/<project id>/<issue key>. */
  worktreesDir: string;
  /** Claude Code CLI, "claude" by default. */
  claude: string;
  onChange: (runs: RunView[]) => void;
  /** The agent's session started or ended, for the office. */
  onSession: (run: RunView, phase: "started" | "ended") => void;
  /** A run reached done, failed or cancelled. */
  onFinished?: (run: RunView) => void;
  /** The agent asked something (`question`), or an answer was given (undefined). */
  onQuestion?: (run: RunView, question: AgentQuestion | undefined) => void;
  /** JSON file keeping the runs across restarts. */
  historyPath?: string;
}

const LOG_LIMIT = 200;
/** Agents log a lot: the renderer gets at most a few updates per second. */
const CHANGE_THROTTLE_MS = 250;
const RUN_LIMIT = 50;
/** When the usage limit message doesn't say when it resets. */
const LIMIT_FALLBACK_MS = 60 * 60 * 1000;
/** Checks are read every minute after a push, for at most 45 minutes. */
const CI_POLL_MS = 60_000;
const CI_WATCH_MS = 45 * 60_000;
/** Checks can take a moment to show up; with none after this, the repository runs none. */
const CI_SETTLE_MS = 3 * 60_000;
const RESUME_INSTRUCTION =
  "The Claude usage limit stopped you before you finished. Pick the ticket up where you left off: your changes so far are still in the worktree.";

class Cancelled extends Error {}

/** What a run does: a ticket's first run, or the continuation of an earlier one. */
type Plan =
  | { kind: "new"; options: StartRunOptions; earlier?: EarlierTicket[] }
  | { kind: "continue"; instruction: string; includeReview: boolean };

/** An epic's tickets, done one after another, each on a branch built on the previous one. */
interface EpicChain {
  projectId: string;
  epicKey: string;
  remaining: { key: string; summary: string }[];
  /** The branch the next ticket starts from: the last one pushed. */
  from?: string;
  earlier: EarlierTicket[];
  /** The run of the ticket being worked on. */
  current?: string;
  /** That run's ticket. */
  ticket?: { key: string; summary: string };
}

/** A run waiting for a free desk, with what it will do once it gets one. */
interface Waiting {
  project: Project;
  plan: Plan;
  /** Goes before the others: an agent picking up its ticket after the usage limit. */
  first: boolean;
}

export class AgentRunner {
  private readonly runs = new Map<string, RunView>();
  private readonly children = new Map<string, ChildProcess>();
  /** Permission requests waiting for an answer, by run then question id. */
  private readonly requests = new Map<string, Map<string, PermissionRequest>>();
  private readonly waiting = new Map<string, Waiting>();
  /** Set when the Claude usage limit stopped an agent: no other agent starts before then. */
  private pausedUntil = 0;
  private readonly epics = new Map<string, EpicChain>();
  private readonly ciTimers = new Map<string, NodeJS.Timeout>();
  private changeTimer?: NodeJS.Timeout;
  private resumeTimer?: NodeJS.Timeout;

  constructor(private readonly options: RunnerOptions) {
    for (const run of loadHistory(options.historyPath)) this.runs.set(run.id, run);
    const resumes = [...this.runs.values()].flatMap((r) => (r.resumeAt ? [r.resumeAt] : []));
    if (resumes.length) {
      this.pausedUntil = Math.max(...resumes);
      this.scheduleResume();
    }
  }

  list(): RunView[] {
    return [...this.runs.values()].reverse();
  }

  bySession(sessionId: string): RunView | undefined {
    // A continued run shares its session with the earlier ones: the latest one is current.
    return this.list().find((run) => run.sessionId === sessionId);
  }

  start(
    projectId: string,
    issueKey: string,
    options: StartRunOptions = {},
    earlier?: EarlierTicket[],
  ): RunView {
    if (!isIssueKey(issueKey)) throw new Error(`Not an issue key: ${issueKey}`);
    const project = this.options.workspace.get(projectId);
    const busy = [...this.runs.values()].find((r) => r.issueKey === issueKey && isActiveRun(r));
    if (busy) throw new Error(`An agent is already on ${issueKey}`);
    const model = options.model?.trim();
    if (model && !MODEL_PATTERN.test(model)) throw new Error(`Not a model name: ${model}`);
    const run: RunView = {
      id: randomUUID(),
      projectId,
      issueKey,
      issueSummary: "",
      sessionId: randomUUID(),
      status: "queued",
      branch: "",
      worktree: join(this.options.worktreesDir, projectId, issueSlug(issueKey)),
      startedAt: Date.now(),
      model: model || projectModel(project),
      log: [],
    };
    return this.launch(run, project, { kind: "new", options, earlier });
  }

  /**
   * Resumes the agent's session of an earlier run, on the same branch and worktree, with a
   * new instruction and, if asked, the pull request's review comments.
   */
  continueRun(
    previousRunId: string,
    instruction: string,
    options: ContinueOptions = {},
    extra: { first?: boolean; ciFixes?: number } = {},
  ): RunView {
    const previous = this.runs.get(previousRunId);
    if (!previous) throw new Error("Unknown run");
    if (!previous.agentStarted || !previous.branch)
      throw new Error(
        "That run stopped before its agent started: put an agent on the ticket again",
      );
    if (!instruction.trim() && !options.includeReview)
      throw new Error("Say what the agent should do next");
    const busy = [...this.runs.values()].find(
      (r) =>
        r.issueKey === previous.issueKey && r.projectId === previous.projectId && isActiveRun(r),
    );
    if (busy) throw new Error(`An agent is already on ${previous.issueKey}`);
    const project = this.options.workspace.get(previous.projectId);
    // Continued by hand: no need to pick it up after the usage limit as well.
    previous.resumeAt = undefined;
    const run: RunView = {
      id: randomUUID(),
      projectId: previous.projectId,
      issueKey: previous.issueKey,
      issueSummary: previous.issueSummary,
      sessionId: previous.sessionId,
      status: "queued",
      branch: previous.branch,
      worktree: previous.worktree,
      startedAt: Date.now(),
      pullRequestUrl: previous.pullRequestUrl,
      continuedFrom: previous.id,
      instruction: instruction.trim() || undefined,
      model: previous.model ?? projectModel(project),
      epicKey: previous.epicKey,
      ciFixes: extra.ciFixes,
      log: [],
    };
    // An epic waiting on this ticket waits on its continuation now.
    for (const chain of this.epics.values())
      if (chain.current === previous.id) chain.current = run.id;
    return this.launch(
      run,
      project,
      { kind: "continue", instruction, includeReview: Boolean(options.includeReview) },
      extra.first,
    );
  }

  /**
   * Puts agents on an epic's open tickets, in their order in the epic, one after another:
   * each starts from the branch of the one before, so the work it depends on is there.
   */
  async startEpic(projectId: string, epicKey: string): Promise<RunView> {
    const project = this.options.workspace.get(projectId);
    const epic = await this.options.accounts.tracker(project).issue(epicKey);
    const open = (epic.children ?? []).filter((c) => c.statusCategory !== "done");
    if (!open.length) throw new Error(`${epicKey} has no open ticket`);
    const id = `${projectId}:${epicKey}`;
    const current = this.runs.get(this.epics.get(id)?.current ?? "");
    if (current && isActiveRun(current))
      throw new Error(`Agents are already working through ${epicKey}`);
    const busy = open.find((c) =>
      [...this.runs.values()].some((r) => r.issueKey === c.key && isActiveRun(r)),
    );
    if (busy) throw new Error(`An agent is already on ${busy.key}: let it finish or stop it first`);
    const chain: EpicChain = {
      projectId,
      epicKey,
      remaining: open.map((c) => ({ key: c.key, summary: c.summary })),
      earlier: [],
    };
    this.epics.set(id, chain);
    return this.nextInEpic(chain)!;
  }

  private nextInEpic(chain: EpicChain): RunView | undefined {
    const next = chain.remaining.shift();
    if (!next) {
      this.epics.delete(`${chain.projectId}:${chain.epicKey}`);
      return undefined;
    }
    const run = this.start(
      chain.projectId,
      next.key,
      { from: chain.from },
      chain.earlier.length ? [...chain.earlier] : undefined,
    );
    run.epicKey = chain.epicKey;
    chain.current = run.id;
    chain.ticket = next;
    this.log(
      run,
      `ticket ${chain.earlier.length + 1} of ${chain.earlier.length + 1 + chain.remaining.length} in ${chain.epicKey}`,
    );
    return run;
  }

  /** An epic's ticket ended: the next one starts, or the epic waits for the person. */
  private epicStep(run: RunView): void {
    if (!run.epicKey) return;
    const chain = this.epics.get(`${run.projectId}:${run.epicKey}`);
    if (!chain || chain.current !== run.id) return;
    if (run.status === "done") {
      if (run.pullRequestUrl) chain.from = run.branch;
      chain.earlier.push({ ...chain.ticket!, result: run.result ?? "" });
      try {
        this.nextInEpic(chain);
      } catch (err) {
        this.log(run, `could not go on with ${chain.epicKey}: ${message(err)}`);
        this.epics.delete(`${chain.projectId}:${chain.epicKey}`);
      }
      return;
    }
    // Picked up after the usage limit, or continued once the person gives more budget.
    if (run.status === "failed" && (run.resumeAt || run.stoppedOnBudget)) return;
    this.epics.delete(`${chain.projectId}:${chain.epicKey}`);
    if (chain.remaining.length)
      this.log(
        run,
        `${chain.epicKey} stopped here: ${chain.remaining.map((t) => t.key).join(", ")} wait for you`,
      );
  }

  /** Queues the run; it starts right away when a desk is free. */
  private launch(run: RunView, project: Project, plan: Plan, first = false): RunView {
    this.runs.set(run.id, run);
    this.waiting.set(run.id, { project, plan, first });
    this.trim();
    this.drain();
    if (run.status === "queued")
      this.log(
        run,
        this.pausedUntil > Date.now()
          ? `waiting for the Claude usage limit to reset at ${clock(this.pausedUntil)}`
          : "waiting: other agents are working",
      );
    this.changed();
    return run;
  }

  /** Starts waiting runs while fewer agents than allowed are working, resumed ones first. */
  drain(): void {
    if (this.pausedUntil > Date.now()) return;
    const limit = this.options.workspace.view().maxAgents;
    while (this.working() < limit) {
      const next =
        [...this.waiting].find(([, w]) => w.first) ?? this.waiting.entries().next().value;
      if (!next) return;
      const [id, { project, plan }] = next;
      this.waiting.delete(id);
      const run = this.runs.get(id)!;
      run.status = "preparing";
      run.startedAt = Date.now();
      this.changed();
      void this.execute(run, project, plan).catch((err) => {
        const cancelled = err instanceof Cancelled || run.status === "cancelled";
        this.finish(run, cancelled ? "cancelled" : "failed", cancelled ? undefined : err);
      });
    }
  }

  private working(): number {
    return [...this.runs.values()].filter((r) => isActiveRun(r) && r.status !== "queued").length;
  }

  /** Stops a run, takes it out of the queue, or stops it picking its ticket up again. */
  cancel(id: string): void {
    const run = this.runs.get(id);
    if (run?.resumeAt && !isActiveRun(run)) {
      run.resumeAt = undefined;
      this.log(run, "will not pick the ticket up again");
      return;
    }
    if (!run || !isActiveRun(run)) return;
    if (this.waiting.delete(id)) {
      this.log(run, "taken out of the queue");
      return this.finish(run, "cancelled");
    }
    run.status = "cancelled";
    this.log(run, "cancelled");
    const child = this.children.get(id);
    if (child?.pid) killTree(child.pid);
    this.changed();
  }

  /** On quit: agents must not keep running without the app watching them. */
  stopAll(): void {
    clearTimeout(this.resumeTimer);
    for (const timer of this.ciTimers.values()) clearTimeout(timer);
    for (const run of this.runs.values()) if (isActiveRun(run)) this.cancel(run.id);
    this.save();
  }

  private async execute(run: RunView, project: Project, plan: Plan): Promise<void> {
    const options = plan.kind === "new" ? plan.options : {};
    const { accounts } = this.options;
    const tracker = accounts.tracker(project);
    const provider = accounts.git(project.repo.provider);
    const auth = provider.gitAuth();

    const issue = await tracker.issue(run.issueKey);
    // A continued run was accepted when it started; its new words come from the person.
    if (plan.kind === "new" && !issue.trusted && !options.allowUntrusted)
      throw new Error(
        `${issue.key} was opened by ${issue.author ?? "someone"}, who is not a collaborator of the repository. ` +
          "Read it, then confirm to put an agent on it anyway.",
      );
    run.issueSummary = issue.summary;
    this.log(run, `ticket: ${issue.summary}`);
    this.check(run);

    const base = baseBranchOf(project);
    this.log(run, `repository: ${project.localPath}`);
    await ensureClone(project.repo.cloneUrl, project.localPath, auth);
    this.check(run);
    // A branch picked among those on origin must still be there; the agent's own branch from
    // an earlier run continues from origin too, or its push would be refused.
    const onOrigin = await remoteBranches(project.localPath, auth);
    if (options.branch && !onOrigin.includes(options.branch))
      throw new Error(`The branch ${options.branch} is no longer on origin`);
    if (options.from && !onOrigin.includes(options.from))
      throw new Error(`The branch ${options.from} is no longer on origin`);
    // An epic's ticket builds on the branch of the one before.
    const start = options.from ?? base;
    if (plan.kind === "new") run.branch = options.branch ?? branchName(issue.key, issue.summary);
    const existing = onOrigin.includes(run.branch);
    this.log(
      run,
      existing
        ? `worktree on the existing branch ${run.branch}`
        : `worktree on ${run.branch}, from ${start}`,
    );
    const note = await prepareWorktree({
      repoPath: project.localPath,
      worktree: run.worktree,
      branch: run.branch,
      base: start,
      auth,
      existing,
    });
    if (note) this.log(run, note);
    this.check(run);
    const startCommit = await headCommit(run.worktree);

    if (issue.statusCategory !== "indeterminate") await this.move(run, tracker, "start");

    const prompt =
      plan.kind === "new"
        ? buildPrompt(issue, project, {
            branch: run.branch,
            base: start,
            existing,
            earlier: plan.earlier,
          })
        : buildContinuePrompt(
            issue,
            project,
            run.branch,
            plan.instruction,
            plan.includeReview ? await this.review(run, project) : [],
          );
    run.status = "running";
    this.changed();
    await this.note(
      run,
      tracker,
      plan.kind === "new"
        ? `An agent started on this ticket, on the branch ${run.branch}.`
        : run.ciFixes
          ? `An agent is back on this ticket to fix the failing checks of its pull request (attempt ${run.ciFixes} of ${MAX_CI_FIXES}).`
          : `An agent is back on this ticket, on the branch ${run.branch}${plan.instruction.trim() ? `:\n\n${plan.instruction.trim()}` : "."}`,
    );
    try {
      await this.work(run, project, plan, issue, prompt, startCommit);
    } catch (err) {
      // `cancel` changes the status behind TypeScript's back.
      const cancelled = err instanceof Cancelled || (run.status as RunStatus) === "cancelled";
      await this.note(
        run,
        tracker,
        cancelled
          ? "The agent was stopped before it finished."
          : `The agent could not finish: ${message(err)}${run.result ? `\n\n${run.result}` : ""}`,
      );
      throw err;
    }
  }

  /** The agent's run once its ticket says it started, and everything it hands back. */
  private async work(
    run: RunView,
    project: Project,
    plan: Plan,
    issue: IssueDetail,
    prompt: string,
    startCommit: string,
  ): Promise<void> {
    const { accounts } = this.options;
    const tracker = accounts.tracker(project);
    const provider = accounts.git(project.repo.provider);
    const auth = provider.gitAuth();
    const base = baseBranchOf(project);

    const result = await this.agent(run, project, prompt, plan.kind === "continue");
    this.check(run);
    run.result = result.text;
    run.costUsd = result.costUsd;
    if (result.isError && result.budgetReached) {
      run.stoppedOnBudget = true;
      throw new Error(
        `Budget of $${run.budgetUsd} reached before the agent finished. Its changes are kept: continue the run to give it another $${run.budgetUsd}.`,
      );
    }
    if (result.isError && isUsageLimit(result.text)) {
      const at = this.pause(run, result.text);
      throw new Error(`${result.text}. The agent picks the ticket up again at ${clock(at)}.`);
    }
    if (result.isError) throw new Error(result.text || "The agent stopped with an error");

    run.status = "publishing";
    this.changed();
    const created = await this.createTickets(run, tracker);
    // What the ticket keeps of the run: the pull request, the summary, the new tickets.
    const report = (pullRequest?: string) =>
      [
        pullRequest
          ? `${plan.kind === "new" ? "An agent opened a pull request" : "An agent updated the pull request"}: ${pullRequest}`
          : "The agent finished without a pull request.",
        result.text.trim(),
        created.length ? createdComment(created) : "",
      ]
        .filter(Boolean)
        .join("\n\n");

    const committed = await commitAll(run.worktree, tracker.title(issue));
    if (committed) this.log(run, "changes committed");
    if (!project.agent.openPullRequest) {
      await this.note(run, tracker, report());
      return this.finish(run, "done");
    }
    // An existing branch may hold colleagues' commits: publish only what is new.
    const moved = (await headCommit(run.worktree)) !== startCommit;
    if (!moved && (await unpublishedCommits(run.worktree, run.branch, base)) === 0) {
      this.log(run, "no changes to publish");
      await this.note(run, tracker, report());
      return this.finish(run, "done");
    }
    await push(run.worktree, run.branch, auth);
    this.log(run, "branch pushed");
    const pushed = await headCommit(run.worktree);
    const from = plan.kind === "new" ? plan.options.from : undefined;
    const stacked = from
      ? `Built on ${from}, which holds the earlier tickets of the epic: merge their pull requests first.\n\n`
      : "";
    run.pullRequestUrl = await provider.pullRequest(project.repo.fullName, {
      title: tracker.title(issue),
      body: pullRequestBody(tracker.pullRequestReference(issue), stacked + result.text),
      head: run.branch,
      base,
    });
    this.log(run, `pull request: ${run.pullRequestUrl}`);
    await this.move(run, tracker, "review");
    await this.note(run, tracker, report(run.pullRequestUrl));
    this.finish(run, "done");
    this.watchCi(run, project, pushed);
  }

  /**
   * Follows the pull request's checks after a push. When they fail, the agent goes back on
   * its pull request with the failure, at most MAX_CI_FIXES times in a row.
   */
  private watchCi(run: RunView, project: Project, sha: string): void {
    const provider = this.options.accounts.git(project.repo.provider);
    const since = Date.now();
    run.ci = "pending";
    this.changed();
    const check = async (): Promise<void> => {
      this.ciTimers.delete(run.id);
      // A newer run on the ticket pushed again: its own watch takes over.
      if (this.latest(run) !== run) return;
      let report: CiReport;
      try {
        report = await provider.checks(project.repo.fullName, sha);
      } catch (err) {
        this.log(run, `could not read the checks: ${message(err)}`);
        report = { state: "pending", failed: [] };
      }
      const waited = Date.now() - since;
      if (report.state === "none" && waited >= CI_SETTLE_MS) {
        run.ci = undefined;
        return this.log(run, "no checks on the pull request");
      }
      if (report.state === "none" || report.state === "pending") {
        if (waited < CI_WATCH_MS)
          this.ciTimers.set(
            run.id,
            setTimeout(() => void check(), CI_POLL_MS),
          );
        else {
          run.ci = undefined;
          this.log(run, "checks still running after 45 minutes: no longer followed");
        }
        return;
      }
      run.ci = report.state;
      if (report.state === "success") return this.log(run, "checks passed");
      this.log(run, `checks failed: ${report.failed.map((f) => f.name).join(", ")}`);
      this.fixCi(run, report.failed);
    };
    this.ciTimers.set(
      run.id,
      setTimeout(() => void check(), CI_POLL_MS),
    );
  }

  private fixCi(run: RunView, failed: FailedCheck[]): void {
    if (!this.options.workspace.view().fixCi) return;
    const fixes = run.ciFixes ?? 0;
    if (fixes >= MAX_CI_FIXES)
      return this.log(run, `checks still failing after ${fixes} fixes: left to you`);
    try {
      this.continueRun(run.id, ciInstruction(failed), {}, { ciFixes: fixes + 1 });
    } catch (err) {
      this.log(run, `could not put the agent back on the checks: ${message(err)}`);
    }
  }

  /** The ticket's most recent run. */
  private latest(run: RunView): RunView | undefined {
    return this.list().find((r) => r.projectId === run.projectId && r.issueKey === run.issueKey);
  }

  /**
   * The usage limit stopped the agent: nothing else starts before the limit resets, and then
   * the agent resumes its session. Agents already working stop on the limit by themselves.
   */
  private pause(run: RunView, text: string): number {
    const at = resetTime(text) ?? Date.now() + LIMIT_FALLBACK_MS;
    run.resumeAt = at;
    this.pausedUntil = Math.max(this.pausedUntil, at);
    this.scheduleResume();
    return at;
  }

  private scheduleResume(): void {
    clearTimeout(this.resumeTimer);
    // A little after the reset, and not before the app has settled when it was due already.
    const delay = Math.max(this.pausedUntil - Date.now() + 30_000, 10_000);
    this.resumeTimer = setTimeout(() => this.resume(), delay);
  }

  private resume(): void {
    this.pausedUntil = 0;
    for (const run of [...this.runs.values()]) {
      if (!run.resumeAt) continue;
      run.resumeAt = undefined;
      try {
        this.continueRun(run.id, RESUME_INSTRUCTION, {}, { first: true });
      } catch (err) {
        this.log(run, `could not pick the ticket up again: ${message(err)}`);
      }
    }
    this.drain();
  }

  /** A comment on the run's ticket; a failure is logged, not fatal. */
  private async note(run: RunView, tracker: IssueTracker, text: string): Promise<void> {
    try {
      await tracker.comment(run.issueKey, text);
    } catch (err) {
      this.log(run, `could not comment on the ticket: ${message(err)}`);
    }
  }

  /** The tickets the agent wrote to its ticket file, created with the project's account. */
  private async createTickets(run: RunView, tracker: IssueTracker): Promise<CreatedTicket[]> {
    const drafts = takeTicketDrafts(run.worktree);
    if (!drafts?.length) return [];
    const created: CreatedTicket[] = [];
    try {
      await createTickets(tracker, drafts, (t) => {
        created.push(t);
        this.log(run, `ticket created: ${t.key} ${t.summary}`);
      });
    } catch (err) {
      const before = created.length
        ? ` (created before the error: ${created.map((t) => t.key).join(", ")})`
        : "";
      throw new Error(`Could not create the tickets: ${message(err)}${before}`, { cause: err });
    }
    return created;
  }

  /** The pull request's review comments; a failure is logged, not fatal. */
  private async review(run: RunView, project: Project): Promise<ReviewComment[]> {
    if (!run.pullRequestUrl) {
      this.log(run, "no pull request yet: no review to pass on");
      return [];
    }
    try {
      const comments = await this.options.accounts
        .git(project.repo.provider)
        .reviewComments(project.repo.fullName, run.pullRequestUrl);
      const kept = comments.filter((c) => c.trusted).length;
      this.log(run, `review: ${kept} comment${kept === 1 ? "" : "s"} passed on`);
      if (kept < comments.length)
        this.log(run, `${comments.length - kept} comment(s) from outside the team left out`);
      return comments;
    } catch (err) {
      this.log(run, `could not read the review: ${message(err)}`);
      return [];
    }
  }

  /** Moves the ticket along its workflow when the tracker has a fitting status. */
  private async move(run: RunView, tracker: IssueTracker, goal: "start" | "review"): Promise<void> {
    try {
      const { moved, skipped } = await tracker.advance(run.issueKey, goal);
      this.log(run, moved ? `ticket → ${moved}` : `${skipped}: ticket left as is`);
    } catch (err) {
      this.log(run, `could not move the ticket: ${message(err)}`);
    }
  }

  private agent(
    run: RunView,
    project: Project,
    prompt: string,
    resume: boolean,
  ): Promise<StreamResult> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // A continued run picks its session up where the agent left it.
      resume ? "--resume" : "--session-id",
      run.sessionId,
      "--name",
      run.issueKey,
      "--permission-mode",
      project.agent.permissionMode,
      // What the mode doesn't allow on its own is asked here, on stdin/stdout, and answered
      // by the person from the office. The prompt goes in as a stream-json message.
      "--input-format",
      "stream-json",
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      "stdio",
    ];
    args.push("--model", run.model ?? projectModel(project));
    const budget = this.options.workspace.view().runBudgetUsd;
    if (budget > 0) {
      args.push("--max-budget-usd", String(budget));
      run.budgetUsd = budget;
    }

    // Started from inside a Claude Code session (dev), these would confuse the child.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const command = this.options.claude;
    const child = spawn(command, args, {
      cwd: run.worktree,
      env,
      windowsHide: true,
      // npm installs a .cmd shim on Windows, which only a shell can start. Arguments are
      // fixed or validated (model), and the prompt goes through stdin.
      shell: /\.(cmd|bat)$/i.test(command),
    });
    this.children.set(run.id, child);
    run.agentStarted = true;
    this.options.onSession(run, "started");

    return new Promise((resolve, reject) => {
      let result: StreamResult | undefined;
      const counted = new Set<string>();
      let stderr = "";
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        const request = readPermissionRequest(parsed);
        if (request) return this.ask(run, request);
        const unsupported = unsupportedResponse(parsed);
        if (unsupported) return void child.stdin!.write(unsupported);
        const update = readStreamLine(line, run.worktree);
        if (update.usage && !counted.has(update.usage.id)) {
          counted.add(update.usage.id);
          run.turns = (run.turns ?? 0) + 1;
          run.tokens = (run.tokens ?? 0) + update.usage.tokens;
          this.changed();
        }
        if (update.log) this.log(run, update.log);
        if (update.result) {
          result = update.result;
          // One ticket, one turn: closing stdin lets the session end.
          child.stdin!.end();
        }
      });
      child.stderr!.on(
        "data",
        (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)),
      );
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "ENOENT"
            ? new Error(
                `Claude Code CLI not found ("${command}"). Install it or set AGENT_OFFICE_CLAUDE to its path.`,
              )
            : err,
        );
      });
      child.on("close", (code) => {
        this.children.delete(run.id);
        this.requests.delete(run.id);
        if (run.questions?.length) {
          run.questions = [];
          this.changed();
        }
        this.options.onSession(run, "ended");
        if (run.status === "cancelled") reject(new Cancelled());
        else if (result) resolve(result);
        else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      });
      // The session lasts until stdin closes; an exit before that must not throw EPIPE.
      child.stdin!.on("error", () => {});
      child.stdin!.write(promptMessage(prompt));
    });
  }

  /** The agent waits for the person: shown on the ticket, the character and a notification. */
  private ask(run: RunView, request: PermissionRequest): void {
    const question: AgentQuestion = {
      ...describeRequest(request, run.worktree),
      askedAt: Date.now(),
    };
    let pending = this.requests.get(run.id);
    if (!pending) this.requests.set(run.id, (pending = new Map()));
    pending.set(question.id, request);
    run.questions = [...(run.questions ?? []), question];
    this.log(run, `asks: ${question.summary}`);
    this.changed();
    this.options.onQuestion?.(run, question);
  }

  /** Allows or refuses what the agent asked; a refusal's message reaches the agent. */
  answer(runId: string, questionId: string, answer: QuestionAnswer, message?: string): void {
    const run = this.runs.get(runId);
    const request = this.requests.get(runId)?.get(questionId);
    const child = this.children.get(runId);
    if (!run || !request || !child?.stdin?.writable)
      throw new Error("This question is no longer waiting for an answer");
    child.stdin.write(
      permissionResponse(
        request,
        answer === "deny"
          ? { allow: false, message }
          : { allow: true, always: answer === "always" },
      ),
    );
    this.requests.get(runId)!.delete(questionId);
    const question = run.questions?.find((q) => q.id === questionId);
    run.questions = (run.questions ?? []).filter((q) => q.id !== questionId);
    const what = question?.summary ?? request.toolName;
    this.log(
      run,
      answer === "deny"
        ? `refused: ${what}`
        : answer === "always"
          ? `allowed for this run: ${question?.alwaysRule ?? what}`
          : `allowed: ${what}`,
    );
    this.changed();
    this.options.onQuestion?.(run, undefined);
  }

  private check(run: RunView): void {
    if (run.status === "cancelled") throw new Cancelled();
  }

  private finish(run: RunView, status: RunStatus, err?: unknown): void {
    run.status = status;
    run.endedAt = Date.now();
    if (err) {
      run.error = message(err);
      this.log(run, `failed: ${run.error}`);
    }
    this.changed();
    this.options.onFinished?.(run);
    this.epicStep(run);
    this.drain();
  }

  private log(run: RunView, line: string): void {
    run.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
    if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
    this.changed();
  }

  private changed(): void {
    this.changeTimer ??= setTimeout(() => {
      this.changeTimer = undefined;
      this.options.onChange(this.list());
      this.save();
    }, CHANGE_THROTTLE_MS);
  }

  /** Forgets the oldest finished runs. */
  private trim(): void {
    for (const [id, run] of this.runs) {
      if (this.runs.size <= RUN_LIMIT) return;
      if (!isActiveRun(run)) this.runs.delete(id);
    }
  }

  private save(): void {
    const path = this.options.historyPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify([...this.runs.values()]));
      renameSync(`${path}.tmp`, path);
    } catch (err) {
      console.error(`[mypixelteam] could not save ${path}:`, err);
    }
  }
}

/**
 * Runs from previous launches. One still marked active was cut short by a crash: the app
 * stops its agents when it quits normally.
 */
export function loadHistory(path: string | undefined): RunView[] {
  if (!path || !existsSync(path)) return [];
  try {
    const runs = JSON.parse(readFileSync(path, "utf8")) as RunView[];
    if (!Array.isArray(runs)) return [];
    return runs.slice(-RUN_LIMIT).map((run) =>
      run.ci === "pending"
        ? { ...run, ci: undefined }
        : isActiveRun(run)
          ? {
              ...run,
              questions: [],
              status: "failed",
              endedAt: run.endedAt ?? Date.now(),
              error: "Interrupted: the app was closed",
            }
          : run,
    );
  } catch (err) {
    console.error(`[mypixelteam] could not read ${path}:`, err);
    return [];
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Stops the agent and whatever commands it started. */
function killTree(pid: number): void {
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid, "SIGTERM");
}
