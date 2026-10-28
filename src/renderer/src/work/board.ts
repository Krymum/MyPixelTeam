import {
  isActiveRun,
  MAX_CI_FIXES,
  PLAN_MODEL,
  isPreviewable,
  trackerLabel,
  type Attachment,
  type IssueDetail,
  type TicketBranches,
  type IssueSummary,
  type RunView,
} from "../../../shared/work/types";
import {
  isLimitStop,
  latestRuns,
  needsYou,
  ticketState,
  type Need,
} from "../../../shared/work/run-state";
import { busy, button, el, field, formatDuration, input, link, select, textarea } from "../dom";
import { locale, t, tn } from "../i18n";
import { foldedMarkdown } from "../markdown";
import { dismiss, dismissed } from "./dismissed";
import { modelSelect } from "./model-ui";
import { questionsBox } from "./questions-ui";
import { openSettings } from "./settings";
import { activeProject, connected, subscribe, update, work } from "./store";

/** Left drawer: the active project's tickets (Jira or GitHub Issues), and its agents. */

const api = () => window.office.work;

type View = { kind: "list" } | { kind: "issue"; key: string } | { kind: "create" };

let board: HTMLElement;
let tab: "tickets" | "agents" = "tickets";
let view: View = { kind: "list" };
let query = { text: "", includeDone: false };
let issues: IssueSummary[] | undefined;
/** Re-renders the agent box of the open ticket when runs change. */
let refreshAgentBox: (() => void) | undefined;
/** Redraws the list's rows, whose badges show what each ticket's agent is doing. */
let refreshList: (() => void) | undefined;
const expandedLogs = new Set<string>();
/** Tickets whose agent options are unfolded, by "<project>:<key>". */
const openOptions = new Set<string>();
/** The Agents tab also shows older runs of each ticket. */
let showHistory = false;
/** Issues from untrusted authors the person read and accepted ("<project>:<key>"). */
const confirmedUntrusted = new Set<string>();
/** The ticket's branches on origin, looked up once per opening of the ticket. */
const branchLookups = new Map<string, Promise<TicketBranches>>();
/** Branch picked for the next run ("" = the app's new branch), by "<project>:<key>". */
const chosenBranch = new Map<string, string>();
/** Whether each project's repository has a CLAUDE.md, looked up once per launch. */
const guides = new Map<string, Promise<boolean>>();
/** Model picked for the next run, by "<project>:<key>". */
const chosenModel = new Map<string, string>();

export function initBoard(node: HTMLElement): void {
  board = node;
  document.addEventListener("keydown", (e) => {
    // From the search box too; a text area or a menu keeps its arrows.
    const target = e.target as HTMLElement;
    if (!board.hidden && !target.closest("textarea, select, dialog")) moveInList(e);
  });
  subscribe(() => {
    if (board.hidden) return;
    if (tab === "agents") renderAgents();
    else {
      refreshAgentBox?.();
      refreshList?.();
    }
  });
}

export function toggleBoard(show = board.hidden): void {
  board.hidden = !show;
  if (show) render();
}

/** Called when the active project changes. */
export function resetBoard(): void {
  view = { kind: "list" };
  issues = undefined;
  if (!board.hidden) render();
}

/** "/" from anywhere: the ticket list, ready to type. */
export function focusSearch(): void {
  tab = "tickets";
  view = { kind: "list" };
  toggleBoard(true);
  board.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
}

/** Escape: a ticket goes back to the list, the list closes the board. False when closed. */
export function boardBack(): boolean {
  if (board.hidden) return false;
  if (tab === "tickets" && view.kind !== "list") {
    view = { kind: "list" };
    render();
  } else toggleBoard(false);
  return true;
}

/** Up and down move between the rows of the list. */
function moveInList(e: KeyboardEvent): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...board.querySelectorAll<HTMLElement>("ul.issues .row-main")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
  if (at === -1 && e.key === "ArrowUp") return;
  e.preventDefault();
  rows[at === -1 ? 0 : next]!.focus();
}

/** Opens the Agents tab, where waiting agents are listed with their questions. */
export function showAgents(): void {
  tab = "agents";
  toggleBoard(true);
}

/** Opens the ticket an agent works on (agent panel, notification), switching project if needed. */
export async function showIssue(projectId: string, key: string): Promise<void> {
  if (activeProject()?.id !== projectId) {
    update({ workspace: await window.office.work.setActiveProject(projectId) });
    issues = undefined;
  }
  tab = "tickets";
  view = { kind: "issue", key };
  toggleBoard(true);
}

function render(): void {
  refreshAgentBox = undefined;
  refreshList = undefined;
  const close = button("✕", () => toggleBoard(false), "close");
  close.title = t("Close");
  const tabs = el("nav", undefined, "tabs");
  const needs = needsYou(work.runs, dismissed()).length;
  for (const [id, label] of [
    ["tickets", t("Tickets")],
    ["agents", agentsLabel(needs)],
  ] as const) {
    const choice = button(label, () => {
      tab = id;
      render();
    });
    if (tab === id) choice.className = "selected";
    tabs.append(choice);
  }
  board.replaceChildren(close, tabs, el("div", undefined, "board-body"));
  if (tab === "agents") renderAgents();
  else renderTickets();
}

const agentsLabel = (needs: number): string =>
  needs ? t("Agents ({n})", { n: needs }) : t("Agents");

function body(): HTMLElement {
  return board.querySelector<HTMLElement>(".board-body")!;
}

function renderTickets(): void {
  const project = activeProject();
  if (!project) {
    const ready = connected("github") || connected("bitbucket");
    const setup = el("div", undefined, "empty");
    setup.append(
      el(
        "p",
        ready ? t("No project yet.") : t("Connect GitHub or Bitbucket to see your projects."),
      ),
      button(
        ready ? t("Create a project") : t("Open settings"),
        () => openSettings(ready ? null : undefined),
        "primary",
      ),
    );
    body().replaceChildren(setup);
    return;
  }
  if (view.kind === "issue") return void renderIssue(view.key);
  if (view.kind === "create") return renderCreate();
  renderList();
}

function renderList(): void {
  const project = activeProject()!;
  const status = el("p", "", "status");
  const search = input(
    query.text,
    project.tracker.kind === "jira" ? t("Search, or a key like PROJ-12") : t("Search, or #12"),
    "search",
  );
  const done = input("", "", "checkbox");
  done.checked = query.includeDone;
  const doneLabel = el("label", undefined, "check");
  doneLabel.append(done, ` ${t("Show done")}`);
  const list = el("ul", undefined, "issues");

  const load = () =>
    void busy(undefined, status, async () => {
      query = { text: search.value, includeDone: done.checked };
      list.replaceChildren(el("li", t("Loading…"), "muted"));
      issues = await api().issues(project.id, query);
      showIssues();
    }).then(() => {
      if (!issues) list.replaceChildren();
    });
  const showIssues = () => {
    if (!issues!.length) return void list.replaceChildren(el("li", t("No tickets."), "muted"));
    // Tickets sit under their epic when both are listed.
    const listed = new Set(issues!.map((i) => i.key));
    const children = new Map<string, IssueSummary[]>();
    for (const i of issues!)
      if (i.parentKey && listed.has(i.parentKey))
        children.set(i.parentKey, [...(children.get(i.parentKey) ?? []), i]);
    list.replaceChildren(
      ...issues!
        .filter((i) => !i.parentKey || !listed.has(i.parentKey))
        .map((i) => issueRow(i, children.get(i.key) ?? [])),
    );
  };
  // Agents start and finish while the list is open: their badges follow.
  refreshList = () => issues && showIssues();
  search.addEventListener("keydown", (e) => e.key === "Enter" && load());
  done.addEventListener("change", load);

  const toolbar = el("div", undefined, "toolbar");
  toolbar.append(
    search,
    doneLabel,
    Object.assign(button("↻", load), { title: t("Reload the tickets") }),
    button(
      t("New ticket"),
      () => {
        view = { kind: "create" };
        render();
      },
      "primary",
    ),
  );
  const guide = el("div");
  body().replaceChildren(
    heading(project.name, trackerLabel(project.tracker)),
    guide,
    toolbar,
    status,
    list,
  );
  void guideOffer(project.id).then((offer) => offer && guide.replaceChildren(offer));
  if (issues) showIssues();
  else load();
}

/** The project's name, with where its tickets come from beside it. */
function heading(name: string, source: string): HTMLElement {
  const h = el("h3", name, "with-source");
  h.append(el("span", source, "source"));
  return h;
}

/** Epics folded in the list, by "<project>:<key>". */
const foldedEpics = new Set<string>();

/**
 * A ticket in a glance: its title, what its agent is up to, and only the facts that say
 * something (a status other than open, a type other than the default, its tickets done).
 */
function issueRow(issue: IssueSummary, children: IssueSummary[] = []): HTMLElement {
  const li = el("li", undefined, "issue-row");
  const row = el("div", undefined, "row-main");
  row.tabIndex = 0;
  const title = el("div", undefined, "issue-title");
  title.append(el("span", issue.key, "key"), el("span", issue.summary));
  const meta = el("div", undefined, "issue-meta");
  if (issue.statusCategory !== "new") meta.append(pill(issue.status, issue.statusCategory));
  if (issue.type && issue.type !== "Issue") meta.append(el("span", issue.type, "muted"));
  if (issue.childCount)
    meta.append(
      el(
        "span",
        t("{done}/{total} tickets done", {
          done: issue.childCount.done,
          total: issue.childCount.total,
        }),
        "muted",
      ),
    );
  if (issue.assignee) meta.append(el("span", issue.assignee, "muted"));
  const last = runsOf(issue.key)[0];
  const text = el("div", undefined, "row-text");
  text.append(title);
  if (meta.childElementCount) text.append(meta);
  row.append(text);
  if (last) row.append(stateChip(last));
  const open = () => {
    view = { kind: "issue", key: issue.key };
    render();
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => e.key === "Enter" && open());
  li.append(row);
  if (children.length) {
    const id = `${activeProject()?.id}:${issue.key}`;
    const folded = foldedEpics.has(id);
    const fold = button(
      `${folded ? "▸" : "▾"} ${tn(children.length, "{n} ticket", "{n} tickets")}`,
      () => {
        if (foldedEpics.has(id)) foldedEpics.delete(id);
        else foldedEpics.add(id);
        refreshList?.();
      },
    );
    fold.className = "fold";
    li.append(fold);
    if (!folded) {
      const sub = el("ul", undefined, "issues children");
      sub.append(...children.map((c) => issueRow(c)));
      li.append(sub);
    }
  }
  return li;
}

/** What the ticket's latest run is up to, as a coloured word. */
function stateChip(run: RunView): HTMLElement {
  const state = ticketState(run);
  return el("span", t(state.label, state.vars), `chip ${state.tone}`);
}

/** Runs on this ticket of the active project ("#12" exists in every GitHub repository). */
function runsOf(key: string): RunView[] {
  const project = activeProject();
  return work.runs.filter((r) => r.issueKey === key && r.projectId === project?.id);
}

function pill(text: string, category: string): HTMLElement {
  return el("span", text, `pill ${category}`);
}

function backButton(): HTMLButtonElement {
  return button(`← ${t("Tickets")}`, () => {
    view = { kind: "list" };
    render();
  });
}

async function renderIssue(key: string): Promise<void> {
  const status = el("p", "", "status");
  body().replaceChildren(backButton(), el("p", t("Loading {key}…", { key }), "muted"), status);
  const project = activeProject()!;
  // Opening a ticket asks origin again: runs push branches, colleagues create them.
  branchLookups.delete(`${project.id}:${key}`);
  const issue = await busy(undefined, status, () => api().issue(project.id, key));
  if (!issue || view.kind !== "issue" || view.key !== key) return;
  const reload = () => {
    issues = undefined;
    void renderIssue(key);
  };
  const can = issue.permissions;

  const head = el("div", undefined, "issue-head");
  head.append(link(issue.key, issue.url), pill(issue.status, issue.statusCategory));
  if (issue.type && issue.type !== "Issue") head.append(el("span", issue.type, "muted"));
  if (issue.priority) head.append(el("span", issue.priority, "muted"));
  if (issue.parent) {
    const parent = issue.parent;
    head.append(
      button(
        t("in {key}", { key: parent.key }),
        () => {
          view = { kind: "issue", key: parent.key };
          render();
        },
        "link",
      ),
    );
  }

  // What people come for first: the agent. The ticket itself is read, and edited on demand.
  const agentBox = el("div", undefined, "card agent-box");
  refreshAgentBox = () => renderAgentBox(agentBox, issue);
  refreshAgentBox();

  const ticket = el("section", undefined, "ticket-text");
  const showText = () => {
    const actions = el("div", undefined, "actions");
    if (can.edit) actions.append(button(t("Edit"), showForm));
    const transitions = transitionPicker();
    if (transitions) actions.append(transitions);
    ticket.replaceChildren(
      issue.description.trim()
        ? foldedMarkdown(issue.description, 10)
        : el("p", t("No description."), "muted"),
      actions,
    );
  };
  const showForm = () => {
    const summary = input(issue.summary);
    const description = textarea(issue.description, 12);
    const save = button(
      t("Save"),
      () =>
        void busy(save, status, async () => {
          await api().updateIssue(project.id, key, {
            summary: summary.value !== issue.summary ? summary.value : undefined,
            description: description.value !== issue.description ? description.value : undefined,
          });
          reload();
        }),
      "primary",
    );
    const actions = el("div", undefined, "actions");
    actions.append(save, button(t("Cancel"), showText));
    if (project.tracker.kind === "jira")
      actions.append(
        el(
          "small",
          t("Saving the description keeps paragraphs only: rich formatting is lost."),
          "muted",
        ),
      );
    ticket.replaceChildren(
      field(t("Summary"), summary),
      field(t("Description"), description),
      actions,
    );
    description.focus();
  };
  /** Moves the ticket along its workflow as soon as a status is picked. */
  const transitionPicker = (): HTMLElement | undefined => {
    if (!can.transition || !issue.transitions.length) return undefined;
    const transitions = select([
      ["", t("Move to…")],
      ...issue.transitions.map((tr): [string, string] => [
        tr.id,
        tr.name === tr.to ? tr.to : `${tr.name} → ${tr.to}`,
      ]),
    ]);
    transitions.className = "compact";
    transitions.addEventListener("change", () => {
      if (!transitions.value) return;
      transitions.disabled = true;
      void busy(undefined, status, () => api().transition(project.id, key, transitions.value)).then(
        reload,
      );
    });
    return transitions;
  };
  showText();

  const comments = el("ol", undefined, "comments");
  for (const c of [...issue.comments].reverse()) {
    const li = el("li");
    li.append(
      el(
        "div",
        `${c.author} · ${new Date(c.created).toLocaleString(locale())}${c.trusted ? "" : ` · ${t("not a collaborator: hidden from agents")}`}`,
        "muted",
      ),
      foldedMarkdown(c.text),
    );
    comments.append(li);
  }
  const commentBox = el("div", undefined, "comment-box");
  if (can.comment) {
    const text = textarea("", 2);
    text.placeholder = t("Add a comment. Start with @agent to send it to the agent.");
    const send = button(t("Comment"), () => {
      if (!text.value.trim()) return;
      void busy(send, status, () => api().comment(project.id, key, text.value)).then(reload);
    });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send.click();
    });
    commentBox.append(text, send);
  }

  body().replaceChildren(
    backButton(),
    head,
    el("h3", issue.summary, "issue-heading"),
    status,
    agentBox,
    ticket,
    ...(issue.attachments.length ? [attachmentsBox(project.id, issue.attachments)] : []),
    el("h4", t("Comments ({n})", { n: issue.comments.length })),
    commentBox,
    comments,
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The ticket's files: images previewed inline, everything can be saved. */
function attachmentsBox(projectId: string, attachments: Attachment[]): HTMLElement {
  const box = el("div", undefined, "attachments");
  box.append(el("h4", t("Attachments ({n})", { n: attachments.length })));
  for (const a of attachments) {
    const item = el("div", undefined, "attachment");
    const status = el("p", "", "status");
    const head = el("div", undefined, "issue-head");
    head.append(el("strong", a.filename), el("span", formatSize(a.size), "muted"));
    if (a.author) head.append(el("span", a.author, "muted"));
    const actions = el("div", undefined, "actions");
    const save = button(
      t("Save…"),
      () =>
        void busy(save, status, async () => {
          const path = await api().saveAttachment(projectId, a.id, a.filename);
          if (path) {
            status.textContent = t("Saved to {path}", { path });
            status.className = "status ok";
          }
        }),
    );
    actions.append(save);
    if (a.url) actions.append(link(t("Open in Jira"), a.url));
    item.append(head);
    if (isPreviewable(a)) {
      const img = el("img");
      img.alt = a.filename;
      img.className = "preview";
      img.title = t("Click to enlarge");
      img.addEventListener("click", () => img.classList.toggle("large"));
      item.append(img);
      // Fetched by the main process with the Jira account, then shown as a data: URL.
      void busy(undefined, status, async () => {
        img.src = await api().attachmentPreview(projectId, a.id);
      });
    }
    item.append(actions, status);
    box.append(item);
  }
  return box;
}

/**
 * One obvious next step for the ticket, chosen from where it is: run an epic's tickets,
 * continue the agent's work, or put a first agent on it. Everything else is folded under
 * t("More options").
 */
function renderAgentBox(box: HTMLElement, issue: IssueDetail): void {
  const runs = runsOf(issue.key);
  const active = runs.find(isActiveRun);
  const last = runs[0];
  const status = el("p", "", "status");
  box.replaceChildren(el("h4", t("Agent")));
  if (active) {
    box.append(runSummary(active));
    const questions = questionsBox(active);
    if (questions) box.append(questions);
    const cancel = button(
      t("Stop the agent"),
      () => void busy(cancel, status, () => api().cancelRun(active.id)),
      "danger",
    );
    box.append(cancel, status);
    return;
  }
  if (last) box.append(runSummary(last));
  const project = activeProject()!;
  const trustKey = `${project.id}:${issue.key}`;
  const model = modelSelect(chosenModel.get(trustKey) ?? project.agent.model);
  model.addEventListener("change", () => chosenModel.set(trustKey, model.value));

  const open = (issue.children ?? []).filter((c) => c.statusCategory !== "done");
  const epic = open.length > 0 && issue.trusted;
  const continuing = !epic && Boolean(last?.agentStarted && last.branch);
  const start = button(
    epic || continuing ? t("Start over with a new agent") : `▶ ${t("Put an agent on it")}`,
    () =>
      void busy(start, status, async () => {
        await api().startRun(project.id, issue.key, {
          allowUntrusted: confirmedUntrusted.has(trustKey),
          branch: chosenBranch.get(trustKey) || undefined,
          model: model.value,
        });
      }),
    epic || continuing ? undefined : "primary",
  );

  if (!issue.trusted) {
    // The issue text becomes the agent's instructions: a stranger could make it run anything.
    const warning = el("div", undefined, "trust-warning");
    warning.append(
      el(
        "p",
        t(
          "Opened by {author}, who is not a collaborator of this repository. Its text becomes the agent's instructions: read it before going on.",
          { author: issue.author ?? t("someone") },
        ),
      ),
    );
    const confirm = input("", "", "checkbox");
    confirm.checked = confirmedUntrusted.has(trustKey);
    const label = el("label", undefined, "check");
    label.append(confirm, ` ${t("I read this issue and trust what it asks")}`);
    confirm.addEventListener("change", () => {
      if (confirm.checked) confirmedUntrusted.add(trustKey);
      else confirmedUntrusted.delete(trustKey);
      start.disabled = !confirm.checked;
    });
    start.disabled = !confirm.checked;
    warning.append(label);
    box.append(warning);
  }

  if (epic) box.append(epicBox(project.id, issue.key, open.length));
  else if (continuing) box.append(continueBox(last!));
  else
    box.append(
      start,
      el(
        "p",
        project.agent.openPullRequest
          ? t("Works on its own branch of {repo}, then opens a pull request.", {
              repo: project.repo.fullName,
            })
          : t("Works on its own branch of {repo}, then commits locally.", {
              repo: project.repo.fullName,
            }),
        "muted",
      ),
    );
  box.append(status);

  const options = el("details", undefined, "options");
  options.open = openOptions.has(trustKey);
  options.addEventListener("toggle", () => {
    if (options.open) openOptions.add(trustKey);
    else openOptions.delete(trustKey);
  });
  options.append(el("summary", t("More options")));
  if (!epic && issue.trusted) options.append(planBox(project.id, issue.key));
  options.append(
    branchPicker(project.id, issue, trustKey),
    field(
      t("Model"),
      model,
      t("Opus only for hard tickets: it uses the Claude quota much faster."),
    ),
  );
  if (epic || continuing) options.append(start);
  if (issue.publicRepo)
    options.append(
      el(
        "p",
        t(
          "Public repository: comments from people who aren't collaborators are never shown to the agent.",
        ),
        "muted",
      ),
    );
  box.append(options);
}

/** A cheap agent that only writes the tickets this one breaks into, under it. */
function planBox(projectId: string, key: string): HTMLElement {
  const box = el("div", undefined, "option-row");
  const status = el("p", "", "status");
  const go = button(
    t("Break it into tickets"),
    () =>
      void busy(go, status, async () => {
        await api().startRun(projectId, key, { planOnly: true });
      }),
  );
  box.append(
    go,
    el(
      "small",
      t(
        "Too big for one agent? A {model} agent reads the code without changing it and writes the tickets it breaks into, under {key}.",
        { model: PLAN_MODEL, key },
      ),
      "muted",
    ),
    status,
  );
  return box;
}

/** Puts agents on an epic's open tickets, one after another. */
function epicBox(projectId: string, epicKey: string, count: number): HTMLElement {
  const box = el("div", undefined, "epic-box");
  const status = el("p", "", "status");
  const go = button(
    `▶ ${tn(count, "Put an agent on its open ticket", "Put agents on its {n} open tickets")}`,
    () =>
      void busy(go, status, async () => {
        await api().startEpic(projectId, epicKey);
        tab = "agents";
        render();
      }),
    "primary",
  );
  box.append(
    go,
    el(
      "p",
      t(
        "One after another, each on the branch of the one before, so the work it depends on is there. A ticket that fails stops the rest.",
      ),
      "muted",
    ),
    status,
  );
  return box;
}

/** Instructions being typed for a continuation, by run id (runs redraw this box). */
const continueDrafts = new Map<string, { text: string; review: boolean }>();

/**
 * Picks the last run's session up again, on its branch: a follow-up instruction, and the
 * pull request's review comments when there is a pull request.
 */
function continueBox(last: RunView): HTMLElement {
  const box = el("div", undefined, "continue-box");
  const draft = continueDrafts.get(last.id) ?? { text: "", review: Boolean(last.pullRequestUrl) };
  const status = el("p", "", "status");
  const text = textarea(draft.text, 3);
  text.placeholder = last.pullRequestUrl
    ? t("e.g. Apply the review comments, then rerun the tests")
    : t("e.g. Also handle the empty list case");
  text.addEventListener("input", () => {
    draft.text = text.value;
    continueDrafts.set(last.id, draft);
  });
  const review = input("", "", "checkbox");
  review.checked = draft.review;
  review.addEventListener("change", () => {
    draft.review = review.checked;
    continueDrafts.set(last.id, draft);
  });
  const reviewLabel = el("label", undefined, "check");
  reviewLabel.append(review, ` ${t("Pass on the pull request's review comments")}`);
  const go = button(
    `▶ ${t("Continue")}`,
    () =>
      void busy(go, status, async () => {
        await api().continueRun(last.id, text.value, {
          includeReview: Boolean(last.pullRequestUrl) && review.checked,
        });
        continueDrafts.delete(last.id);
      }),
    "primary",
  );
  box.append(
    field(
      t("Continue where the agent left off"),
      text,
      t("Same session and branch ({branch}): the agent remembers what it did.", {
        branch: last.branch,
      }),
    ),
  );
  if (last.pullRequestUrl) box.append(reviewLabel);
  box.append(go, status);
  return box;
}

/**
 * Where the agent works: a new branch from the base, or an existing one on origin whose name
 * mentions the ticket (work a colleague or an earlier run started), proposed first.
 */
function branchPicker(projectId: string, issue: IssueDetail, key: string): HTMLElement {
  const box = el("div", undefined, "branch-picker");
  const choice = select([["", t("Looking for this ticket's branches on origin…")]]);
  choice.disabled = true;
  const hint = el("small", "", "muted");
  const status = el("p", "", "status");
  box.append(field(t("Branch"), choice), hint, status);
  choice.addEventListener("change", () => chosenBranch.set(key, choice.value));

  let lookup = branchLookups.get(key);
  if (!lookup) {
    lookup = api().ticketBranches(projectId, issue.key, issue.summary);
    branchLookups.set(key, lookup);
    lookup.catch(() => branchLookups.delete(key));
  }
  void busy(undefined, status, async () => {
    const branches = await lookup;
    const others = branches.existing.filter((b) => b !== branches.newBranch);
    const ownOnOrigin = branches.existing.includes(branches.newBranch);
    choice.replaceChildren(
      ...select([
        [
          "",
          ownOnOrigin
            ? t("{branch} (continue the earlier run)", { branch: branches.newBranch })
            : t("New: {branch}, from {base}", { branch: branches.newBranch, base: branches.base }),
        ],
        ...others.map((b): [string, string] => [b, t("Existing: {branch}", { branch: b })]),
      ]).options,
    );
    const previous = chosenBranch.get(key);
    const value =
      previous !== undefined && (previous === "" || others.includes(previous))
        ? previous
        : (others[0] ?? "");
    choice.value = value;
    chosenBranch.set(key, value);
    choice.disabled = false;
    hint.textContent = others.length
      ? tn(
          others.length,
          "A branch on origin mentions {key}: the work may have started there.",
          "{n} branches on origin mention {key}: the work may have started there.",
          { key: issue.key },
        )
      : t("No other branch on origin mentions {key}.", { key: issue.key });
  }).then(() => {
    if (!choice.disabled) return;
    // Lookup failed (shown in status): a new branch still works.
    choice.replaceChildren(...select([["", t("New branch from the base")]]).options);
    choice.disabled = false;
    chosenBranch.set(key, "");
  });
  return box;
}

function runSummary(run: RunView, options: { retry?: boolean } = {}): HTMLElement {
  const div = el("div", undefined, "run-summary");
  const head = el("div", undefined, "issue-head");
  head.append(
    el("span", statusLabel(run), `run-status ${isLimitStop(run) ? "paused" : run.status}`),
    el("span", formatDuration((run.endedAt ?? Date.now()) - run.startedAt), "muted"),
  );
  if (run.model) head.append(el("span", run.model, "muted"));
  if (run.costUsd !== undefined) head.append(el("span", `$${run.costUsd.toFixed(2)}`, "muted"));
  else if (run.tokens)
    head.append(
      Object.assign(
        el(
          "span",
          t("{tokens} tokens, {turns} turns", {
            tokens: formatTokens(run.tokens),
            turns: run.turns ?? 0,
          }),
          "muted",
        ),
        {
          title: run.budgetUsd
            ? t("The cost shows when the agent finishes; it stops at ${budget}.", {
                budget: run.budgetUsd,
              })
            : t("The cost shows when the agent finishes."),
        },
      ),
    );
  if (run.ci) head.append(el("span", t(CI_LABELS[run.ci]), `pill ci ${run.ci}`));
  div.append(head);
  if (run.planOnly || run.epicKey || run.ciFixes) {
    const why = [
      run.planOnly && t("Breaking the ticket into tickets"),
      run.epicKey && t("Part of a run through {key}", { key: run.epicKey }),
      run.ciFixes &&
        t("Fixing failing checks, attempt {n} of {max}", { n: run.ciFixes, max: MAX_CI_FIXES }),
    ];
    div.append(el("div", why.filter(Boolean).join(". "), "muted"));
  }
  if (run.stoppedOnBudget && latestRun(run) === run) {
    const more = el("div", undefined, "inline");
    const status = el("p", "", "status");
    const go = button(
      t("Continue with another ${budget}", { budget: run.budgetUsd ?? 0 }),
      () =>
        void busy(go, status, () =>
          api().continueRun(
            run.id,
            "Your budget ran out before you finished. Continue the ticket where you left off.",
          ),
        ),
      "primary",
    );
    more.append(go, status);
    div.append(more);
  }
  if (run.resumeAt) {
    const resume = el("div", undefined, "inline");
    resume.append(
      el(
        "span",
        run.resumeAt > Date.now()
          ? t("Picks the ticket up again at {time}, when the usage limit resets.", {
              time: clock(run.resumeAt),
            })
          : t("Picks the ticket up again in a moment."),
        "wait",
      ),
      button(t("Don't"), () => void api().cancelRun(run.id)),
    );
    div.append(resume);
  }
  if (run.continuedFrom)
    div.append(
      el(
        "div",
        `↳ ${t("continued: {what}", { what: run.instruction ?? t("the review comments") })}`,
        "muted pre",
      ),
    );
  if (run.pullRequestUrl) div.append(link(t("Open the pull request"), run.pullRequestUrl));
  if (run.error) div.append(el("div", run.error, isLimitStop(run) ? "wait pre" : "bad pre"));
  if (
    options.retry !== false &&
    run.status === "failed" &&
    !run.stoppedOnBudget &&
    !run.resumeAt &&
    latestRun(run) === run
  )
    div.append(retryButton(run));
  // A failed agent's last words are often the error itself.
  const result = run.result?.trim();
  if (result && !isActiveRun(run) && !run.error?.includes(result))
    div.append(foldedMarkdown(result, 4));
  const lastLine = run.log.at(-1);
  if (lastLine && isActiveRun(run))
    // Without the time the runner puts in front ("10:42:05  ").
    div.append(el("div", lastLine.split("  ").slice(1).join("  ") || lastLine, "muted now"));
  return div;
}

/** The run's status in words; the usage limit is a pause, not a failure. */
function statusLabel(run: RunView): string {
  if (run.status === "failed" && isLimitStop(run)) return t("Paused");
  return {
    queued: t("Waiting"),
    preparing: t("Getting ready"),
    running: t("Working"),
    publishing: t("Publishing"),
    done: t("Done"),
    failed: t("Failed"),
    cancelled: t("Stopped"),
  }[run.status];
}

const RETRY_INSTRUCTION =
  "You were stopped before you finished. Pick the ticket up where you left off: your changes so far are still in the worktree.";

/** Picks a stopped ticket up again: the same session when the agent had started. */
async function retry(run: RunView): Promise<void> {
  if (run.agentStarted && run.branch) await api().continueRun(run.id, RETRY_INSTRUCTION);
  else
    await api().startRun(run.projectId, run.issueKey, {
      model: run.model,
      planOnly: run.planOnly,
    });
}

function retryButton(run: RunView): HTMLElement {
  const box = el("div", undefined, "inline");
  const status = el("p", "", "status");
  const go = button(
    run.agentStarted && run.branch ? t("Pick it up again") : t("Try again"),
    () => void busy(go, status, () => retry(run)),
    "primary",
  );
  box.append(go, status);
  return box;
}

const CI_LABELS = { pending: "Checks running", success: "Checks passed", failure: "Checks failed" };

const formatTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** The ticket's most recent run: only it offers to go on. */
function latestRun(run: RunView): RunView | undefined {
  return work.runs.find((r) => r.projectId === run.projectId && r.issueKey === run.issueKey);
}

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

/** What today brought and cost, and how many agents may work at once. */
function usageLine(): HTMLElement {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = work.runs.filter((r) => r.startedAt >= midnight);
  const cost = today.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const pulls = new Set(
    today.filter((r) => r.status === "done" && r.pullRequestUrl).map((r) => r.pullRequestUrl),
  ).size;
  const queued = work.runs.filter((r) => r.status === "queued").length;
  const line = el("div", undefined, "usage");
  const runs = tn(today.length, "{n} run", "{n} runs");
  const spent = `$${cost.toFixed(2)}`;
  line.append(
    el(
      "span",
      !today.length
        ? t("Nothing run today yet")
        : pulls
          ? t("Today: {pulls}, {cost} over {runs}", {
              pulls: tn(pulls, "{n} pull request", "{n} pull requests"),
              cost: spent,
              runs,
            })
          : t("Today: {cost} over {runs}", { cost: spent, runs }),
    ),
    el(
      "span",
      queued
        ? t("{n} at once, {queued} waiting", { n: work.workspace.maxAgents, queued })
        : t("{n} at once", { n: work.workspace.maxAgents }),
      "muted",
    ),
  );
  line.title = t(
    "API-equivalent cost reported by Claude Code. On a subscription it is the share of your quota.",
  );
  return line;
}

/**
 * Offered while the repository has no CLAUDE.md: without one, every agent spends its first
 * minutes rediscovering the code.
 */
async function guideOffer(projectId: string): Promise<HTMLElement | undefined> {
  if (!guides.has(projectId))
    guides.set(
      projectId,
      api()
        .agentGuide(projectId)
        .catch(() => true),
    );
  if (await guides.get(projectId)) return undefined;
  const card = el("div", undefined, "card guide-offer");
  const status = el("p", "", "status");
  const go = button(
    t("Have an agent write it"),
    () =>
      void busy(go, status, async () => {
        const key = await api().prepareProject(projectId);
        guides.set(projectId, Promise.resolve(true));
        issues = undefined;
        view = { kind: "issue", key };
        render();
      }),
    "primary",
  );
  card.append(
    el("strong", t("No CLAUDE.md in this repository")),
    el(
      "p",
      t(
        "Every agent starts by rediscovering the code, on every ticket. A short map of the project (layout, commands, conventions) lets them start right away and spend less.",
      ),
      "muted",
    ),
    go,
    status,
  );
  return card;
}

function renderCreate(): void {
  const project = activeProject()!;
  const status = el("p", "", "status");
  const type = select([["", t("Loading…")]]);
  const summary = input("", t("What needs to be done"));
  const description = textarea("", 8);
  const startAgent = input("", "", "checkbox");
  const startLabel = el("label", undefined, "check");
  startLabel.append(startAgent, ` ${t("Put an agent on it right away")}`);

  const typeField = field(t("Type"), type);
  void busy(undefined, status, async () => {
    const types = await api().issueTypes(project.id);
    // GitHub issues have no types.
    typeField.hidden = types.length === 0;
    type.replaceChildren(...select(types.map((t) => [t.id, t.name])).options);
    const task = types.find((t) => /^(task|tâche)$/i.test(t.name));
    if (task) type.value = task.id;
  });

  const create = button(
    t("Create"),
    () =>
      void busy(create, status, async () => {
        if (!summary.value.trim()) throw new Error(t("A summary is required"));
        const key = await api().createIssue(project.id, {
          issueTypeId: type.value,
          summary: summary.value,
          description: description.value,
        });
        if (startAgent.checked) await api().startRun(project.id, key);
        issues = undefined;
        view = { kind: "issue", key };
        render();
      }),
    "primary",
  );
  body().replaceChildren(
    backButton(),
    el("h3", t("New ticket in {tracker}", { tracker: trackerLabel(project.tracker) })),
    typeField,
    field(t("Summary"), summary),
    field(t("Description"), description),
    startLabel,
    create,
    status,
  );
}

/**
 * What needs the person first, then the agents at work, then each ticket's last run.
 * Older runs of a ticket only show on demand.
 */
function renderAgents(): void {
  const container = body();
  const scroll = container.scrollTop;
  const agentsTab = board.querySelector<HTMLElement>(".tabs button:last-child");
  const needs = needsYou(work.runs, dismissed());
  if (agentsTab) agentsTab.textContent = agentsLabel(needs.length);
  if (!work.runs.length) {
    container.replaceChildren(
      el(
        "p",
        t("No agent has been put on a ticket yet. Open a ticket and press ▶."),
        "muted empty",
      ),
    );
    return;
  }
  const needing = new Set(needs.map((n) => n.run.id));
  const working = work.runs.filter((r) => isActiveRun(r) && !needing.has(r.id));
  const shown = new Set([...needing, ...working.map((r) => r.id)]);
  const rest = (showHistory ? work.runs : latestRuns(work.runs)).filter((r) => !shown.has(r.id));

  const sections: HTMLElement[] = [usageLine()];
  // The usage limit stops every agent at once: they go back together.
  const limited = needs.filter((n) => n.kind === "failed" && isLimitStop(n.run));
  const all =
    limited.length > 1
      ? button(
          t("Pick the {n} up again", { n: limited.length }),
          () => {
            for (const n of limited) void retry(n.run).catch(() => undefined);
          },
          "link",
        )
      : undefined;
  if (needs.length) sections.push(section(t("Needs you"), needs.map(needCard), all));
  else sections.push(el("p", t("Nothing needs you right now."), "muted calm"));
  if (working.length) sections.push(section(t("Working now"), working.map(runCard)));
  if (rest.length) {
    const history = button(
      showHistory ? t("Last run of each ticket only") : t("Show every run"),
      () => {
        showHistory = !showHistory;
        renderAgents();
      },
      "link",
    );
    sections.push(section(t("Recent"), rest.map(runCard), history));
  }
  container.replaceChildren(...sections);
  container.scrollTop = scroll;
}

function section(title: string, cards: HTMLElement[], extra?: HTMLElement): HTMLElement {
  const box = el("section", undefined, "run-section");
  const head = el("div", undefined, "section-head");
  head.append(el("h4", title));
  if (extra) head.append(extra);
  box.append(head, ...cards);
  return box;
}

/** The ticket a card is about, which opens it. */
function cardTitle(run: RunView): HTMLElement {
  const title = el("div", undefined, "issue-head");
  title.append(
    button(run.issueKey, () => void showIssue(run.projectId, run.issueKey), "link"),
    el("span", run.issueSummary),
  );
  return title;
}

/** Something waiting for the person, with what to do about it right there. */
function needCard(need: Need): HTMLElement {
  const { run } = need;
  const card = el("div", undefined, `card need ${need.kind}${isLimitStop(run) ? " limit" : ""}`);
  card.append(cardTitle(run), el("strong", t(need.label, need.vars), "need-label"));
  const questions = questionsBox(run);
  if (questions) {
    card.append(questions);
    return card;
  }
  card.append(runSummary(run, { retry: false }));
  const actions = el("div", undefined, "actions");
  const status = el("p", "", "status");
  if (need.kind === "failed") actions.append(retryButton(run));
  if (need.kind === "review" && run.pullRequestUrl)
    actions.append(
      Object.assign(link(t("Review the pull request"), run.pullRequestUrl), {
        className: "button primary",
      }),
    );
  if (need.kind === "checks") {
    const fix = button(
      t("Ask the agent to fix them"),
      () =>
        void busy(fix, status, () =>
          api().continueRun(
            run.id,
            "The checks of your pull request still fail. Find out why (run the same checks locally), fix the cause, and check it again before finishing.",
          ),
        ),
      "primary",
    );
    actions.append(fix);
  }
  actions.append(
    button(need.kind === "review" ? t("Reviewed") : t("Dismiss"), () => dismiss(run.id)),
  );
  card.append(actions, status);
  return card;
}

function runCard(run: RunView): HTMLElement {
  const card = el("div", undefined, "card");
  card.append(cardTitle(run), runSummary(run));
  const questions = questionsBox(run);
  if (questions) card.append(questions);
  if (run.branch)
    card.append(Object.assign(el("div", run.branch, "muted branch"), { title: run.branch }));
  const actions = el("div", undefined, "actions");
  const status = el("p", "", "status");
  if (isActiveRun(run)) {
    const cancel = button(
      t("Stop"),
      () => void busy(cancel, status, () => api().cancelRun(run.id)),
      "danger",
    );
    actions.append(cancel);
  }
  const open = expandedLogs.has(run.id);
  actions.append(
    button(open ? t("Hide log") : t("Log"), () => {
      if (open) expandedLogs.delete(run.id);
      else expandedLogs.add(run.id);
      renderAgents();
    }),
  );
  card.append(actions, status);
  if (open) card.append(el("pre", run.log.join("\n"), "log"));
  return card;
}
