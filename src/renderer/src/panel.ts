import type { AgentRecord } from "../../shared/engine/office-state";
import { ticketState } from "../../shared/work/run-state";
import type { RunView } from "../../shared/work/types";
import { button, el, formatDuration, link } from "./dom";

/**
 * Side panel of the selected character: for an agent of the app, its ticket and what it is
 * doing; for any session, its recent timeline. Session details stay folded.
 */
export function renderPanel(
  panel: HTMLElement,
  agent: AgentRecord | undefined,
  parentName: string | undefined,
  onClose: () => void,
  /** Set when the app put this agent on a ticket. */
  run?: { view: RunView; openIssue: () => void },
): void {
  panel.hidden = !agent;
  if (!agent) return;

  const close = el("button", "✕", "close");
  close.title = "Close";
  close.addEventListener("click", onClose);

  const top: HTMLElement[] = [];
  if (run) {
    const { view } = run;
    const state = ticketState(view);
    const ticket = el("div", undefined, "panel-ticket");
    ticket.append(
      button(`${view.issueKey} · ${view.issueSummary}`, run.openIssue, "link"),
      el("span", state.label, `chip ${state.tone}`),
    );
    top.push(ticket);
    const waiting = view.questions?.[0];
    // Answered on the ticket: this panel redraws every second, which would eat typing.
    if (waiting) top.push(button(`✋ ${waiting.summary}. Answer…`, run.openIssue, "primary"));
    if (view.pullRequestUrl) top.push(link("Open the pull request", view.pullRequestUrl));
  }

  const facts: [string, string][] = [
    ["status", agent.status],
    ["on duty", formatDuration(Date.now() - agent.startedAt)],
    ["role", agent.role],
    ["source", agent.source],
    ["session", agent.sessionId],
  ];
  if (parentName) facts.push(["parent", parentName]);
  if (agent.cwd) facts.push(["folder", agent.cwd]);
  const dl = el("dl");
  for (const [k, v] of facts) dl.append(el("dt", k), el("dd", v));
  const details = el("details", undefined, "session-details");
  details.append(el("summary", "Session details"), dl);

  const ol = el("ol");
  for (const e of [...agent.history].reverse().slice(0, 30)) {
    const li = el("li");
    const time = el("time", new Date(e.timestamp).toLocaleTimeString());
    const text = [e.type.replace(/^(sub)?agent\./, ""), e.detail.summary ?? e.detail.message]
      .filter(Boolean)
      .join(" · ");
    li.append(time, text);
    ol.append(li);
  }

  // Kept open across the redraws of every second.
  const wasOpen = panel.querySelector<HTMLDetailsElement>(".session-details")?.open ?? false;
  details.open = wasOpen;
  panel.replaceChildren(
    close,
    el("h2", run ? run.view.issueKey : agent.name),
    ...top,
    details,
    el("h3", "What it did"),
    ol,
  );
}
