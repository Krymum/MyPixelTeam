import type { AgentRecord } from "../../shared/engine/office-state";
import type { RunView } from "../../shared/work/types";
import { button, el, formatDuration, link } from "./dom";

/** Side panel with the details and recent timeline of the selected agent. */
export function renderPanel(
  panel: HTMLElement,
  agent: AgentRecord | undefined,
  parentName: string | undefined,
  onClose: () => void,
  /** Set when the app started this agent on a Jira ticket. */
  run?: { view: RunView; openIssue: () => void },
): void {
  panel.hidden = !agent;
  if (!agent) return;

  const close = el("button", "✕", "close");
  close.title = "Close";
  close.addEventListener("click", onClose);

  const facts: [string, string][] = [
    ["source", agent.source],
    ["role", agent.role],
    ["status", agent.status],
    ["session", agent.sessionId],
    ["on duty", formatDuration(Date.now() - agent.startedAt)],
  ];
  if (parentName) facts.push(["parent", parentName]);
  if (agent.cwd) facts.push(["cwd", agent.cwd]);

  const dl = el("dl");
  for (const [k, v] of facts) dl.append(el("dt", k), el("dd", v));
  if (run) {
    const ticket = el("dd");
    ticket.append(button(`${run.view.issueKey} · ${run.view.issueSummary}`, run.openIssue, "link"));
    dl.append(el("dt", "ticket"), ticket, el("dt", "run"), el("dd", run.view.status));
    if (run.view.pullRequestUrl) {
      const dd = el("dd");
      dd.append(link("pull request", run.view.pullRequestUrl));
      dl.append(el("dt", "PR"), dd);
    }
  }

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

  panel.replaceChildren(close, el("h2", agent.name), dl, el("h3", "Timeline"), ol);
}
