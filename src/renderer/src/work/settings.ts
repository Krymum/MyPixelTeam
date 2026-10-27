import {
  MAX_AGENTS,
  MAX_CI_FIXES,
  trackerLabel,
  type GitProviderId,
  type JiraProject,
  type PermissionMode,
  type Project,
  type ProjectInput,
  type RepoRef,
  type RepoSummary,
} from "../../../shared/work/types";
import { busy, button, el, field, input, select, textarea } from "../dom";
import { accountCard, PROVIDER_NAMES } from "./accounts-ui";
import { discoveryPanel } from "./discovery";
import { hooksCard } from "./hooks-ui";
import { MODEL_HINT, modelSelect } from "./model-ui";
import { connected, update, work } from "./store";
import { parseTracker, trackerOptions, trackerValue } from "./tracker-ui";
import { openWelcome } from "./welcome";

/** Settings dialog: connected accounts and the projects agents work on. */

const api = () => window.office.work;

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  acceptEdits: "Edit files freely, ask me before running commands",
  auto: "Auto mode: Claude Code judges each command, asks me when unsure",
  bypassPermissions: "Everything, unchecked (sandboxed machines only)",
};

let dialog: HTMLDialogElement;
/** Project being edited; null for a new one, undefined when the list is shown. */
let editing: Project | null | undefined;
/** Showing the repositories found on this machine. */
let discovering = false;

/** `"discover"` opens the list of repositories found on this machine. */
export function openSettings(projectId?: string | null | "discover"): void {
  discovering = projectId === "discover";
  editing = projectId === null ? null : work.workspace.projects.find((p) => p.id === projectId);
  render();
  if (!dialog.open) dialog.showModal();
}

export function initSettings(node: HTMLDialogElement): void {
  dialog = node;
  dialog.addEventListener("close", () => {
    editing = undefined;
    discovering = false;
  });
}

function render(): void {
  const close = button("✕", () => dialog.close(), "close");
  close.title = "Close";
  dialog.replaceChildren(
    close,
    el("h2", "Settings"),
    accountsSection(),
    discovering
      ? discoverySection()
      : editing === undefined
        ? projectsSection()
        : projectEditor(editing),
    preferencesSection(),
  );
}

function accountsSection(): HTMLElement {
  const section = el("section");
  section.append(el("h3", "Accounts"));
  if (!work.accounts.secureStorage)
    section.append(
      el("p", "This system offers no secure storage: accounts can't be saved.", "bad"),
    );
  for (const provider of ["jira", "github", "bitbucket"] as const)
    section.append(accountCard(provider, render));
  return section;
}

function projectsSection(): HTMLElement {
  const section = el("section");
  section.append(el("h3", "Projects"));
  const { projects } = work.workspace;
  if (!projects.length)
    section.append(
      el(
        "p",
        "A project is a repository and where its tickets live: its GitHub Issues, or a Jira project. Agents work on those tickets.",
        "muted",
      ),
    );
  for (const p of projects) {
    const row = el("div", undefined, "card row");
    const text = el("div");
    text.append(
      el("strong", p.name),
      el(
        "div",
        `${p.repo.fullName} (${PROVIDER_NAMES[p.repo.provider]}) · tickets: ${trackerLabel(p.tracker)}`,
        "muted",
      ),
    );
    row.append(
      text,
      button("Edit", () => openSettings(p.id)),
    );
    section.append(row);
  }
  const detect = button("Find my projects", () => openSettings("discover"), "primary");
  const add = button("+ New project", () => openSettings(null));
  for (const b of [detect, add]) {
    b.disabled = !(connected("github") || connected("bitbucket"));
    if (b.disabled) b.title = "Connect GitHub or Bitbucket first";
  }
  const actions = el("div", undefined, "actions");
  actions.append(detect, add);
  section.append(actions);
  return section;
}

function discoverySection(): HTMLElement {
  const section = el("section");
  section.append(
    el("h3", "Find my projects"),
    discoveryPanel(() => openSettings(undefined)),
    button("← Projects", () => openSettings(undefined)),
  );
  return section;
}

function preferencesSection(): HTMLElement {
  const section = el("section");
  const notify = input("", "", "checkbox");
  notify.checked = work.workspace.notifications;
  notify.addEventListener("change", async () => {
    update({ workspace: await api().setPreferences({ notifications: notify.checked }) });
  });
  const label = el("label", undefined, "check");
  label.append(notify, " Notify me when an agent finishes, fails or waits for me");
  const agents = select(
    Array.from({ length: MAX_AGENTS }, (_, i): [string, string] => [String(i + 1), String(i + 1)]),
    String(work.workspace.maxAgents),
  );
  agents.addEventListener("change", async () => {
    update({ workspace: await api().setPreferences({ maxAgents: Number(agents.value) }) });
  });
  const budget = select(
    [
      ["1", "$1"],
      ["2", "$2"],
      ["3", "$3"],
      ["5", "$5"],
      ["10", "$10"],
      ["0", "No limit"],
    ],
    String(work.workspace.runBudgetUsd),
  );
  budget.addEventListener("change", async () => {
    update({ workspace: await api().setPreferences({ runBudgetUsd: Number(budget.value) }) });
  });
  const fixCi = input("", "", "checkbox");
  fixCi.checked = work.workspace.fixCi;
  fixCi.addEventListener("change", async () => {
    update({ workspace: await api().setPreferences({ fixCi: fixCi.checked }) });
  });
  const fixCiLabel = el("label", undefined, "check");
  fixCiLabel.append(
    fixCi,
    ` When a pull request's checks fail, put its agent back on it (${MAX_CI_FIXES} times at most)`,
  );
  const commands = input("", "", "checkbox");
  commands.checked = work.workspace.commentCommands;
  commands.addEventListener("change", async () => {
    update({ workspace: await api().setPreferences({ commentCommands: commands.checked }) });
  });
  const commandsLabel = el("label", undefined, "check");
  commandsLabel.append(
    commands,
    " A comment starting with @agent on a ticket or its pull request puts its agent back on it",
  );
  const guide = button("Open the setup guide", () => {
    dialog.close();
    openWelcome();
  });
  section.append(
    el("h3", "Preferences"),
    field(
      "Agents working at once",
      agents,
      "More tickets wait their turn. Every agent draws on the same Claude quota, so several at once reach its limit sooner.",
    ),
    field(
      "Budget per run",
      budget,
      "An agent that reaches it stops and keeps its changes; continuing the run gives it the same budget again.",
    ),
    fixCiLabel,
    commandsLabel,
    label,
    hooksCard(),
    guide,
  );
  return section;
}

function projectEditor(project: Project | null): HTMLElement {
  const section = el("section");
  section.append(el("h3", project ? `Edit ${project.name}` : "New project"));
  const status = el("p", "", "status");

  const name = input(project?.name ?? "", "My product");
  const trackerSelect = select([]);
  let jiraProjects: JiraProject[] = [];
  const hosts = (["github", "bitbucket"] as const).filter(connected);
  const host = select(
    hosts.map((h) => [h, PROVIDER_NAMES[h]]),
    project?.repo.provider ?? hosts[0],
  );
  const repoInput = input(project?.repo.fullName ?? "", "owner/repository");
  const repoList = el("datalist");
  repoList.id = "repo-list";
  repoInput.setAttribute("list", repoList.id);
  const folder = input(project?.localPath ?? "", "");
  const baseBranch = input(project?.baseBranch ?? "", "");
  const browse = button("Browse…", async () => {
    const picked = await api().pickFolder();
    if (picked) folder.value = picked;
  });
  const folderRow = el("div", undefined, "inline");
  folderRow.append(folder, browse);
  const mode = select(
    Object.entries(PERMISSION_LABELS) as [string, string][],
    project?.agent.permissionMode ?? "acceptEdits",
  );
  const model = modelSelect(project?.agent.model);
  const instructions = textarea(project?.agent.instructions ?? "", 4);
  instructions.placeholder = "e.g. Run npm test before finishing. Write commit-ready code.";
  const openPr = input("", "", "checkbox");
  openPr.checked = project?.agent.openPullRequest ?? true;
  const prLabel = el("label", undefined, "check");
  prLabel.append(openPr, " Push the branch, open a pull request and move the ticket to review");

  // Repositories of the selected host, and the default clone folder of the chosen one.
  let repos: RepoSummary[] = [];
  const findRepo = (): RepoRef | undefined => {
    const name = repoInput.value.trim();
    const found = repos.find((r) => r.fullName === name);
    if (found) return found;
    return project && project.repo.fullName === name && project.repo.provider === host.value
      ? project.repo
      : undefined;
  };
  const refreshPlaceholder = async () => {
    const repo = findRepo();
    baseBranch.placeholder = repo
      ? `Empty: the repository's default (${repo.defaultBranch})`
      : "Pick a repository first";
    folder.placeholder = repo
      ? `Empty: clone into ${await api().defaultPath(repo.provider, repo.fullName)}`
      : "Pick a repository first";
  };
  const loadRepos = () =>
    void busy(undefined, status, async () => {
      repoList.replaceChildren(el("option", "Loading…"));
      repos = await api().repos(host.value as GitProviderId);
      repoList.replaceChildren(
        ...repos.map((r) => {
          const o = el("option");
          o.value = r.fullName;
          o.label = r.private ? "private" : "public";
          return o;
        }),
      );
      await refreshPlaceholder();
    });
  /** GitHub Issues are offered for GitHub repositories only. */
  const refreshTrackers = () => {
    const current = trackerSelect.value || (project ? trackerValue(project.tracker) : "");
    const options = trackerOptions(host.value as GitProviderId, jiraProjects);
    trackerSelect.replaceChildren(
      ...select(options.length ? options : [["", "Connect Jira for Bitbucket projects"]]).options,
    );
    if (options.some(([v]) => v === current)) trackerSelect.value = current;
  };
  host.addEventListener("change", () => {
    repoInput.value = "";
    loadRepos();
    refreshTrackers();
  });
  repoInput.addEventListener("change", () => void refreshPlaceholder());
  loadRepos();
  refreshTrackers();
  if (connected("jira"))
    void busy(undefined, status, async () => {
      jiraProjects = await api().jiraProjects();
      refreshTrackers();
    });

  const save = button(
    "Save",
    () =>
      void busy(save, status, async () => {
        const repo = findRepo();
        if (!repo) throw new Error("Choose a repository from the list");
        const tracker = parseTracker(trackerSelect.value);
        if (!tracker) throw new Error("Choose where the tickets come from");
        const input: ProjectInput = {
          id: project?.id,
          name: name.value.trim() || repo.fullName,
          tracker,
          repo: {
            provider: repo.provider,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            cloneUrl: repo.cloneUrl,
            webUrl: repo.webUrl,
          },
          localPath: folder.value.trim(),
          baseBranch: baseBranch.value.trim() || undefined,
          agent: {
            permissionMode: mode.value as PermissionMode,
            model: model.value,
            instructions: instructions.value.trim() || undefined,
            openPullRequest: openPr.checked,
          },
        };
        update({ workspace: await api().saveProject(input) });
        openSettings(undefined);
      }),
    "primary",
  );
  const cancel = button("Cancel", () => openSettings(undefined));
  const actions = el("div", undefined, "actions");
  actions.append(save, cancel);
  if (project) {
    const remove = button(
      "Delete",
      () => {
        if (!confirm(`Delete the project "${project.name}"? Its clone and worktrees stay on disk.`))
          return;
        void busy(remove, status, async () => {
          update({ workspace: await api().deleteProject(project.id) });
          openSettings(undefined);
        });
      },
      "danger",
    );
    actions.append(remove);
  }

  section.append(
    field("Name", name),
    field("Code host", host),
    field("Repository", repoInput),
    repoList,
    field("Tickets from", trackerSelect),
    field(
      "Local folder",
      folderRow,
      "An existing clone of this repository, or empty to let the app clone it. Agents work in separate worktrees, never in this folder.",
    ),
    field(
      "Base branch",
      baseBranch,
      "New ticket branches start from it and pull requests target it, e.g. develop.",
    ),
    field(
      "Agent permissions",
      mode,
      "What the mode doesn't allow on its own, the agent asks you in the office: its character raises its hand and the ticket shows Allow / Deny.",
    ),
    field("Model", model, `${MODEL_HINT} Each ticket can pick another one.`),
    field("Instructions for every ticket", instructions),
    prLabel,
    actions,
    status,
  );
  return section;
}
