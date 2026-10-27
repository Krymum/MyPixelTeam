#!/usr/bin/env node
// Installs or removes the MyPixelTeam hooks for a CLI. Never writes silently: it shows
// what will change, asks for confirmation (or --yes), and backs up the file first.
//
//   node scripts/setup.mjs claude [--user | --project [dir]] [--uninstall] [--dry-run] [--yes]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import * as claude from "./setup/claude.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `npm run` switches to the repo folder; INIT_CWD is where the user actually typed it.
const CALLER_DIR = process.env.INIT_CWD || process.cwd();

const TARGETS = {
  claude: {
    label: "Claude Code",
    adapter: "adapters/claude-code.mjs",
    path: claude.settingsPath,
    install: claude.install,
    uninstall: claude.uninstall,
    events: claude.CLAUDE_EVENTS,
    after: "New Claude Code sessions pick the hooks up; restart running ones.",
  },
};

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "usage: node scripts/setup.mjs <claude> [--user | --project [dir]] [--uninstall] [--dry-run] [--yes]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const [cli, ...rest] = argv;
  const target = TARGETS[cli];
  if (!target) usage(`unknown CLI "${cli ?? ""}"`);
  const opts = {
    target,
    scope: "user",
    projectDir: CALLER_DIR,
    uninstall: false,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--user") opts.scope = "user";
    else if (arg === "--project") {
      opts.scope = "project";
      if (rest[i + 1] && !rest[i + 1].startsWith("--"))
        opts.projectDir = resolve(CALLER_DIR, rest[++i]);
    } else if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else usage(`unknown option ${arg}`);
  }
  return opts;
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`error: ${path} is not valid JSON (${err.message}). Nothing was changed.`);
    process.exit(1);
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.error(
      "Not an interactive terminal: re-run with --yes to apply, or --dry-run to preview.",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function main() {
  const { target, scope, projectDir, uninstall, dryRun, yes } = parseArgs(process.argv.slice(2));
  const file = target.path(scope, projectDir);
  const adapter = resolve(ROOT, target.adapter).replace(/\\/g, "/");
  const command = `node "${adapter}"`;

  const before = readJson(file);
  const after = uninstall ? target.uninstall(before) : target.install(before, command);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);

  console.log(`${target.label} — ${uninstall ? "remove" : "install"} MyPixelTeam hooks`);
  console.log(`  file:    ${file}${existsSync(file) ? "" : " (will be created)"}`);
  if (!uninstall) {
    console.log(`  command: ${command}`);
    console.log(`  events:  ${target.events.join(", ")}`);
    console.log("  Hooks run async and always exit 0: they never block or slow the agent.");
  }
  if (unchanged) {
    console.log("\nNothing to change.");
    return;
  }
  if (dryRun) {
    console.log(`\n--dry-run: resulting file:\n${JSON.stringify(after, null, 2)}`);
    return;
  }
  if (!yes && !(await confirm("\nApply?"))) {
    console.log("Aborted, nothing changed.");
    return;
  }

  if (existsSync(file)) {
    const backup = `${file}.bak-${timestamp()}`;
    copyFileSync(file, backup);
    console.log(`Backup:  ${backup}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(after, null, 2)}\n`);
  console.log(`Done. ${uninstall ? "Hooks removed." : target.after}`);
}

await main();
