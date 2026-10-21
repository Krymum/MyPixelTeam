import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { IPC, type ServerInfo } from "../preload/api";
import { createRoleResolver, DEFAULT_CONFIG } from "../shared/config/office-config";
import { createDemoScenario } from "../shared/demo/scenario";
import { normalizers } from "../shared/normalize";
import type { OfficeEvent } from "../shared/protocol/schema";
import { loadConfig, watchConfig, type LoadedConfig } from "./config";
import { createIngestServer, listen } from "./server";
import { defaultTranscriptRoot, TranscriptWatcher } from "./transcripts";

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

const info: ServerInfo = { url: `http://127.0.0.1:${PORT}`, listening: false, demo: DEMO };
let win: BrowserWindow | null = null;
let resolveRole = createRoleResolver(DEFAULT_CONFIG);

function useConfig(loaded: LoadedConfig): void {
  resolveRole = createRoleResolver(loaded.config);
  info.configPath = loaded.path;
  info.configError = loaded.error;
  if (loaded.error) console.error(`[agent-office] ${loaded.path} ignored: ${loaded.error}`);
  else console.log(`[agent-office] roles from ${loaded.path}`);
}

function publish(raw: OfficeEvent): void {
  // Roles are decided once here so every consumer (and the history) agrees.
  const event = { ...raw, role: resolveRole(raw) };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  win?.webContents.send(IPC.event, event);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Agent Office",
    backgroundColor: "#1b1b24",
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
  console.log(`[agent-office] following Claude Code transcripts in ${root}`);
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
    console.log(`[agent-office] listening on ${info.url}${TOKEN ? " (token required)" : ""}`);
  } catch (err) {
    info.error = err instanceof Error ? err.message : String(err);
    console.error(`[agent-office] could not listen on ${info.url}: ${info.error}`);
  }
}

// A second launch would fail to bind the port: focus the running window instead.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

app.whenReady().then(async () => {
  ipcMain.handle(IPC.history, () => history);
  ipcMain.handle(IPC.info, () => info);
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
        console.log(`[agent-office] screenshot saved to ${shot}`);
      },
      Number(process.env.AGENT_OFFICE_SCREENSHOT_DELAY ?? 12000),
    );
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
