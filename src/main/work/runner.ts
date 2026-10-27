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
  type AgentQuestion,
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
  describeRequest,
  permissionResponse,
  promptMessage,
  pullRequestBody,
  readPermissionRequest,
  readStreamLine,
  unsupportedResponse,
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
import type { IssueTracker } from "../integrations/trackers";
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

class Cancelled extends Error {}

/** What a run does: a ticket's first run, or the continuation of an earlier one. */
type Plan =
  | { kind: "new"; options: StartRunOptions }
  | { kind: "continue"; instruction: string; includeReview: boolean };

export class AgentRunner {
  private readonly runs = new Map<string, RunView>();
  private readonly children = new Map<string, ChildProcess>();
  /** Permission requests waiting for an answer, by run then question id. */
  private readonly requests = new Map<string, Map<string, PermissionRequest>>();
  private changeTimer?: NodeJS.Timeout;

  constructor(private readonly options: RunnerOptions) {
    for (const run of loadHistory(options.historyPath)) this.runs.set(run.id, run);
  }

  list(): RunView[] {
    return [...this.runs.values()].reverse();
  }

  bySession(sessionId: string): RunView | undefined {
    // A continued run shares its session with the earlier ones: the latest one is current.
    return this.list().find((run) => run.sessionId === sessionId);
  }

  start(projectId: string, issueKey: string, options: StartRunOptions = {}): RunView {
    if (!isIssueKey(issueKey)) throw new Error(`Not an issue key: ${issueKey}`);
    const project = this.options.workspace.get(projectId);
    const busy = [...this.runs.values()].find((r) => r.issueKey === issueKey && isActiveRun(r));
    if (busy) throw new Error(`An agent is already on ${issueKey}`);
    const run: RunView = {
      id: randomUUID(),
      projectId,
      issueKey,
      issueSummary: "",
      sessionId: randomUUID(),
      status: "preparing",
      branch: "",
      worktree: join(this.options.worktreesDir, projectId, issueSlug(issueKey)),
      startedAt: Date.now(),
      log: [],
    };
    return this.launch(run, project, { kind: "new", options });
  }

  /**
   * Resumes the agent's session of an earlier run, on the same branch and worktree, with a
   * new instruction and, if asked, the pull request's review comments.
   */
  continueRun(previousRunId: string, instruction: string, options: ContinueOptions = {}): RunView {
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
    const run: RunView = {
      id: randomUUID(),
      projectId: previous.projectId,
      issueKey: previous.issueKey,
      issueSummary: previous.issueSummary,
      sessionId: previous.sessionId,
      status: "preparing",
      branch: previous.branch,
      worktree: previous.worktree,
      startedAt: Date.now(),
      pullRequestUrl: previous.pullRequestUrl,
      continuedFrom: previous.id,
      instruction: instruction.trim() || undefined,
      log: [],
    };
    return this.launch(run, project, {
      kind: "continue",
      instruction,
      includeReview: Boolean(options.includeReview),
    });
  }

  private launch(run: RunView, project: Project, plan: Plan): RunView {
    this.runs.set(run.id, run);
    this.trim();
    this.changed();
    void this.execute(run, project, plan).catch((err) => {
      const cancelled = err instanceof Cancelled || run.status === "cancelled";
      this.finish(run, cancelled ? "cancelled" : "failed", cancelled ? undefined : err);
    });
    return run;
  }

  cancel(id: string): void {
    const run = this.runs.get(id);
    if (!run || !isActiveRun(run)) return;
    run.status = "cancelled";
    this.log(run, "cancelled");
    const child = this.children.get(id);
    if (child?.pid) killTree(child.pid);
    this.changed();
  }

  /** On quit: agents must not keep running without the app watching them. */
  stopAll(): void {
    for (const run of this.runs.values()) this.cancel(run.id);
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
    if (plan.kind === "new") run.branch = options.branch ?? branchName(issue.key, issue.summary);
    const existing = onOrigin.includes(run.branch);
    this.log(
      run,
      existing
        ? `worktree on the existing branch ${run.branch}`
        : `worktree on ${run.branch}, from ${base}`,
    );
    const note = await prepareWorktree({
      repoPath: project.localPath,
      worktree: run.worktree,
      branch: run.branch,
      base,
      auth,
      existing,
    });
    if (note) this.log(run, note);
    this.check(run);
    const startCommit = await headCommit(run.worktree);

    if (issue.statusCategory !== "indeterminate") await this.move(run, tracker, "start");

    const prompt =
      plan.kind === "new"
        ? buildPrompt(issue, project, { branch: run.branch, base, existing })
        : buildContinuePrompt(
            issue,
            project,
            run.branch,
            plan.instruction,
            plan.includeReview ? await this.review(run, project) : [],
          );
    run.status = "running";
    this.changed();
    const result = await this.agent(run, project, prompt, plan.kind === "continue");
    this.check(run);
    run.result = result.text;
    run.costUsd = result.costUsd;
    if (result.isError) throw new Error(result.text || "The agent stopped with an error");

    run.status = "publishing";
    this.changed();
    const committed = await commitAll(run.worktree, tracker.title(issue));
    if (committed) this.log(run, "changes committed");
    if (!project.agent.openPullRequest) return this.finish(run, "done");
    // An existing branch may hold colleagues' commits: publish only what is new.
    const moved = (await headCommit(run.worktree)) !== startCommit;
    if (!moved && (await unpublishedCommits(run.worktree, run.branch, base)) === 0) {
      this.log(run, "no changes to publish");
      return this.finish(run, "done");
    }
    await push(run.worktree, run.branch, auth);
    this.log(run, "branch pushed");
    run.pullRequestUrl = await provider.pullRequest(project.repo.fullName, {
      title: tracker.title(issue),
      body: pullRequestBody(tracker.pullRequestReference(issue), result.text),
      head: run.branch,
      base,
    });
    this.log(run, `pull request: ${run.pullRequestUrl}`);
    await this.move(run, tracker, "review");
    // A GitHub issue already lists the pull request that closes it.
    if (tracker.kind === "jira")
      await tracker
        .comment(
          issue.key,
          `${plan.kind === "new" ? "An agent opened a pull request" : "An agent updated the pull request"}: ${run.pullRequestUrl}\n\n${result.text}`,
        )
        .catch((err) => this.log(run, `could not comment on the ticket: ${message(err)}`));
    this.finish(run, "done");
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
    if (project.agent.model) args.push("--model", project.agent.model);

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
      isActiveRun(run)
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

/** Stops the agent and whatever commands it started. */
function killTree(pid: number): void {
  if (process.platform === "win32")
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else process.kill(pid, "SIGTERM");
}
