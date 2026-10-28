import { jiraKeysForRepo } from "../../../shared/work/match";
import type {
  DiscoveredProject,
  GitProviderId,
  JiraProject,
  RepoSummary,
} from "../../../shared/work/types";
import { busy, button, el, input, select } from "../dom";
import { t, tn } from "../i18n";
import { PROVIDER_NAMES } from "./accounts-ui";
import { connected, update, work } from "./store";
import { parseTracker, trackerOptions } from "./tracker-ui";

/**
 * Repositories to turn into projects in one click, each paired with where its tickets live
 * (GitHub Issues, or the Jira project its commits or its name point at):
 * - on this computer: folders Claude Code worked in lately;
 * - in your accounts: every repository the connected GitHub and Bitbucket accounts see,
 *   cloned on the first run.
 */

const api = () => window.office.work;

interface Row {
  found: DiscoveredProject;
  pick: HTMLInputElement;
  tracker: HTMLSelectElement;
}

/** How many account repositories are shown at once; the search box narrows them. */
const ACCOUNT_ROWS = 25;

function since(ms: number): string {
  if (!ms) return t("picked by hand");
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days < 1
    ? t("used today")
    : days === 1
      ? t("used yesterday")
      : t("used {n} days ago", { n: days });
}

const repoName = (fullName: string): string => fullName.split("/").pop() ?? fullName;
const sameRepo = (a: { provider: string; fullName: string }, b: typeof a) =>
  a.provider === b.provider && a.fullName.toLowerCase() === b.fullName.toLowerCase();

/** `onAdded` runs after projects were created. */
export function discoveryPanel(onAdded: () => void): HTMLElement {
  const panel = el("div", undefined, "discovery");
  const status = el("p", "", "status");
  const localList = el("div", undefined, "discovery-list");
  const accountList = el("div", undefined, "discovery-list");
  const accountNotes = el("div", undefined, "discovery-notes");
  const filter = input("", t("Search your repositories"), "search");
  const rows: Row[] = [];
  let jiraProjects: JiraProject[] = [];
  /** Why Jira projects couldn't be listed, shown with the account notes. */
  let jiraError: string | undefined;

  const addButton = button(t("Add selected projects"), () => void addSelected(), "primary");
  const refreshCount = () => {
    const n = rows.filter((r) => r.pick.checked).length;
    addButton.textContent = n
      ? tn(n, "Add {n} project", "Add {n} projects")
      : t("Add selected projects");
    addButton.disabled = n === 0;
  };

  function rowFor(found: DiscoveredProject, checked: boolean): HTMLElement {
    const card = el("div", undefined, `card discovered${found.problem ? " unusable" : ""}`);
    const pick = input("", "", "checkbox");
    pick.disabled = Boolean(found.problem);
    pick.checked = checked && !found.problem;
    pick.addEventListener("change", refreshCount);
    // Keys from the git history first, else from the name; a Jira guess wins over GitHub Issues.
    const fromHistory = found.jiraKeys.length > 0;
    const keys = fromHistory
      ? found.jiraKeys
      : found.repo
        ? jiraKeysForRepo(found.repo.fullName, jiraProjects)
        : [];
    const options = trackerOptions(found.repo?.provider, jiraProjects, keys);
    const guessed = keys.find((k) => options.some(([v]) => v === `jira:${k}`));
    const tracker = select(options, guessed ? `jira:${guessed}` : options[0]?.[0]);
    tracker.disabled = pick.disabled;
    tracker.addEventListener("change", () => {
      pick.checked = true;
      refreshCount();
    });
    if (!found.problem && options.length === 0) {
      // A Bitbucket repository without Jira projects: nowhere to read tickets from.
      found = {
        ...found,
        problem: connected("jira")
          ? t("Jira shows no project to take its tickets from")
          : t("Connect Jira: Bitbucket projects take their tickets from it"),
      };
      pick.disabled = true;
      pick.checked = false;
      card.classList.add("unusable");
    }

    const head = el("label", undefined, "check");
    head.append(pick, el("strong", found.remote?.fullName ?? found.path));
    const details = found.path
      ? `${found.path} · ${since(found.lastUsed)}`
      : `${PROVIDER_NAMES[found.repo!.provider]} · ${t("not on this computer yet: cloned on the first run")}`;
    card.append(head, el("div", details, "muted"));
    if (found.problem) card.append(el("div", found.problem, "bad"));
    else {
      const trackerRow = el("div", undefined, "inline");
      trackerRow.append(el("span", t("Tickets from"), "muted"), tracker);
      if (guessed)
        trackerRow.append(
          el(
            "small",
            fromHistory ? t("guessed from branches and commits") : t("guessed from the name"),
            "muted",
          ),
        );
      card.append(trackerRow);
    }
    rows.push({ found, pick, tracker });
    return card;
  }

  /** Account repositories, built once; the search box only shows or hides them. */
  let accountCards: { repo: RepoSummary; card: HTMLElement; row: Row }[] = [];
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    let matching = 0;
    for (const { repo, card, row } of accountCards) {
      const match = !q || repo.fullName.toLowerCase().includes(q);
      if (match) matching++;
      // Ticked ones stay visible so the selection is never hidden.
      card.hidden = !(row.pick.checked || (match && shown < ACCOUNT_ROWS));
      if (!card.hidden) shown++;
    }
    more.textContent =
      matching > ACCOUNT_ROWS
        ? t("{n} more: type to narrow down.", { n: matching - ACCOUNT_ROWS })
        : "";
  };
  const more = el("p", "", "muted");
  filter.addEventListener("input", applyFilter);

  async function loadAccounts(local: DiscoveredProject[]): Promise<void> {
    accountCards = [];
    accountList.replaceChildren(el("p", t("Asking your accounts…"), "muted"));
    const notes: HTMLElement[] = [];
    const hosts = (["github", "bitbucket"] as GitProviderId[]).filter(connected);
    const taken = [
      ...work.workspace.projects.map((p) => p.repo),
      ...local.flatMap((f) => (f.remote ? [{ ...f.remote }] : [])),
    ];
    const lists = await Promise.all(
      hosts.map(async (host) => {
        try {
          const repos = await api().repos(host);
          if (!repos.length)
            notes.push(
              el(
                "p",
                host === "bitbucket"
                  ? t(
                      "Bitbucket shows no repository: the token needs read:workspace and read:repository, and your account must be a member of the workspace.",
                    )
                  : t("GitHub shows no repository: check the token's repository access."),
                "bad",
              ),
            );
          return repos;
        } catch (err) {
          notes.push(el("p", `${PROVIDER_NAMES[host]}: ${(err as Error).message}`, "bad"));
          return [];
        }
      }),
    );
    if (jiraError) notes.push(el("p", `Jira: ${jiraError}`, "bad"));
    else if (connected("jira") && jiraProjects.length === 0)
      notes.push(
        el("p", t("Jira shows no project: check that the account can browse projects."), "bad"),
      );
    accountNotes.replaceChildren(...notes);
    const repos = lists.flat().filter((r) => !taken.some((t) => sameRepo(t, r)));
    accountList.replaceChildren(
      ...(repos.length ? [] : [el("p", t("No other repository in your accounts."), "muted")]),
    );
    for (const repo of repos) {
      const ref = {
        provider: repo.provider,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        cloneUrl: repo.cloneUrl,
        webUrl: repo.webUrl,
      };
      const card = rowFor({ path: "", lastUsed: 0, repo: ref, remote: ref, jiraKeys: [] }, false);
      const row = rows.at(-1)!;
      row.pick.addEventListener("change", applyFilter);
      accountCards.push({ repo, card, row });
      accountList.append(card);
    }
    applyFilter();
  }

  async function search(): Promise<void> {
    rows.length = 0;
    jiraError = undefined;
    localList.replaceChildren(el("p", t("Looking at the folders Claude Code worked in…"), "muted"));
    const found = await busy(undefined, status, async () => {
      const [projects, discovered] = await Promise.all([
        connected("jira")
          ? api()
              .jiraProjects()
              .catch((err: Error) => {
                jiraError = err.message;
                return [];
              })
          : Promise.resolve([]),
        api().discoverProjects(),
      ]);
      jiraProjects = projects;
      return discovered;
    });
    if (!found) {
      localList.replaceChildren();
      return;
    }
    localList.replaceChildren(
      ...(found.length
        ? found.map((f) => rowFor(f, true))
        : [el("p", t("Nothing new in the folders Claude Code worked in."), "muted")]),
    );
    refreshCount();
    await loadAccounts(found);
    refreshCount();
  }

  async function addFolder(): Promise<void> {
    const path = await api().pickFolder();
    if (!path) return;
    const found = await busy(undefined, status, () => api().inspectFolder(path));
    if (found === undefined) {
      if (!status.textContent) status.textContent = t("This repository is already a project.");
      return;
    }
    if (!rows.length) localList.replaceChildren();
    localList.prepend(rowFor(found, true));
    refreshCount();
  }

  async function addSelected(): Promise<void> {
    await busy(addButton, status, async () => {
      const chosen = rows.filter((r) => r.pick.checked);
      for (const { found, tracker } of chosen) {
        const choice = parseTracker(tracker.value);
        if (!choice)
          throw new Error(
            t("Choose where the tickets of {repo} come from", { repo: found.repo?.fullName ?? "" }),
          );
        const workspace = await api().saveProject({
          name: repoName(found.repo!.fullName),
          tracker: choice,
          repo: found.repo!,
          // Empty: cloned into the app's folder on the first run.
          localPath: found.path,
          agent: { permissionMode: "acceptEdits", openPullRequest: true },
        });
        update({ workspace });
      }
      onAdded();
    });
  }

  const actions = el("div", undefined, "actions");
  actions.append(
    addButton,
    button(t("Add a folder…"), () => void addFolder()),
    button(t("Search again"), () => void search()),
  );
  panel.append(
    el("h4", t("On this computer")),
    el(
      "p",
      t(
        "Repositories where you used Claude Code lately. Agents work in worktrees, never in these folders.",
      ),
      "muted",
    ),
    localList,
    el("h4", t("In your accounts")),
    accountNotes,
    filter,
    accountList,
    more,
    actions,
    status,
  );
  void search();
  return panel;
}
