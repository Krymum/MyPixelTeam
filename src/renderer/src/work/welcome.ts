import type { CheckResult } from "../../../shared/work/types";
import { busy, button, el, link } from "../dom";
import { accountCard } from "./accounts-ui";
import { toggleBoard } from "./board";
import { discoveryPanel } from "./discovery";
import { hooksCard } from "./hooks-ui";
import { connected, update, work } from "./store";

/**
 * Setup guide, shown on first launch: check the machine, connect the accounts, pick the
 * projects. Reachable later from Settings and from the warning in the top bar.
 */

const api = () => window.office.work;

const STEPS = ["Your machine", "Your accounts", "Your projects", "Ready"] as const;

let dialog: HTMLDialogElement;
let step = 0;
let marking = false;

export function initWelcome(node: HTMLDialogElement): void {
  dialog = node;
  // Esc or ✕ counts as "seen": the guide doesn't come back on its own.
  dialog.addEventListener("close", () => void markOnboarded());
}

export function openWelcome(at = 0): void {
  step = at;
  render();
  if (!dialog.open) dialog.showModal();
}

/** Re-runs the machine check and shares the result with the top bar. */
export async function checkMachine(): Promise<void> {
  update({ environment: await api().checkEnvironment() });
}

async function markOnboarded(): Promise<void> {
  if (work.workspace.onboarded || marking) return;
  marking = true;
  update({ workspace: await api().setPreferences({ onboarded: true }) });
}

function finish(openBoard: boolean): void {
  dialog.close();
  if (openBoard) toggleBoard(true);
}

function go(to: number): void {
  step = to;
  render();
}

function render(): void {
  const steps = el("ol", undefined, "steps");
  STEPS.forEach((name, i) => {
    const li = el("li", `${i + 1}. ${name}`);
    if (i === step) li.className = "current";
    else if (i < step) li.className = "done";
    steps.append(li);
  });
  const skip = button("Skip the guide", () => finish(false), "link");
  const body = [machineStep, accountsStep, projectsStep, readyStep][step]!();
  dialog.replaceChildren(el("h2", "Set up your agent team"), steps, body, skip);
}

function nav(back: boolean, next?: HTMLButtonElement): HTMLElement {
  const actions = el("div", undefined, "actions");
  if (back) actions.append(button("← Back", () => go(step - 1)));
  if (next) actions.append(next);
  return actions;
}

const FIXES = {
  git: () => {
    const p = el("p", "Agents use git to work on their own branch. ");
    p.append(link("Install git", "https://git-scm.com/downloads"), ", then check again.");
    return p;
  },
  claude: () => {
    const p = el("p", "Agents are Claude Code sessions. Install it, in PowerShell: ");
    p.append(
      el("code", "irm https://claude.ai/install.ps1 | iex"),
      " (",
      link("other ways", "https://docs.anthropic.com/en/docs/claude-code/setup"),
      "). Installed somewhere unusual? Set AGENT_OFFICE_CLAUDE to its path and restart.",
    );
    return p;
  },
  claudeAuth: () => {
    const p = el("p", "Open a terminal, run ");
    p.append(el("code", "claude auth login"), " and sign in, then check again.");
    return p;
  },
};

function machineStep(): HTMLElement {
  const section = el("section");
  const status = el("p", "", "status");
  const list = el("div", undefined, "checks");
  const showChecks = () => {
    const env = work.environment;
    if (!env) return void list.replaceChildren(el("p", "Checking…", "muted"));
    const row = (label: string, result: CheckResult, fix: () => HTMLElement) => {
      const div = el("div", undefined, `check-row ${result.ok ? "ok" : "bad"}`);
      div.append(
        el("strong", `${result.ok ? "✓" : "✗"} ${label}`),
        el("span", result.detail, "muted"),
      );
      if (!result.ok) div.append(fix());
      return div;
    };
    list.replaceChildren(
      row("git", env.git, FIXES.git),
      row("Claude Code", env.claude, FIXES.claude),
      row("Signed in to Claude", env.claudeAuth, FIXES.claudeAuth),
    );
  };
  const again = button(
    "Check again",
    () =>
      void busy(again, status, async () => {
        update({ environment: undefined });
        showChecks();
        await checkMachine();
        showChecks();
      }),
  );
  showChecks();
  if (!work.environment) void busy(undefined, status, checkMachine).then(showChecks);
  const actions = nav(
    false,
    button("Next →", () => go(1), "primary"),
  );
  actions.prepend(again);
  section.append(
    el("p", "Agents run on this computer, with your Claude Code subscription.", "muted"),
    list,
    hooksCard(),
    actions,
    status,
  );
  return section;
}

function accountsStep(): HTMLElement {
  const section = el("section");
  const ready = connected("github") || connected("bitbucket");
  section.append(
    el(
      "p",
      "Connect only what you use. GitHub alone is enough: agents then work on its issues.",
      "muted",
    ),
    ...(["github", "bitbucket", "jira"] as const).map((p) => accountCard(p, render)),
  );
  if (connected("bitbucket") && !connected("github") && !connected("jira"))
    section.append(el("p", "Bitbucket projects need Jira for their tickets.", "bad"));
  const next = button("Next →", () => go(2), "primary");
  next.disabled = !ready;
  if (!ready) next.title = "Connect GitHub or Bitbucket first";
  section.append(nav(true, next));
  return section;
}

function projectsStep(): HTMLElement {
  const section = el("section");
  const count = work.workspace.projects.length;
  if (count)
    section.append(el("p", `You already have ${count} project${count > 1 ? "s" : ""}.`, "ok"));
  section.append(discoveryPanel(() => go(3)));
  const next = button(count ? "Next →" : "Later", () => go(3));
  section.append(nav(true, next));
  return section;
}

function readyStep(): HTMLElement {
  const section = el("section");
  const projects = work.workspace.projects;
  const lines = projects.length
    ? [
        `Your team can work on ${projects.map((p) => p.name).join(", ")}.`,
        "Open Tickets, pick a ticket and press ▶ Put an agent on it. The agent walks in, works in its own branch and opens a pull request.",
        "You'll get a notification when it is done. Agents may only edit files by default: allow commands per project in Settings.",
      ]
    : ["No project yet. You can find your projects later in Settings → Find my projects."];
  section.append(...lines.map((l) => el("p", l)));
  section.append(
    nav(
      true,
      button(
        projects.length ? "Open tickets" : "Close",
        () => finish(projects.length > 0),
        "primary",
      ),
    ),
  );
  return section;
}
