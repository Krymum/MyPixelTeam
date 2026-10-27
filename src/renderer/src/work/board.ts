import {
  isActiveRun,
  isPreviewable,
  trackerLabel,
  type Attachment,
  type IssueDetail,
  type TicketBranches,
  type IssueSummary,
  type RunView,
} from "../../../shared/work/types";
import { busy, button, el, field, formatDuration, input, link, select, textarea } from "../dom";
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
const expandedLogs = new Set<string>();
/** Issues from untrusted authors the person read and accepted ("<project>:<key>"). */
const confirmedUntrusted = new Set<string>();
/** The ticket's branches on origin, looked up once per opening of the ticket. */
const branchLookups = new Map<string, Promise<TicketBranches>>();
/** Branch picked for the next run ("" = the app's new branch), by "<project>:<key>". */
const chosenBranch = new Map<string, string>();

export function initBoard(node: HTMLElement): void {
  board = node;
  subscribe(() => {
    if (board.hidden) return;
    if (tab === "agents") renderAgents();
    else refreshAgentBox?.();
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
  const close = button("✕", () => toggleBoard(false), "close");
  close.title = "Close";
  const tabs = el("nav", undefined, "tabs");
  const active = work.runs.filter(isActiveRun).length;
  for (const [id, label] of [
    ["tickets", "Tickets"],
    ["agents", `Agents${active ? ` (${active})` : ""}`],
  ] as const) {
    const t = button(label, () => {
      tab = id;
      render();
    });
    if (tab === id) t.className = "selected";
    tabs.append(t);
  }
  board.replaceChildren(close, tabs, el("div", undefined, "board-body"));
  if (tab === "agents") renderAgents();
  else renderTickets();
}

function body(): HTMLElement {
  return board.querySelector<HTMLElement>(".board-body")!;
}

function renderTickets(): void {
  const project = activeProject();
  if (!project) {
    const ready = connected("github") || connected("bitbucket");
    const setup = el("div", undefined, "empty");
    setup.append(
      el("p", ready ? "No project yet." : "Connect GitHub or Bitbucket to see your projects."),
      button(
        ready ? "Create a project" : "Open settings",
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
    project.tracker.kind === "jira" ? "Search, or a key like PROJ-12" : "Search, or #12",
    "search",
  );
  const done = input("", "", "checkbox");
  done.checked = query.includeDone;
  const doneLabel = el("label", undefined, "check");
  doneLabel.append(done, " done too");
  const list = el("ul", undefined, "issues");

  const load = () =>
    void busy(undefined, status, async () => {
      query = { text: search.value, includeDone: done.checked };
      list.replaceChildren(el("li", "Loading…", "muted"));
      issues = await api().issues(project.id, query);
      showIssues();
    }).then(() => {
      if (!issues) list.replaceChildren();
    });
  const showIssues = () => {
    list.replaceChildren(
      ...(issues!.length ? issues!.map(issueRow) : [el("li", "No tickets.", "muted")]),
    );
  };
  search.addEventListener("keydown", (e) => e.key === "Enter" && load());
  done.addEventListener("change", load);

  const toolbar = el("div", undefined, "toolbar");
  toolbar.append(
    search,
    doneLabel,
    button("↻", load),
    button(
      "+ New",
      () => {
        view = { kind: "create" };
        render();
      },
      "primary",
    ),
  );
  body().replaceChildren(
    el("h3", `${project.name} · ${trackerLabel(project.tracker)}`),
    toolbar,
    status,
    list,
  );
  if (issues) showIssues();
  else load();
}

function issueRow(issue: IssueSummary): HTMLElement {
  const li = el("li");
  li.tabIndex = 0;
  const run = runsOf(issue.key).find(isActiveRun);
  const head = el("div", undefined, "issue-head");
  head.append(
    el("strong", issue.key),
    pill(issue.status, issue.statusCategory),
    el("span", issue.type, "muted"),
  );
  if (run) head.append(el("span", "● agent", "agent-tag"));
  li.append(head, el("div", issue.summary));
  if (issue.assignee) li.append(el("div", issue.assignee, "muted"));
  const open = () => {
    view = { kind: "issue", key: issue.key };
    render();
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => e.key === "Enter" && open());
  return li;
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
  return button("← Tickets", () => {
    view = { kind: "list" };
    render();
  });
}

async function renderIssue(key: string): Promise<void> {
  const status = el("p", "", "status");
  body().replaceChildren(backButton(), el("p", `Loading ${key}…`, "muted"), status);
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

  const summary = input(issue.summary);
  summary.readOnly = !can.edit;
  const description = textarea(issue.description, 10);
  description.readOnly = !can.edit;

  const head = el("div", undefined, "issue-head");
  head.append(
    link(issue.key, issue.url),
    pill(issue.status, issue.statusCategory),
    el("span", issue.type, "muted"),
  );
  if (issue.priority) head.append(el("span", issue.priority, "muted"));

  const statusRow = el("div", undefined, "inline");
  if (can.transition && issue.transitions.length) {
    const transitions = select([
      ["", "Move to…"],
      ...issue.transitions.map((t): [string, string] => [
        t.id,
        t.name === t.to ? t.to : `${t.name} → ${t.to}`,
      ]),
    ]);
    const apply = button("Apply", () => {
      if (!transitions.value) return;
      void busy(apply, status, () => api().transition(project.id, key, transitions.value)).then(
        reload,
      );
    });
    statusRow.append(transitions, apply);
  } else
    statusRow.append(
      el(
        "span",
        can.transition ? "No transition available" : "You can't change the status",
        "muted",
      ),
    );

  const editRow = el("div", undefined, "actions");
  if (can.edit) {
    const save = button(
      "Save",
      () =>
        void busy(save, status, async () => {
          const changes = {
            summary: summary.value !== issue.summary ? summary.value : undefined,
            description: description.value !== issue.description ? description.value : undefined,
          };
          await api().updateIssue(project.id, key, changes);
          reload();
        }),
      "primary",
    );
    editRow.append(save);
    if (project.tracker.kind === "jira")
      editRow.append(
        el(
          "small",
          "Saving the description keeps paragraphs only: rich formatting is lost.",
          "muted",
        ),
      );
  }

  const agentBox = el("div", undefined, "card agent-box");
  refreshAgentBox = () => renderAgentBox(agentBox, issue);
  refreshAgentBox();

  const comments = el("ol", undefined, "comments");
  for (const c of [...issue.comments].reverse()) {
    const li = el("li");
    li.append(
      el(
        "div",
        `${c.author} · ${new Date(c.created).toLocaleString()}${c.trusted ? "" : " · not a collaborator: hidden from agents"}`,
        "muted",
      ),
      el("div", c.text, "pre"),
    );
    comments.append(li);
  }
  const commentBox = el("div");
  if (can.comment) {
    const text = textarea("", 3);
    text.placeholder = "Add a comment";
    const send = button("Comment", () => {
      if (!text.value.trim()) return;
      void busy(send, status, () => api().comment(project.id, key, text.value)).then(reload);
    });
    commentBox.append(text, send);
  }

  body().replaceChildren(
    backButton(),
    head,
    status,
    field("Summary", summary),
    field("Status", statusRow),
    field("Description", description),
    editRow,
    ...(issue.attachments.length ? [attachmentsBox(project.id, issue.attachments)] : []),
    agentBox,
    el("h4", `Comments (${issue.comments.length})`),
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
  box.append(el("h4", `Attachments (${attachments.length})`));
  for (const a of attachments) {
    const item = el("div", undefined, "attachment");
    const status = el("p", "", "status");
    const head = el("div", undefined, "issue-head");
    head.append(el("strong", a.filename), el("span", formatSize(a.size), "muted"));
    if (a.author) head.append(el("span", a.author, "muted"));
    const actions = el("div", undefined, "actions");
    const save = button(
      "Save…",
      () =>
        void busy(save, status, async () => {
          const path = await api().saveAttachment(projectId, a.id, a.filename);
          if (path) {
            status.textContent = `Saved to ${path}`;
            status.className = "status ok";
          }
        }),
    );
    actions.append(save);
    if (a.url) actions.append(link("Open in Jira", a.url));
    item.append(head);
    if (isPreviewable(a)) {
      const img = el("img");
      img.alt = a.filename;
      img.className = "preview";
      img.title = "Click to enlarge";
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

function renderAgentBox(box: HTMLElement, issue: IssueDetail): void {
  const runs = runsOf(issue.key);
  const active = runs.find(isActiveRun);
  const last = runs[0];
  const status = el("p", "", "status");
  box.replaceChildren(el("h4", "Agent"));
  if (active) {
    box.append(runSummary(active));
    const questions = questionsBox(active);
    if (questions) box.append(questions);
    const cancel = button(
      "Stop the agent",
      () => void busy(cancel, status, () => api().cancelRun(active.id)),
      "danger",
    );
    box.append(cancel, status);
    return;
  }
  if (last) box.append(runSummary(last));
  const project = activeProject()!;
  const trustKey = `${project.id}:${issue.key}`;
  const start = button(
    last ? "▶ Put an agent on it again" : "▶ Put an agent on it",
    () =>
      void busy(start, status, async () => {
        await api().startRun(project.id, issue.key, {
          allowUntrusted: confirmedUntrusted.has(trustKey),
          branch: chosenBranch.get(trustKey) || undefined,
        });
      }),
    "primary",
  );
  box.append(
    el(
      "p",
      `Works in a worktree of ${project.repo.fullName}, ${project.agent.openPullRequest ? "then opens a pull request" : "then commits locally"}.`,
      "muted",
    ),
  );
  if (!issue.trusted) {
    // The issue text becomes the agent's instructions: a stranger could make it run anything.
    const warning = el("div", undefined, "trust-warning");
    warning.append(
      el(
        "p",
        `Opened by ${issue.author ?? "someone"}, who is not a collaborator of this repository. Its text becomes the agent's instructions: read it before going on.`,
      ),
    );
    const confirm = input("", "", "checkbox");
    confirm.checked = confirmedUntrusted.has(trustKey);
    const label = el("label", undefined, "check");
    label.append(confirm, " I read this issue and trust what it asks");
    confirm.addEventListener("change", () => {
      if (confirm.checked) confirmedUntrusted.add(trustKey);
      else confirmedUntrusted.delete(trustKey);
      start.disabled = !confirm.checked;
    });
    start.disabled = !confirm.checked;
    warning.append(label);
    box.append(warning);
  }
  if (issue.publicRepo)
    box.append(
      el(
        "p",
        "Public repository: comments from people who aren't collaborators are never shown to the agent.",
        "muted",
      ),
    );
  box.append(branchPicker(project.id, issue, trustKey), start, status);
}

/**
 * Where the agent works: a new branch from the base, or an existing one on origin whose name
 * mentions the ticket (work a colleague or an earlier run started), proposed first.
 */
function branchPicker(projectId: string, issue: IssueDetail, key: string): HTMLElement {
  const box = el("div", undefined, "branch-picker");
  const choice = select([["", "Looking for this ticket's branches on origin…"]]);
  choice.disabled = true;
  const hint = el("small", "", "muted");
  const status = el("p", "", "status");
  box.append(field("Branch", choice), hint, status);
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
            ? `${branches.newBranch} (continue the earlier run)`
            : `New: ${branches.newBranch}, from ${branches.base}`,
        ],
        ...others.map((b): [string, string] => [b, `Existing: ${b}`]),
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
      ? `${others.length === 1 ? "A branch" : `${others.length} branches`} on origin mention ${issue.key}: the work may have started there.`
      : `No other branch on origin mentions ${issue.key}.`;
  }).then(() => {
    if (!choice.disabled) return;
    // Lookup failed (shown in status): a new branch still works.
    choice.replaceChildren(...select([["", "New branch from the base"]]).options);
    choice.disabled = false;
    chosenBranch.set(key, "");
  });
  return box;
}

function runSummary(run: RunView): HTMLElement {
  const div = el("div", undefined, "run-summary");
  const head = el("div", undefined, "issue-head");
  head.append(
    el("span", run.status, `run-status ${run.status}`),
    el("span", formatDuration((run.endedAt ?? Date.now()) - run.startedAt), "muted"),
  );
  if (run.costUsd !== undefined) head.append(el("span", `$${run.costUsd.toFixed(2)}`, "muted"));
  div.append(head);
  if (run.pullRequestUrl) div.append(link("Pull request", run.pullRequestUrl));
  if (run.error) div.append(el("div", run.error, "bad pre"));
  const lastLine = run.log.at(-1);
  if (lastLine && isActiveRun(run)) div.append(el("div", lastLine, "muted"));
  return div;
}

function renderCreate(): void {
  const project = activeProject()!;
  const status = el("p", "", "status");
  const type = select([["", "Loading…"]]);
  const summary = input("", "What needs to be done");
  const description = textarea("", 8);
  const startAgent = input("", "", "checkbox");
  const startLabel = el("label", undefined, "check");
  startLabel.append(startAgent, " Put an agent on it right away");

  const typeField = field("Type", type);
  void busy(undefined, status, async () => {
    const types = await api().issueTypes(project.id);
    // GitHub issues have no types.
    typeField.hidden = types.length === 0;
    type.replaceChildren(...select(types.map((t) => [t.id, t.name])).options);
    const task = types.find((t) => /^(task|tâche)$/i.test(t.name));
    if (task) type.value = task.id;
  });

  const create = button(
    "Create",
    () =>
      void busy(create, status, async () => {
        if (!summary.value.trim()) throw new Error("A summary is required");
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
    el("h3", `New ticket in ${trackerLabel(project.tracker)}`),
    typeField,
    field("Summary", summary),
    field("Description", description),
    startLabel,
    create,
    status,
  );
}

function renderAgents(): void {
  const container = body();
  const scroll = container.scrollTop;
  if (!work.runs.length) {
    container.replaceChildren(
      el("p", "No agent has been put on a ticket yet. Open a ticket and press ▶.", "muted empty"),
    );
    return;
  }
  container.replaceChildren(
    ...work.runs.map((run) => {
      const card = el("div", undefined, "card");
      const title = el("div", undefined, "issue-head");
      const key = button(run.issueKey, () => void showIssue(run.projectId, run.issueKey), "link");
      title.append(key, el("span", run.issueSummary));
      card.append(title, runSummary(run));
      const questions = questionsBox(run);
      if (questions) card.append(questions);
      if (run.branch) card.append(el("div", run.branch, "muted"));
      const actions = el("div", undefined, "actions");
      const status = el("p", "", "status");
      if (isActiveRun(run)) {
        const cancel = button(
          "Stop",
          () => void busy(cancel, status, () => api().cancelRun(run.id)),
          "danger",
        );
        actions.append(cancel);
      }
      const open = expandedLogs.has(run.id);
      actions.append(
        button(open ? "Hide log" : "Log", () => {
          if (open) expandedLogs.delete(run.id);
          else expandedLogs.add(run.id);
          renderAgents();
        }),
      );
      card.append(actions, status);
      if (open) card.append(el("pre", run.log.join("\n"), "log"));
      return card;
    }),
  );
  container.scrollTop = scroll;
}
