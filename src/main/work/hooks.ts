import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { install, isOurs, uninstall } from "../../../scripts/setup/claude.mjs";
import type { HooksStatus } from "../../shared/work/types";
import type { Exec } from "./environment";

/**
 * Installs the Claude Code hooks from the app, like `npm run setup:claude`: hooks report
 * what transcripts can't show (an agent waiting for you, a session ending). Same rules as
 * the script: other hooks are kept, the file is backed up, invalid JSON is never touched.
 */

interface Settings {
  hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
}

export const hookCommand = (adapterPath: string): string =>
  `node "${adapterPath.replace(/\\/g, "/")}"`;

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} is not valid JSON (${reason}): fix it first, nothing was changed`, {
      cause: err,
    });
  }
}

function ourCommands(settings: Settings): string[] {
  return Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .filter(isOurs)
    .map((h) => h.command ?? "");
}

export async function hooksStatus(
  settingsPath: string,
  adapterPath: string,
  run: Exec,
): Promise<HooksStatus> {
  const node = await run("node", ["--version"]);
  let commands: string[] = [];
  try {
    commands = ourCommands(readSettings(settingsPath));
  } catch {
    // Unreadable settings: report as not installed; installing explains why.
  }
  const installed = commands.length > 0;
  return {
    settingsPath,
    installed,
    outdated: installed && !commands.includes(hookCommand(adapterPath)),
    node:
      node.code === 0
        ? { ok: true, detail: `Node.js ${node.stdout.trim()}` }
        : { ok: false, detail: "Node.js is not installed: hooks need it to run" },
  };
}

function write(path: string, settings: Settings): void {
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    copyFileSync(path, `${path}.bak-${stamp}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

export function installHooks(settingsPath: string, adapterPath: string): void {
  if (!existsSync(adapterPath)) throw new Error(`Hook script missing: ${adapterPath}`);
  const before = readSettings(settingsPath);
  const after = install(before, hookCommand(adapterPath));
  if (JSON.stringify(before) !== JSON.stringify(after)) write(settingsPath, after);
}

export function uninstallHooks(settingsPath: string): void {
  const before = readSettings(settingsPath);
  const after = uninstall(before);
  if (JSON.stringify(before) !== JSON.stringify(after)) write(settingsPath, after);
}
