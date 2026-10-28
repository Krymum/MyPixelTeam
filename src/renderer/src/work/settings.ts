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
import { languageChoice, setLanguage, t, type LanguageChoice } from "../i18n";
import { accountCard, PROVIDER_NAMES } from "./accounts-ui";
import { discoveryPanel } from "./discovery";
import { hooksCard } from "./hooks-ui";
import { modelHint, modelSelect } from "./model-ui";
import { connected, update, work } from "./store";
import { parseTracker, trackerOptions, trackerValue } from "./tracker-ui";
import { openWelcome } from "./welcome";

/** Settings dialog: connected accounts and the projects agents work on. */

const api = () => window.office.work;

const permissionLabels = (): Record<PermissionMode, string> => ({
  acceptEdits: t("Edit files freely, ask me before running commands"),
  auto: t("Auto mode: Claude Code judges each command, asks me when unsure"),
  bypassPermissions: t("Everything, unchecked (sandboxed machines only)"),
});

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
  close.title = t("Close");
  dialog.replaceChildren(
    close,
    el("h2", t("Settings")),
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
  section.append(el("h3", t("Accounts")));
  if (!work.accounts.secureStorage)
    section.append(
      el("p", t("This system offers no secure storage: accounts can't be saved."), "bad"),
    );
  for (const provider of ["jira", "github", "bitbucket"] as const)
    section.append(accountCard(provider, render));
  return section;
}

function projectsSection(): HTMLElement {
  const section = el("section");
  section.append(el("h3", t("Projects")));
  const { projects } = work.workspace;
  if (!projects.length)
    section.append(
      el(
        "p",
        t(
          "A project is a repository and where its tickets live: its GitHub Issues, or a Jira project. Agents work on those tickets.",
        ),
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
        t("{repo} ({host}) · tickets: {tracker}", {
          repo: p.repo.fullName,
          host: PROVIDER_NAMES[p.repo.provider],
          tracker: trackerLabel(p.tracker),
        }),
        "muted",
      ),
    );
    row.append(
      text,
      button(t("Edit"), () => openSettings(p.id)),
    );
    section.append(row);
  }
  const detect = button(t("Find my projects"), () => openSettings("discover"), "primary");
  const add = button(t("+ New project"), () => openSettings(null));
  for (const b of [detect, add]) {
    b.disabled = !(connected("github") || connected("bitbucket"));
    if (b.disabled) b.title = t("Connect GitHub or Bitbucket first");
  }
  const actions = el("div", undefined, "actions");
  actions.append(detect, add);
  section.append(actions);
  return section;
}

function discoverySection(): HTMLElement {
  const section = el("section");
  section.append(
    el("h3", t("Find my projects")),
    discoveryPanel(() => openSettings(undefined)),
    button(`← ${t("Projects")}`, () => openSettings(undefined)),
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
  label.append(notify, ` ${t("Notify me when an agent finishes, fails or waits for me")}`);
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
      ["0", t("No limit")],
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
    ` ${t("When a pull request's checks fail, put its agent back on it ({n} times at most)", { n: MAX_CI_FIXES })}`,
  );
  const commands = input("", "", "checkbox");
  commands.checked = work.workspace.commentCommands;
  commands.addEventListener("change", async () => {
    update({ workspace: await api().setPreferences({ commentCommands: commands.checked }) });
  });
  const commandsLabel = el("label", undefined, "check");
  commandsLabel.append(
    commands,
    ` ${t("A comment starting with @agent on a ticket or its pull request puts its agent back on it")}`,
  );
  const languages = select(
    [
      ["auto", t("Same as the system")],
      ["en", "English"],
      ["fr", "Français"],
    ],
    languageChoice(),
  );
  languages.addEventListener("change", () => setLanguage(languages.value as LanguageChoice));
  const guide = button(t("Open the setup guide"), () => {
    dialog.close();
    openWelcome();
  });
  section.append(
    el("h3", t("Preferences")),
    field(
      t("Agents working at once"),
      agents,
      t(
        "More tickets wait their turn. Every agent draws on the same Claude quota, so several at once reach its limit sooner.",
      ),
    ),
    field(
      t("Budget per run"),
      budget,
      t(
        "An agent that reaches it stops and keeps its changes; continuing the run gives it the same budget again.",
      ),
    ),
    fixCiLabel,
    commandsLabel,
    label,
    field(t("Language"), languages),
    hooksCard(),
    guide,
  );
  return section;
}

function projectEditor(project: Project | null): HTMLElement {
  const section = el("section");
  section.append(el("h3", project ? t("Edit {name}", { name: project.name }) : t("New project")));
  const status = el("p", "", "status");

  const name = input(project?.name ?? "", t("My product"));
  const trackerSelect = select([]);
  let jiraProjects: JiraProject[] = [];
  const hosts = (["github", "bitbucket"] as const).filter(connected);
  const host = select(
    hosts.map((h) => [h, PROVIDER_NAMES[h]]),
    project?.repo.provider ?? hosts[0],
  );
  const repoInput = input(project?.repo.fullName ?? "", t("owner/repository"));
  const repoList = el("datalist");
  repoList.id = "repo-list";
  repoInput.setAttribute("list", repoList.id);
  const folder = input(project?.localPath ?? "", "");
  const baseBranch = input(project?.baseBranch ?? "", "");
  const browse = button(t("Browse…"), async () => {
    const picked = await api().pickFolder();
    if (picked) folder.value = picked;
  });
  const folderRow = el("div", undefined, "inline");
  folderRow.append(folder, browse);
  const mode = select(
    Object.entries(permissionLabels()) as [string, string][],
    project?.agent.permissionMode ?? "acceptEdits",
  );
  const model = modelSelect(project?.agent.model);
  const instructions = textarea(project?.agent.instructions ?? "", 4);
  instructions.placeholder = t("e.g. Run npm test before finishing. Write commit-ready code.");
  const openPr = input("", "", "checkbox");
  openPr.checked = project?.agent.openPullRequest ?? true;
  const prLabel = el("label", undefined, "check");
  prLabel.append(
    openPr,
    ` ${t("Push the branch, open a pull request and move the ticket to review")}`,
  );

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
      ? t("Empty: the repository's default ({branch})", { branch: repo.defaultBranch })
      : t("Pick a repository first");
    folder.placeholder = repo
      ? t("Empty: clone into {path}", {
          path: await api().defaultPath(repo.provider, repo.fullName),
        })
      : t("Pick a repository first");
  };
  const loadRepos = () =>
    void busy(undefined, status, async () => {
      repoList.replaceChildren(el("option", t("Loading…")));
      repos = await api().repos(host.value as GitProviderId);
      repoList.replaceChildren(
        ...repos.map((r) => {
          const o = el("option");
          o.value = r.fullName;
          o.label = r.private ? t("private") : t("public");
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
      ...select(options.length ? options : [["", t("Connect Jira for Bitbucket projects")]])
        .options,
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
    t("Save"),
    () =>
      void busy(save, status, async () => {
        const repo = findRepo();
        if (!repo) throw new Error(t("Choose a repository from the list"));
        const tracker = parseTracker(trackerSelect.value);
        if (!tracker) throw new Error(t("Choose where the tickets come from"));
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
  const cancel = button(t("Cancel"), () => openSettings(undefined));
  const actions = el("div", undefined, "actions");
  actions.append(save, cancel);
  if (project) {
    const remove = button(
      t("Delete"),
      () => {
        if (
          !confirm(
            t('Delete the project "{name}"? Its clone and worktrees stay on disk.', {
              name: project.name,
            }),
          )
        )
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
    field(t("Name"), name),
    field(t("Code host"), host),
    field(t("Repository"), repoInput),
    repoList,
    field(t("Tickets from"), trackerSelect),
    field(
      t("Local folder"),
      folderRow,
      t(
        "An existing clone of this repository, or empty to let the app clone it. Agents work in separate worktrees, never in this folder.",
      ),
    ),
    field(
      t("Base branch"),
      baseBranch,
      t("New ticket branches start from it and pull requests target it, e.g. develop."),
    ),
    field(
      t("Agent permissions"),
      mode,
      t(
        "What the mode doesn't allow on its own, the agent asks you in the office: its character raises its hand and the ticket shows Allow / Deny.",
      ),
    ),
    field(t("Model"), model, t("{hint} Each ticket can pick another one.", { hint: modelHint() })),
    field(t("Instructions for every ticket"), instructions),
    prLabel,
    actions,
    status,
  );
  return section;
}
