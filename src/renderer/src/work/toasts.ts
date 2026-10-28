import { isLimitStop } from "../../../shared/work/run-state";
import type { RunView } from "../../../shared/work/types";
import { button, el, link } from "../dom";
import { t } from "../i18n";
import { showIssue } from "./board";
import { subscribe, work } from "./store";

/**
 * A short word in the corner when an agent gets somewhere: a pull request opened, checks
 * passed, or a ticket stopped. Runs already finished when the app opens say nothing.
 */

const SHOW_MS = 7000;

let stack: HTMLElement;
/** What each run was at the last update, to tell what just changed. */
const seen = new Map<string, Pick<RunView, "status" | "ci">>();
let ready = false;

export function initToasts(): void {
  stack = el("div", undefined, "toasts");
  stack.setAttribute("role", "status");
  document.body.append(stack);
  subscribe(() => {
    for (const run of work.runs) {
      const before = seen.get(run.id);
      seen.set(run.id, { status: run.status, ci: run.ci });
      if (ready && before) announce(run, before);
    }
    // The first list is the past: only changes after it are news.
    if (work.runs.length) ready = true;
  });
}

function announce(run: RunView, before: Pick<RunView, "status" | "ci">): void {
  const open = () => void showIssue(run.projectId, run.issueKey);
  if (before.status !== "done" && run.status === "done") {
    if (run.pullRequestUrl)
      return toast(
        "good",
        t("{key} opened a pull request", { key: run.issueKey }),
        run.issueSummary,
        {
          label: t("Review it"),
          href: run.pullRequestUrl,
        },
      );
    return toast(
      "good",
      run.planOnly
        ? t("{key} is broken down", { key: run.issueKey })
        : t("{key} is done", { key: run.issueKey }),
      run.issueSummary,
      {
        label: t("Open"),
        onClick: open,
      },
    );
  }
  if (before.ci === "pending" && run.ci === "success")
    return toast("good", t("{key}: checks passed", { key: run.issueKey }), run.issueSummary, {
      label: t("Review it"),
      href: run.pullRequestUrl,
    });
  if (before.status !== "failed" && run.status === "failed" && !run.resumeAt && !isLimitStop(run))
    toast("bad", t("{key} stopped", { key: run.issueKey }), run.error ?? run.issueSummary, {
      label: t("Open"),
      onClick: open,
    });
}

function toast(
  tone: "good" | "bad",
  title: string,
  text: string,
  action: { label: string; href?: string; onClick?: () => void },
): void {
  const card = el("div", undefined, `toast ${tone}`);
  const body = el("div", undefined, "toast-body");
  body.append(el("strong", title), el("span", text, "muted"));
  const close = button("✕", () => card.remove(), "close");
  close.title = t("Close");
  card.append(body);
  if (action.href) card.append(link(action.label, action.href));
  else if (action.onClick)
    card.append(
      button(
        action.label,
        () => {
          action.onClick!();
          card.remove();
        },
        "link",
      ),
    );
  card.append(close);
  stack.append(card);
  // Hovering keeps it, so it can still be clicked.
  let timer = setTimeout(() => card.remove(), SHOW_MS);
  card.addEventListener("mouseenter", () => clearTimeout(timer));
  card.addEventListener("mouseleave", () => (timer = setTimeout(() => card.remove(), SHOW_MS)));
}
