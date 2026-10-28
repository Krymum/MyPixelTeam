import { isActiveRun, MAX_CI_FIXES, type RunView } from "./types";

/**
 * What a ticket's agents are up to, said in a word, and what waits for the person. Both
 * read the ticket's latest run only: older runs are history.
 */

export type Tone = "working" | "waiting" | "attention" | "good" | "quiet";

export interface TicketState {
  label: string;
  tone: Tone;
}

export type NeedKind = "question" | "failed" | "budget" | "checks" | "review";

export interface Need {
  run: RunView;
  kind: NeedKind;
  /** What to do about it, in a few words. */
  label: string;
}

const ticketId = (run: RunView): string => `${run.projectId}:${run.issueKey}`;

/** Each ticket's most recent run, newest tickets first (runs come newest first). */
export function latestRuns(runs: RunView[]): RunView[] {
  const latest = new Map<string, RunView>();
  for (const run of runs) if (!latest.has(ticketId(run))) latest.set(ticketId(run), run);
  return [...latest.values()];
}

/** The Claude usage limit stopped it: not a failure of the agent. */
export const isLimitStop = (run: RunView): boolean =>
  /session limit|usage limit|hit your .*limit/i.test(run.error ?? "");

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function ticketState(run: RunView): TicketState {
  if (run.questions?.length) return { label: "Asks you", tone: "attention" };
  if (run.status === "queued") return { label: "Waiting for a desk", tone: "waiting" };
  if (isActiveRun(run))
    return { label: run.planOnly ? "Planning" : "Agent working", tone: "working" };
  if (run.resumeAt)
    return {
      label: run.resumeAt > Date.now() ? `Paused until ${clock(run.resumeAt)}` : "Resuming",
      tone: "waiting",
    };
  if (run.status === "failed") {
    if (run.stoppedOnBudget) return { label: "Out of budget", tone: "attention" };
    if (isLimitStop(run)) return { label: "Usage limit", tone: "attention" };
    return { label: "Failed", tone: "attention" };
  }
  if (run.status === "cancelled") return { label: "Stopped", tone: "quiet" };
  if (run.ci === "failure") return { label: "Checks failed", tone: "attention" };
  if (run.ci === "pending") return { label: "Checks running", tone: "working" };
  if (run.pullRequestUrl)
    return { label: run.ci === "success" ? "Ready to review" : "Pull request", tone: "good" };
  return { label: run.planOnly ? "Planned" : "Done", tone: "quiet" };
}

/**
 * What waits for the person, most pressing first: questions block an agent, failures and
 * red checks stop a ticket, pull requests wait for a review. `dismissed` holds run ids the
 * person already dealt with.
 */
export function needsYou(runs: RunView[], dismissed: ReadonlySet<string> = new Set()): Need[] {
  const needs: Need[] = [];
  for (const run of latestRuns(runs)) {
    if (run.questions?.length) {
      needs.push({ run, kind: "question", label: `Asks to use ${run.questions[0]!.tool}` });
      continue;
    }
    if (isActiveRun(run) || run.resumeAt || dismissed.has(run.id)) continue;
    if (run.status === "failed")
      needs.push(
        run.stoppedOnBudget
          ? { run, kind: "budget", label: `Ran out of its $${run.budgetUsd} budget` }
          : {
              run,
              kind: "failed",
              label: isLimitStop(run) ? "Stopped by the usage limit" : "Failed",
            },
      );
    else if (run.status === "done" && run.ci === "failure")
      needs.push({
        run,
        kind: "checks",
        label:
          (run.ciFixes ?? 0) >= MAX_CI_FIXES
            ? `Checks still failing after ${MAX_CI_FIXES} fixes`
            : "Checks failed",
      });
    else if (run.status === "done" && run.pullRequestUrl && run.ci !== "pending")
      needs.push({ run, kind: "review", label: "Pull request to review" });
  }
  const order: NeedKind[] = ["question", "failed", "budget", "checks", "review"];
  return needs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
