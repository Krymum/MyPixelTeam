import type { AgentRecord } from "../../shared/engine/office-state";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Side panel with the details and recent timeline of the selected agent. */
export function renderPanel(
  panel: HTMLElement,
  agent: AgentRecord | undefined,
  parentName: string | undefined,
  onClose: () => void,
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
