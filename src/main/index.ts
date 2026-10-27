import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { IPC, type ServerInfo } from "../preload/api";
import { createRoleResolver, DEFAULT_CONFIG } from "../shared/config/office-config";
import { createDemoScenario } from "../shared/demo/scenario";
import { normalizers } from "../shared/normalize";
import type { OfficeEvent } from "../shared/protocol/schema";
import { loadConfig, watchConfig, type LoadedConfig } from "./config";
import { createIngestServer, listen } from "./server";
import { defaultTranscriptRoot, TranscriptWatcher } from "./transcripts";
import { settingsPath } from "../../scripts/setup/claude.mjs";
import { AccountStore } from "./work/accounts";
import { registerWorkIpc } from "./work/ipc";
import { Notifier } from "./work/notify";
import { AgentRunner } from "./work/runner";
import { CommentWatcher } from "./work/comment-watch";
import { WorkspaceStore } from "./work/workspace";

// The app was called Agent Office: its accounts, projects, clones and worktrees live in
// %APPDATA%/agent-office (worktrees are registered in the clones by absolute path, so the
// folder can't simply move). Keep it, unless --user-data-dir says otherwise.
if (!app.commandLine.hasSwitch("user-data-dir"))
  app.setPath("userData", join(app.getPath("appData"), "agent-office"));

const PORT = Number(process.env.AGENT_OFFICE_PORT ?? 4777);
const TOKEN = process.env.AGENT_OFFICE_TOKEN || undefined;
const DEMO = process.argv.includes("--demo") || process.env.AGENT_OFFICE_DEMO === "1";
const TRANSCRIPTS = process.env.AGENT_OFFICE_TRANSCRIPTS !== "0";
const HISTORY_LIMIT = 2000;
/** Claude Code sessions that report through hooks; their transcripts would duplicate them. */
const hookedSessions = new Set<string>();

const history: OfficeEvent[] = [];
const BUNDLED_CONFIG = join(app.getAppPath(), "office.config.json");
const CONFIG_PATH = process.env.AGENT_OFFICE_CONFIG ?? defaultConfigPath();

/** In the packaged .exe the bundled file is read-only: edit a copy in the user data folder. */
function defaultConfigPath(): string {
  if (!app.isPackaged) return BUNDLED_CONFIG;
  const path = join(app.getPath("userData"), "office.config.json");
  if (!existsSync(path) && existsSync(BUNDLED_CONFIG)) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(BUNDLED_CONFIG, path);
  }
  return path;
}

const OPEN = process.env.AGENT_OFFICE_OPEN;
const info: ServerInfo = {
  url: `http://127.0.0.1:${PORT}`,
  listening: false,
  demo: DEMO,
  openOnStart: OPEN === "board" || OPEN === "settings" ? OPEN : undefined,
};
let win: BrowserWindow | null = null;
let resolveRole = createRoleResolver(DEFAULT_CONFIG);
let runner: AgentRunner | undefined;
let comments: CommentWatcher | undefined;
let notifier: Notifier | undefined;

function useConfig(loaded: LoadedConfig): void {
  resolveRole = createRoleResolver(loaded.config);
  info.configPath = loaded.path;
  info.configError = loaded.error;
  if (loaded.error) console.error(`[mypixelteam] ${loaded.path} ignored: ${loaded.error}`);
  else console.log(`[mypixelteam] roles from ${loaded.path}`);
}

function publish(raw: OfficeEvent): void {
  // An agent working on a ticket is named after it.
  const run = raw.parentAgentId ? undefined : runner?.bySession(raw.sessionId);
  const named = run ? { ...raw, agentName: run.issueKey } : raw;
  // Roles are decided once here so every consumer (and the history) agrees.
  const event = { ...named, role: resolveRole(named) };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  win?.webContents.send(IPC.event, event);
  notifier?.event(event, run);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "MyPixelTeam",
    // Windows' taskbar takes its sizes from the .ico; elsewhere the PNG.
    icon: join(
      app.getAppPath(),
      "resources",
      process.platform === "win32" ? "icon.ico" : "icon.png",
    ),
    backgroundColor: "#1c1721",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.on("closed", () => (win = null));
  // Never navigate away from the office; open external links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // Surface renderer errors in the terminal.
  win.webContents.on("console-message", (e) => {
    if (e.level === "error")
      console.error(`[renderer] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on("preload-error", (_, path, err) => console.error(`[preload] ${path}`, err));

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

function startDemo(): void {
  const scenario = createDemoScenario(Date.now() % 100000);
  setInterval(() => scenario.step(Date.now()).forEach(publish), 200);
}

/** Shows every Claude Code session on the machine, hooks or not. */
function startTranscripts(): void {
  const root = defaultTranscriptRoot(app.getPath("home"));
  const watcher = new TranscriptWatcher({
    root,
    onEvent: (event) => {
      if (!hookedSessions.has(event.sessionId)) publish(event);
    },
  });
  watcher.start();
  info.transcripts = root;
  console.log(`[mypixelteam] following Claude Code transcripts in ${root}`);
}

async function startServer(): Promise<void> {
  const server = createIngestServer({
    token: TOKEN,
    normalizers,
    onEvent: (event) => {
      if (event.source === "claude-code") hookedSessions.add(event.sessionId);
      publish(event);
    },
  });
  try {
    await listen(server, PORT);
    info.listening = true;
    console.log(`[mypixelteam] listening on ${info.url}${TOKEN ? " (token required)" : ""}`);
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err);
    console.error(`[mypixelteam] could not listen on ${info.url}: ${info.error}`);
  }
}

// Windows shows notifications under this name.
// The packaged app's id, so the taskbar groups and labels the window as MyPixelTeam
// rather than as Electron.
if (process.platform === "win32") app.setAppUserModelId("com.mypixelteam.app");

// A second launch would fail to bind the port: focus the running window instead.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

/**
 * The hook script Claude Code runs. The portable .exe unpacks itself to a new temporary
 * folder on every launch, so it copies the script to the user data folder, which stays put.
 */
function adapterPath(): string {
  if (!app.isPackaged) return join(app.getAppPath(), "adapters", "claude-code.mjs");
  const shipped = join(process.resourcesPath, "app.asar.unpacked", "adapters");
  const target = join(app.getPath("userData"), "adapters");
  mkdirSync(target, { recursive: true });
  for (const file of ["claude-code.mjs", "forward.mjs"])
    copyFileSync(join(shipped, file), join(target, file));
  return join(target, "claude-code.mjs");
}

/** Jira, code hosts and the agents the app starts on tickets. */
function startWork(): void {
  const data = app.getPath("userData");
  const accounts = new AccountStore(join(data, "accounts.bin"), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  });
  const workspace = new WorkspaceStore(join(data, "workspace.json"), join(data, "repos"));
  const worktreesDir = join(data, "worktrees");
  const claude = process.env.AGENT_OFFICE_CLAUDE || "claude";
  notifier = new Notifier({
    enabled: () => workspace.view().notifications,
    window: () => win,
    openIssue: (run) => win?.webContents.send(IPC.openIssue, run.projectId, run.issueKey),
  });
  runner = new AgentRunner({
    accounts,
    workspace,
    worktreesDir,
    claude,
    historyPath: join(data, "runs.json"),
    onChange: (runs) => win?.webContents.send(IPC.runs, runs),
    onFinished: (run) => notifier?.run(run),
    // The character raises its hand while a question waits, and goes back to work after.
    onQuestion: (run, question) => {
      const waiting = question ?? run.questions?.[0];
      publish({
        v: 1,
        type: waiting ? "agent.waiting" : "agent.thinking",
        source: "claude-code",
        sessionId: run.sessionId,
        agentId: run.sessionId,
        agentName: run.issueKey,
        cwd: run.worktree,
        timestamp: new Date().toISOString(),
        detail: waiting ? { message: `Allow ${waiting.summary}?` } : {},
      });
    },
    // The character walks in right away; transcripts (or hooks) then show its work.
    onSession: (run, phase) =>
      publish({
        v: 1,
        type: phase === "started" ? "agent.started" : "agent.ended",
        source: "claude-code",
        sessionId: run.sessionId,
        agentId: run.sessionId,
        agentName: run.issueKey,
        cwd: run.worktree,
        timestamp: new Date().toISOString(),
        detail: phase === "started" ? { message: run.issueSummary } : {},
      }),
  });
  comments = new CommentWatcher({ runner, accounts, workspace });
  comments.start();
  registerWorkIpc({
    accounts,
    workspace,
    runner,
    window: () => win,
    claude,
    transcriptRoot: defaultTranscriptRoot(app.getPath("home")),
    ownFolders: [worktreesDir],
    hooks: { settingsPath: settingsPath("user"), adapterPath: adapterPath() },
  });
}

app.whenReady().then(async () => {
  ipcMain.handle(IPC.history, () => history);
  ipcMain.handle(IPC.info, () => info);
  startWork();
  useConfig(loadConfig(CONFIG_PATH));
  watchConfig(CONFIG_PATH, useConfig);
  await startServer();
  // Before the window, so its first status read and history already include them.
  if (!DEMO && TRANSCRIPTS) startTranscripts();
  createWindow();
  if (DEMO) startDemo();
  // Dev aid: AGENT_OFFICE_SCREENSHOT=out.png saves a capture of the window after
  // AGENT_OFFICE_SCREENSHOT_DELAY ms (default 12 s).
  const shot = process.env.AGENT_OFFICE_SCREENSHOT;
  if (shot) {
    setTimeout(
      async () => {
        const image = await win?.webContents.capturePage();
        if (image) await writeFile(shot, image.toPNG());
        console.log(`[mypixelteam] screenshot saved to ${shot}`);
      },
      Number(process.env.AGENT_OFFICE_SCREENSHOT_DELAY ?? 12000),
    );
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  comments?.stop();
  runner?.stopAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
