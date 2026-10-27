import type { RunView } from "../../../shared/work/types";
import { busy, button, el, input } from "../dom";

/**
 * What a waiting agent asks, with Allow and Deny. The agent is paused until it gets an
 * answer; a refusal's reason is passed on so it can do something else.
 */

const api = () => window.office.work;

/** Reasons being typed, kept across redraws (runs refresh while the person types). */
const drafts = new Map<string, string>();

export function questionsBox(run: RunView): HTMLElement | undefined {
  const questions = run.questions ?? [];
  if (!questions.length) return undefined;
  const box = el("div", undefined, "questions");
  for (const q of questions) {
    const card = el("div", undefined, "question");
    const status = el("p", "", "status");
    const reason = input(drafts.get(q.id) ?? "", "Reason if you refuse (sent to the agent)");
    reason.addEventListener("input", () => drafts.set(q.id, reason.value));
    const answer = (allow: boolean) =>
      void busy(undefined, status, async () => {
        await api().answerQuestion(run.id, q.id, allow, allow ? undefined : reason.value);
        drafts.delete(q.id);
      });
    const actions = el("div", undefined, "actions");
    actions.append(
      button("Allow", () => answer(true), "primary"),
      button("Deny", () => answer(false), "danger"),
    );
    card.append(el("strong", `✋ ${run.issueKey} asks to use ${q.tool}`));
    if (q.reason) card.append(el("div", q.reason, "muted"));
    card.append(el("pre", q.detail, "log"), reason, actions, status);
    box.append(card);
  }
  return box;
}

export const waitingRuns = (runs: RunView[]): RunView[] =>
  runs.filter((r) => (r.questions?.length ?? 0) > 0);
