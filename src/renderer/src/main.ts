import { MAP_H, MAP_W, TILE, ZONES } from "../../shared/engine/office-map";
import type { AgentRecord } from "../../shared/engine/office-state";
import { OfficeSimulation, type Activity, type Actor } from "../../shared/engine/simulation";
import { logoSvg } from "./logo";
import { renderPanel } from "./panel";
import { drawBackground, SCENERY, type Drawable } from "./scenery";
import { FRAME_H, FRAME_W } from "./sprites/character-art";
import type { Pose } from "./sprites/character";
import { characterSprite, forgetCharacter } from "./sprites/cache";
import { needsYou } from "../../shared/work/run-state";
import { trackerLabel, type RunView } from "../../shared/work/types";
import {
  boardBack,
  focusSearch,
  initBoard,
  resetBoard,
  showAgents,
  showIssue,
  toggleBoard,
} from "./work/board";
import { waitingRuns } from "./work/questions-ui";
import { initSettings, openSettings } from "./work/settings";
import { dismissed } from "./work/dismissed";
import { initToasts } from "./work/toasts";
import { checkMachine, initWelcome, openWelcome } from "./work/welcome";
import { activeProject, loadWork, subscribe, update, work } from "./work/store";

const WIDTH = MAP_W * TILE;
const HEIGHT = MAP_H * TILE;
const STRIDE = 5; // px walked per animation frame
const WALK_CYCLE: Pose[] = ["stepA", "stand", "stepB", "stand"];
const BUBBLE_MAX = 28;

const canvas = document.querySelector<HTMLCanvasElement>("#office")!;
const ctx = canvas.getContext("2d")!;
const panel = document.querySelector<HTMLElement>("#panel")!;
const serverStatus = document.querySelector<HTMLElement>("#server-status")!;
const agentCount = document.querySelector<HTMLElement>("#agent-count")!;
document.querySelector("#brand")!.prepend(logoSvg());
const projectSelect = document.querySelector<HTMLSelectElement>("#project-select")!;
const machineWarning = document.querySelector<HTMLButtonElement>("#machine-warning")!;
const waitingAgents = document.querySelector<HTMLButtonElement>("#waiting-agents")!;

// The scene is composed at 1x, then blown up by an integer factor for crisp pixels.
const buffer = document.createElement("canvas");
buffer.width = WIDTH;
buffer.height = HEIGHT;
const bctx = buffer.getContext("2d")!;
const background = document.createElement("canvas");
background.width = WIDTH;
background.height = HEIGHT;
drawBackground(background.getContext("2d")!);

const sim = new OfficeSimulation();
const drawn = new Set<string>();
let selectedId: string | undefined;
let scale = 2;
/** The app's runs by agent session: their characters go by their ticket. */
let runsBySession = new Map<string, RunView>();

function runOf(agent: AgentRecord): RunView | undefined {
  return agent.parentId ? undefined : runsBySession.get(agent.sessionId);
}

/** Small per-agent number so animations of different agents don't run in lockstep. */
function phase(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h >>> 0) % 1000;
}

function poseFor(actor: Actor, activity: Activity, t: number): Pose {
  switch (activity) {
    case "walking":
      return WALK_CYCLE[Math.floor(actor.walked / STRIDE) % WALK_CYCLE.length]!;
    case "typing": {
      // Bursts of typing with short pauses, like a real person.
      const local = t + phase(actor.id) / 100;
      if (local % 3 > 2.4) return "stand";
      return Math.floor(local * 7) % 2 ? "typeA" : "typeB";
    }
    case "coffee":
      return "coffee";
    default:
      return "stand";
  }
}

function actorDrawable(actor: Actor, t: number): Drawable {
  return {
    baseline: actor.y,
    draw(c) {
      const activity = sim.activity(actor);
      const x = Math.round(actor.x);
      const y = Math.round(actor.y);
      c.fillStyle = actor.id === selectedId ? "#ffffffaa" : "#00000050";
      c.fillRect(x - 5, y - 1, 10, 2);
      c.fillRect(x - 4, y - 2, 8, 4);
      // Seated agents sink into their chair; failing ones shiver.
      const sink = sim.isSeated(actor) ? 3 : 0;
      const shake = activity === "error" && Math.floor(t * 12) % 4 === 0 ? 1 : 0;
      c.drawImage(
        characterSprite(actor.id, actor.agent.source, actor.direction, poseFor(actor, activity, t)),
        x - FRAME_W / 2 + shake,
        y - FRAME_H + sink,
      );
    },
  };
}

function resize(): void {
  const stage = canvas.parentElement!;
  const fit = Math.min(stage.clientWidth / WIDTH, stage.clientHeight / HEIGHT);
  // Whole multiples keep every pixel the same size; below 2x (a narrow window, the ticket
  // board open) the office uses the room it has rather than dropping to a tiny 1x.
  scale = fit >= 2 ? Math.floor(fit) : Math.max(1, Math.floor(fit * 10) / 10);
  canvas.width = Math.round(WIDTH * scale);
  canvas.height = Math.round(HEIGHT * scale);
}

function truncate(text: string): string {
  return text.length > BUBBLE_MAX ? `${text.slice(0, BUBBLE_MAX - 1)}…` : text;
}

function lastMessage(agent: AgentRecord): string | undefined {
  return agent.history.at(-1)?.detail.message;
}

interface Bubble {
  text: string;
  bg: string;
}

function bubbleFor(actor: Actor, activity: Activity, t: number): Bubble | undefined {
  const agent = actor.agent;
  if (actor.leaving) {
    // The session ends before the app pushes: the character says how it went.
    const run = runOf(agent);
    if (run?.status === "publishing") return { text: "pushing…", bg: "#f4f1e8" };
    if (run?.status === "done" && run.pullRequestUrl) return { text: "PR opened!", bg: "#9ee0ad" };
    return { text: "bye!", bg: "#f4f1e8" };
  }
  switch (activity) {
    case "thinking":
      return { text: ".".repeat(1 + (Math.floor(t * 2.5) % 3)).padEnd(3, " "), bg: "#f4f1e8" };
    case "waiting": {
      const blink = Math.floor(t * 2) % 2 === 0;
      const msg = lastMessage(agent);
      return { text: msg ? `? ${truncate(msg)}` : "?", bg: blink ? "#f2c94c" : "#f7dd8a" };
    }
    case "error": {
      const msg = lastMessage(agent);
      return { text: msg ? `! ${truncate(msg)}` : "!", bg: "#ef6b6b" };
    }
    case "coffee":
      return undefined;
    default:
      return agent.status === "working" && agent.summary
        ? { text: truncate(agent.summary), bg: "#f4f1e8" }
        : undefined;
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen-space box of a label centered on cx, kept inside the canvas. */
function labelBox(text: string, cx: number, top: number): Box {
  const w = Math.ceil(ctx.measureText(text).width) + 6 * scale;
  return {
    x: Math.round(Math.min(Math.max(cx - w / 2, 0), canvas.width - w)),
    y: Math.round(top),
    w,
    h: 9 * scale,
  };
}

/** Text is drawn at screen resolution so it stays readable. */
function paintLabel(box: Box, text: string, bg: string, fg: string): void {
  ctx.fillStyle = bg;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = fg;
  ctx.fillText(text, box.x + 3 * scale, box.y + 1.5 * scale);
}

function drawLabel(text: string, cx: number, top: number, bg: string, fg: string): void {
  paintLabel(labelBox(text, cx, top), text, bg, fg);
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function forgetDeparted(): void {
  for (const id of drawn) {
    if (sim.actors.has(id)) continue;
    drawn.delete(id);
    forgetCharacter(id);
    if (selectedId === id) selectedId = undefined;
  }
  for (const id of sim.actors.keys()) drawn.add(id);
}

function draw(dt: number, t: number): void {
  sim.tick(dt, Date.now());
  forgetDeparted();
  const actors = [...sim.actors.values()];

  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(background, 0, 0);
  const drawables = [...SCENERY, ...actors.map((a) => actorDrawable(a, t))].sort(
    (a, b) => a.baseline - b.baseline,
  );
  for (const d of drawables) d.draw(bctx, t);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);

  ctx.font = `${6 * scale}px ui-monospace, Consolas, monospace`;
  ctx.textBaseline = "top";
  for (const z of Object.values(ZONES)) {
    if (!z.label) continue;
    const labelY = z.id === "reception" ? (z.y + z.h - 1) * TILE + 4 : (z.y - 1) * TILE + 5;
    drawLabel(z.label, (z.x + 2) * TILE * scale, labelY * scale, "#2a1f2ecc", "#e8e6f0");
  }

  for (const actor of actors) {
    const run = runOf(actor.agent);
    const name = actor.agent.parentId
      ? `↳ ${actor.agent.name}`
      : run
        ? run.issueKey
        : actor.agent.name;
    drawLabel(name, actor.x * scale, (actor.y + 2) * scale, "#00000099", "#ffffffdd");
  }

  // Bubbles of neighbours stack upwards instead of overlapping.
  const placed: Box[] = [];
  for (const actor of [...actors].sort((a, b) => b.y - a.y)) {
    const bubble = bubbleFor(actor, sim.activity(actor), t);
    if (!bubble) continue;
    const sink = sim.isSeated(actor) ? 3 : 0;
    const box = labelBox(bubble.text, actor.x * scale, (actor.y - FRAME_H + sink - 11) * scale);
    while (box.y > 0 && placed.some((p) => overlaps(p, box))) box.y -= box.h + scale;
    placed.push(box);
    paintLabel(box, bubble.text, bubble.bg, "#1b1b24");
  }
}

function actorAt(clientX: number, clientY: number): Actor | undefined {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) * (canvas.width / rect.width)) / scale;
  const y = ((clientY - rect.top) * (canvas.height / rect.height)) / scale;
  return [...sim.actors.values()]
    .filter((a) => Math.abs(a.x - x) <= FRAME_W / 2 && y <= a.y + 2 && y >= a.y - FRAME_H)
    .sort((a, b) => b.y - a.y)[0];
}

function refreshChrome(): void {
  const agents = sim.state.agents;
  const selected = selectedId
    ? (agents[selectedId] ?? sim.actors.get(selectedId)?.agent)
    : undefined;
  const parent = selected?.parentId ? agents[selected.parentId] : undefined;
  const run = selected && runOf(selected);
  renderPanel(
    panel,
    selected,
    parent?.name,
    () => {
      selectedId = undefined;
      refreshChrome();
    },
    run && { view: run, openIssue: () => void showIssue(run.projectId, run.issueKey) },
  );
  const count = Object.keys(agents).length;
  agentCount.textContent = count
    ? `${count} agent${count === 1 ? "" : "s"} in the office`
    : "Nobody in the office";
}

async function refreshStatus(): Promise<void> {
  const info = await window.office.info();
  const parts: HTMLElement[] = [];
  const status = document.createElement("span");
  status.className = info.listening ? "lamp ok" : "lamp bad";
  status.textContent = info.listening ? "Live" : `Not live: ${info.error ?? "unknown error"}`;
  status.title = info.listening
    ? `The office shows Claude Code sessions as they work (they report to ${info.url})`
    : "The office can't hear Claude Code sessions";
  parts.push(status);
  if (info.demo) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Demo";
    parts.push(badge);
  }
  if (info.transcripts) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "+ your other sessions";
    badge.title = `Your Claude Code sessions outside the app show in the office too (from ${info.transcripts})`;
    parts.push(badge);
  }
  if (info.configError) {
    const warn = document.createElement("span");
    warn.className = "bad";
    warn.textContent = "office.config.json ignored (see terminal)";
    warn.title = info.configError;
    parts.push(warn);
  }
  serverStatus.replaceChildren(...parts);
}

function renderProjectSelect(): void {
  const { projects } = work.workspace;
  projectSelect.hidden = projects.length === 0;
  projectSelect.replaceChildren(
    ...projects.map((p) => {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = `${p.name} (${trackerLabel(p.tracker)})`;
      return option;
    }),
  );
  projectSelect.value = activeProject()?.id ?? "";
}

/** Top bar warning when agents can't run on this machine. */
function renderMachineWarning(): void {
  const env = work.environment;
  const problem = env && [env.git, env.claude, env.claudeAuth].find((c) => !c.ok);
  machineWarning.hidden = !problem;
  if (!problem) return;
  machineWarning.textContent = `Agents can't run: ${problem.detail}`;
  machineWarning.title = "Open the setup guide";
}

function initWork(): void {
  initSettings(document.querySelector<HTMLDialogElement>("#settings")!);
  initWelcome(document.querySelector<HTMLDialogElement>("#welcome")!);
  machineWarning.addEventListener("click", () => openWelcome(0));
  waitingAgents.addEventListener("click", showAgents);
  window.office.work.onOpenIssue((projectId, key) => void showIssue(projectId, key));
  initBoard(document.querySelector<HTMLElement>("#board")!);
  initToasts();
  document.querySelector("#open-settings")!.addEventListener("click", () => openSettings());
  document.querySelector("#open-board")!.addEventListener("click", () => toggleBoard());
  projectSelect.addEventListener("change", async () => {
    update({ workspace: await window.office.work.setActiveProject(projectSelect.value) });
    resetBoard();
  });
  let shownProject = activeProject()?.id;
  subscribe(() => {
    runsBySession = new Map();
    // Runs come newest first: a continued run takes over its session.
    for (const run of [...work.runs].reverse()) runsBySession.set(run.sessionId, run);
    renderProjectSelect();
    renderMachineWarning();
    // Questions first: an agent is blocked until it gets an answer.
    const waiting = waitingRuns(work.runs).length;
    const needs = needsYou(work.runs, dismissed()).length;
    waitingAgents.hidden = needs === 0;
    waitingAgents.classList.toggle("urgent", waiting > 0);
    waitingAgents.textContent = waiting
      ? `${waiting} agent${waiting > 1 ? "s" : ""} waiting for you`
      : `${needs} thing${needs > 1 ? "s" : ""} for you`;
    // Deleting or creating the first project changes the active one.
    if (activeProject()?.id !== shownProject) {
      shownProject = activeProject()?.id;
      resetBoard();
    }
  });
  void loadWork()
    .then(() => {
      // First launch: walk through the setup. Existing users with projects are left alone.
      if (!work.workspace.onboarded && work.workspace.projects.length === 0) openWelcome();
    })
    .catch((err) => console.error("could not load work settings", err));
  void checkMachine().catch((err) => console.error("could not check the machine", err));
}

async function boot(): Promise<void> {
  initWork();
  await refreshStatus();
  const { openOnStart } = await window.office.info();
  if (openOnStart === "board") toggleBoard(true);
  if (openOnStart === "settings") openSettings();
  for (const event of await window.office.history()) sim.ingest(event);
  window.office.onEvent((event) => {
    sim.ingest(event);
    refreshChrome();
  });

  document.addEventListener("keydown", (e) => {
    // Dialogs handle their own keys; typing in a field is not a shortcut.
    if (document.querySelector("dialog[open]") || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = (e.target as HTMLElement).closest("input, textarea, select");
    if (e.key === "Escape") {
      if (typing) return void (e.target as HTMLElement).blur();
      if (selectedId) {
        selectedId = undefined;
        refreshChrome();
      } else boardBack();
      return;
    }
    if (typing) return;
    if (e.key === "/") {
      e.preventDefault();
      focusSearch();
    } else if (e.key === "t") toggleBoard();
    else if (e.key === "a") showAgents();
  });

  canvas.addEventListener("click", (e) => {
    const actor = actorAt(e.clientX, e.clientY);
    selectedId = actor?.id;
    // An agent of the app: its ticket says more than the session's details.
    const run = actor && runOf(actor.agent);
    if (run) void showIssue(run.projectId, run.issueKey);
    refreshChrome();
  });
  // The stage changes size with the window and when the ticket board opens or closes.
  new ResizeObserver(resize).observe(canvas.parentElement!);
  resize();
  refreshChrome();
  // Keep the "on duty" duration ticking and pick up config changes.
  setInterval(refreshChrome, 1000);
  setInterval(() => void refreshStatus(), 5000);

  let last = performance.now();
  const frame = (now: number) => {
    // rAF timestamps can predate the performance.now() taken at boot.
    draw(Math.min(0.1, Math.max(0, (now - last) / 1000)), now / 1000);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void boot();
