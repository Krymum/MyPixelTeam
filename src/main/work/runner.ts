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
  PLAN_MODEL,
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
  git,
  headCommit,
  mergeFrom,
  prepareWorktree,
  push,
  remoteBranches,
  unpublishedCommits,
  type GitAuth,
} from "./git";
import type { CiReport } from "../integrations/git-providers";
import type { IssueTracker } from "../integrations/trackers";
import {
  createdComment,
  createTickets,
  takeTicketDrafts,
  TICKETS_DIR,
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
  "You were stopped before you finished (the Claude usage limit, or the app was closed). Pick the ticket up where you left off: your changes so far are still in the worktree.";
/** Restored work waits this long after launch, so the app has settled first. */
const RESTORE_DELAY_MS = 10_000;

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

/** What survives the app closing: the queue, the epics under way, the checks followed. */
interface RunnerState {
  plans: { runId: string; plan: Plan; first: boolean }[];
  epics: EpicChain[];
  ci: { runId: string; sha: string; since: number }[];
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
  /** What each unfinished run does, kept so it can start again after a restart. */
  private readonly plans = new Map<string, { plan: Plan; first: boolean }>();
  private readonly ciWatches = new Map<string, { sha: string; since: number }>();
  /** The app is quitting: runs stop, and nothing new starts or gets reported. */
  private stopping = false;
  private changeTimer?: NodeJS.Timeout;
  private resumeTimer?: NodeJS.Timeout;

  constructor(private readonly options: RunnerOptions) {
    for (const run of loadHistory(options.historyPath)) this.runs.set(run.id, run);
    const restored = this.restore(loadState(this.statePath()));
    const resumes = [...this.runs.values()].flatMap((r) => (r.resumeAt ? [r.resumeAt] : []));
    if (resumes.length) {
      this.pausedUntil = Math.max(...resumes);
      this.scheduleResume();
    } else if (restored) setTimeout(() => this.drain(), RESTORE_DELAY_MS);
  }

  /**
   * Picks up what the app was doing when it closed: queued tickets wait again, agents that
   * had started resume their session, epics and checks carry on. True when anything did.
   */
  private restore(state: RunnerState): boolean {
    const project = (id: string) => {
      try {
        return this.options.workspace.get(id);
      } catch {
        return undefined;
      }
    };
    for (const { runId, plan, first } of state.plans) {
      const run = this.runs.get(runId);
      const where = run && project(run.projectId);
      if (!run || !where) continue;
      if (run.agentStarted && run.branch) {
        run.resumeAt ??= Date.now();
        this.log(run, "the app closed while the agent worked: it picks the ticket up again");
      } else {
        Object.assign(run, { status: "queued", error: undefined, endedAt: undefined });
        this.waiting.set(run.id, { project: where, plan, first });
        this.plans.set(run.id, { plan, first });
        this.log(run, "back in the queue after the app restarted");
      }
    }
    for (const chain of state.epics) this.epics.set(`${chain.projectId}:${chain.epicKey}`, chain);
    for (const { runId, sha, since } of state.ci) {
      const run = this.runs.get(runId);
      const where = run && project(run.projectId);
      if (run && where) this.watchCi(run, where, sha, since);
    }
    return state.plans.length + state.epics.length > 0;
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
      model: model || (options.planOnly ? PLAN_MODEL : projectModel(project)),
      from: options.from,
      planOnly: options.planOnly || undefined,
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
      from: previous.from,
      planOnly: previous.planOnly,
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
    this.plans.set(run.id, { plan, first });
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
    if (this.stopping || this.pausedUntil > Date.now()) return;
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

  /**
   * On quit: agents must not keep running without the app watching them. What they were
   * doing is kept first, so the next launch picks it up.
   */
  stopAll(): void {
    const state = this.state();
    this.stopping = true;
    clearTimeout(this.resumeTimer);
    for (const timer of this.ciTimers.values()) clearTimeout(timer);
    for (const run of this.runs.values()) if (isActiveRun(run)) this.cancel(run.id);
    this.save(state);
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
      fresh: plan.kind === "new",
    });
    if (note) this.log(run, note);
    this.check(run);
    const startCommit = await headCommit(run.worktree);

    // Breaking a ticket down is not working on it.
    if (issue.statusCategory !== "indeterminate" && !run.planOnly)
      await this.move(run, tracker, "start");

    const prompt =
      plan.kind === "new"
        ? buildPrompt(issue, project, {
            branch: run.branch,
            base: start,
            existing,
            earlier: plan.earlier,
            planOnly: run.planOnly,
          })
        : buildContinuePrompt(
            issue,
            project,
            run.branch,
            plan.instruction,
            plan.includeReview ? await this.review(run, project) : [],
            run.planOnly,
          );
    run.status = "running";
    this.changed();
    await this.note(
      run,
      tracker,
      run.planOnly && plan.kind === "new"
        ? "An agent is breaking this ticket into tickets."
        : plan.kind === "new"
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
      // Closing the app stops agents only until the next launch.
      if (this.stopping) throw err;
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
    const created = await this.createTickets(run, tracker, run.planOnly ? run.issueKey : undefined);
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

    // A planning run changes no file: its tickets are all it hands back.
    if (run.planOnly) {
      await this.note(run, tracker, report());
      return this.finish(run, "done");
    }
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
    if (run.from) await this.bringIn(run, run.from, tracker, auth);
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
    await this.syncDependents(run, project);
  }

  /**
   * Merges the latest of the branch this one was built on: an epic's earlier ticket may
   * have been fixed (review, failing checks) since. A conflict is left to the person.
   */
  private async bringIn(
    run: RunView,
    from: string,
    tracker: IssueTracker,
    auth: GitAuth,
  ): Promise<boolean> {
    const outcome = await mergeFrom(run.worktree, from, auth);
    if (outcome === "merged") this.log(run, `brought in the latest commits of ${from}`);
    if (outcome === "conflict") {
      this.log(run, `${from} changed since, and merging it conflicts: left to you`);
      await this.note(
        run,
        tracker,
        `${from}, which this branch is built on, changed since, and merging it into ${run.branch} conflicts. Merge it by hand, or continue the agent asking it to merge origin/${from}.`,
      );
    }
    return outcome === "merged";
  }

  /**
   * The run pushed its branch: the epic's tickets built on it, done already, get the new
   * commits too, so a fix made here reaches them (and the ones built on them). A ticket
   * whose agent is still at work gets them before its own push.
   */
  private async syncDependents(run: RunView, project: Project): Promise<void> {
    const tracker = this.options.accounts.tracker(project);
    const auth = this.options.accounts.git(project.repo.provider).gitAuth();
    const dependents = this.list().filter(
      (r) =>
        r.projectId === run.projectId &&
        r.issueKey !== run.issueKey &&
        r.from === run.branch &&
        r.pullRequestUrl &&
        !isActiveRun(r) &&
        this.latest(r) === r,
    );
    for (const next of dependents) {
      try {
        if (!existsSync(join(next.worktree, ".git"))) continue;
        const branch = await git(["branch", "--show-current"], { cwd: next.worktree });
        if (
          branch !== next.branch ||
          (await git(["status", "--porcelain"], { cwd: next.worktree }))
        )
          continue;
        // Up to date with its own branch on origin first: someone may have pushed to it.
        await git(["fetch", "origin", next.branch], { cwd: next.worktree, auth });
        await git(["merge", "--ff-only", "-q", `origin/${next.branch}`], { cwd: next.worktree });
        if (!(await this.bringIn(next, run.branch, tracker, auth))) continue;
        await push(next.worktree, next.branch, auth);
        this.log(next, `pushed with the latest of ${run.branch} (${run.issueKey})`);
        this.watchCi(next, project, await headCommit(next.worktree));
        await this.syncDependents(next, project);
      } catch (err) {
        this.log(next, `could not bring in the latest of ${run.branch}: ${message(err)}`);
      }
    }
  }

  /**
   * Follows the pull request's checks after a push. When they fail, the agent goes back on
   * its pull request with the failure, at most MAX_CI_FIXES times in a row.
   */
  private watchCi(run: RunView, project: Project, sha: string, since = Date.now()): void {
    const provider = this.options.accounts.git(project.repo.provider);
    run.ci = "pending";
    this.ciWatches.set(run.id, { sha, since });
    this.changed();
    const check = async (): Promise<void> => {
      this.ciTimers.delete(run.id);
      if (run.ci !== "pending") this.ciWatches.delete(run.id);
      // A newer run on the ticket pushed again: its own watch takes over.
      if (this.latest(run) !== run) return void this.ciWatches.delete(run.id);
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
        this.ciWatches.delete(run.id);
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
          this.ciWatches.delete(run.id);
          this.log(run, "checks still running after 45 minutes: no longer followed");
        }
        return;
      }
      run.ci = report.state;
      this.ciWatches.delete(run.id);
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
  private async createTickets(
    run: RunView,
    tracker: IssueTracker,
    parent?: string,
  ): Promise<CreatedTicket[]> {
    const drafts = takeTicketDrafts(run.worktree);
    if (!drafts?.length) return [];
    const created: CreatedTicket[] = [];
    try {
      await createTickets(
        tracker,
        drafts,
        (t) => {
          created.push(t);
          this.log(run, `ticket created: ${t.key} ${t.summary}`);
        },
        parent,
      );
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
      this.log(run, moved ? `ticket â†’ ${moved}` : `${skipped}: ticket left as is`);
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
      // A planning run can't ask for more: whatever its tools don't allow is refused.
      run.planOnly ? "dontAsk" : project.agent.permissionMode,
      // What the mode doesn't allow on its own is asked here, on stdin/stdout, and answered
      // by the person from the office. The prompt goes in as a stream-json message.
      "--input-format",
      "stream-json",
      "--permission-prompts",
      "host",
      "--permission-prompt-tool",
      "stdio",
    ];
    // Reading the code, and writing the tickets file only.
    if (run.planOnly)
      args.push("--tools", "Read,Grep,Glob,Write", "--allowedTools", `Edit(./${TICKETS_DIR}/**)`);
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
    // Quitting: the run starts again on the next launch, its epic with it.
    if (this.stopping) return;
    this.plans.delete(run.id);
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

  private state(): RunnerState {
    return {
      plans: [...this.plans].map(([runId, p]) => ({ runId, ...p })),
      epics: [...this.epics.values()],
      ci: [...this.ciWatches].map(([runId, w]) => ({ runId, ...w })),
    };
  }

  private statePath(): string | undefined {
    const path = this.options.historyPath;
    return path && join(dirname(path), "runner-state.json");
  }

  /** While quitting, only the final save (with the state from before the stop) is written. */
  private save(state?: RunnerState): void {
    if (this.stopping && !state) return;
    const path = this.options.historyPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeJson(path, [...this.runs.values()]);
      writeJson(this.statePath()!, state ?? this.state());
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
    return runs.slice(-RUN_LIMIT).map((saved) => {
      // Checks still followed come back from the runner state.
      const run = saved.ci === "pending" ? { ...saved, ci: undefined } : saved;
      return isActiveRun(run)
        ? {
            ...run,
            questions: [],
            status: "failed",
            endedAt: run.endedAt ?? Date.now(),
            error: "Interrupted: the app was closed",
          }
        : run;
    });
  } catch (err) {
    console.error(`[mypixelteam] could not read ${path}:`, err);
    return [];
  }
}

const EMPTY_STATE: RunnerState = { plans: [], epics: [], ci: [] };

function loadState(path: string | undefined): RunnerState {
  if (!path || !existsSync(path)) return EMPTY_STATE;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<RunnerState>;
    return {
      plans: Array.isArray(state.plans) ? state.plans : [],
      epics: Array.isArray(state.epics) ? state.epics : [],
      ci: Array.isArray(state.ci) ? state.ci : [],
    };
  } catch (err) {
    console.error(`[mypixelteam] could not read ${path}:`, err);
    return EMPTY_STATE;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
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
