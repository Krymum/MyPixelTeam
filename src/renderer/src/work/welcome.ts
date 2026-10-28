import type { CheckResult } from "../../../shared/work/types";
import { busy, button, el, link } from "../dom";
import { t, tn } from "../i18n";
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

const stepNames = () => [t("Your machine"), t("Your accounts"), t("Your projects"), t("Ready")];

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
  stepNames().forEach((name, i) => {
    const li = el("li", `${i + 1}. ${name}`);
    if (i === step) li.className = "current";
    else if (i < step) li.className = "done";
    steps.append(li);
  });
  const skip = button(t("Skip the guide"), () => finish(false), "link");
  const body = [machineStep, accountsStep, projectsStep, readyStep][step]!();
  dialog.replaceChildren(el("h2", t("Set up your agent team")), steps, body, skip);
}

function nav(back: boolean, next?: HTMLButtonElement): HTMLElement {
  const actions = el("div", undefined, "actions");
  if (back) actions.append(button(`← ${t("Back")}`, () => go(step - 1)));
  if (next) actions.append(next);
  return actions;
}

const FIXES = {
  git: () => {
    const p = el("p", `${t("Agents use git to work on their own branch.")} `);
    p.append(link(t("Install git"), "https://git-scm.com/downloads"), t(", then check again."));
    return p;
  },
  claude: () => {
    const p = el("p", `${t("Agents are Claude Code sessions. Install it, in PowerShell:")} `);
    p.append(
      el("code", "irm https://claude.ai/install.ps1 | iex"),
      " (",
      link(t("other ways"), "https://docs.anthropic.com/en/docs/claude-code/setup"),
      t("). Installed somewhere unusual? Set AGENT_OFFICE_CLAUDE to its path and restart."),
    );
    return p;
  },
  claudeAuth: () => {
    const p = el("p", `${t("Open a terminal, run")} `);
    p.append(el("code", "claude auth login"), ` ${t("and sign in, then check again.")}`);
    return p;
  },
};

function machineStep(): HTMLElement {
  const section = el("section");
  const status = el("p", "", "status");
  const list = el("div", undefined, "checks");
  const showChecks = () => {
    const env = work.environment;
    if (!env) return void list.replaceChildren(el("p", t("Checking…"), "muted"));
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
      row(t("Signed in to Claude"), env.claudeAuth, FIXES.claudeAuth),
    );
  };
  const again = button(
    t("Check again"),
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
    button(`${t("Next")} →`, () => go(1), "primary"),
  );
  actions.prepend(again);
  section.append(
    el("p", t("Agents run on this computer, with your Claude Code subscription."), "muted"),
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
      t("Connect only what you use. GitHub alone is enough: agents then work on its issues."),
      "muted",
    ),
    ...(["github", "bitbucket", "jira"] as const).map((p) => accountCard(p, render)),
  );
  if (connected("bitbucket") && !connected("github") && !connected("jira"))
    section.append(el("p", t("Bitbucket projects need Jira for their tickets."), "bad"));
  const next = button(`${t("Next")} →`, () => go(2), "primary");
  next.disabled = !ready;
  if (!ready) next.title = t("Connect GitHub or Bitbucket first");
  section.append(nav(true, next));
  return section;
}

function projectsStep(): HTMLElement {
  const section = el("section");
  const count = work.workspace.projects.length;
  if (count)
    section.append(
      el("p", tn(count, "You already have {n} project.", "You already have {n} projects."), "ok"),
    );
  section.append(discoveryPanel(() => go(3)));
  const next = button(count ? `${t("Next")} →` : t("Later"), () => go(3));
  section.append(nav(true, next));
  return section;
}

function readyStep(): HTMLElement {
  const section = el("section");
  const projects = work.workspace.projects;
  const lines = projects.length
    ? [
        t("Your team can work on {projects}.", {
          projects: projects.map((p) => p.name).join(", "),
        }),
        t(
          "Open Tickets, pick a ticket and press ▶ Put an agent on it. The agent walks in, works in its own branch and opens a pull request.",
        ),
        t(
          "You'll get a notification when it is done. Agents may only edit files by default: allow commands per project in Settings.",
        ),
      ]
    : [t("No project yet. You can find your projects later in Settings → Find my projects.")];
  section.append(...lines.map((l) => el("p", l)));
  section.append(
    nav(
      true,
      button(
        projects.length ? t("Open tickets") : t("Close"),
        () => finish(projects.length > 0),
        "primary",
      ),
    ),
  );
  return section;
}
