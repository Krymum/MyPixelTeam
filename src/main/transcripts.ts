import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import {
  normalizeTranscriptLine,
  type TranscriptContext,
} from "../shared/normalize/claude-transcript";
import type { OfficeEvent } from "../shared/protocol/schema";

/**
 * Follows the Claude Code transcripts under ~/.claude/projects, so every session on the
 * machine shows up without installing hooks. Only bytes appended since the last read are
 * parsed; fs.watch gives quick updates and a periodic rescan catches anything it missed.
 */

export interface TranscriptWatcherOptions {
  /** Usually ~/.claude/projects. */
  root: string;
  onEvent: (event: OfficeEvent) => void;
  /** At startup, sessions written within this window are shown right away. */
  recentMs?: number;
  /** Full rescan interval. */
  rescanMs?: number;
}

interface Tracked {
  ctx: TranscriptContext;
  offset: number;
  /** Subagents announce themselves once with subagent.started. */
  announced: boolean;
  ended: boolean;
}

const MAIN_AGENT_NAME = "Claude";
/** How much of a recent file is read at startup to find its current state. */
const TAIL_BYTES = 256 * 1024;

/** Recognizes <project>/<session>.jsonl and <project>/<session>/subagents/agent-<id>.jsonl. */
export function contextFor(root: string, path: string): TranscriptContext | undefined {
  const parts = relative(root, path).split(sep);
  if (parts.length === 2 && parts[1]!.endsWith(".jsonl")) {
    const sessionId = basename(parts[1]!, ".jsonl");
    return { sessionId, agentId: sessionId, agentName: MAIN_AGENT_NAME };
  }
  const sub = /^agent-(.+)\.jsonl$/.exec(parts[3] ?? "");
  if (parts.length === 4 && parts[2] === "subagents" && sub) {
    const sessionId = parts[1]!;
    return {
      sessionId,
      agentId: `${sessionId}/${sub[1]}`,
      parentAgentId: sessionId,
      agentName: readMeta(path)?.agentType ?? "subagent",
    };
  }
  return undefined;
}

interface SubagentMeta {
  agentType?: string;
  finished?: boolean;
}

function readMeta(jsonlPath: string): SubagentMeta | undefined {
  try {
    return JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function listTranscripts(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  walk(root, 0);
  return found;
}

export class TranscriptWatcher {
  private readonly files = new Map<string, Tracked>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly options: TranscriptWatcherOptions) {}

  start(): void {
    this.rescan();
    this.started = true;
    try {
      this.watcher = watch(this.options.root, { recursive: true }, (_, name) => {
        if (name) this.touch(join(this.options.root, name.toString()));
      });
      this.watcher.on("error", () => this.watcher?.close());
    } catch {
      // Folder missing or recursive watch unsupported: the rescan still works.
    }
    this.timer = setInterval(() => this.rescan(), this.options.rescanMs ?? 5000);
  }

  stop(): void {
    this.watcher?.close();
    clearInterval(this.timer);
  }

  /** Reads every known transcript once; also how new files are discovered. */
  rescan(): void {
    if (!existsSync(this.options.root)) return;
    for (const path of listTranscripts(this.options.root)) this.read(path);
    for (const [path, file] of this.files) if (file.ctx.parentAgentId) this.checkFinished(path);
  }

  private touch(path: string): void {
    if (path.endsWith(".jsonl")) this.read(path);
    else if (path.endsWith(".meta.json"))
      this.checkFinished(path.replace(/\.meta\.json$/, ".jsonl"));
  }

  private read(path: string): void {
    let size: number;
    let mtime: number;
    try {
      ({ size, mtimeMs: mtime } = statSync(path));
    } catch {
      return;
    }
    let file = this.files.get(path);
    if (!file) {
      const ctx = contextFor(this.options.root, path);
      if (!ctx) return;
      file = { ctx, offset: 0, announced: false, ended: false };
      this.files.set(path, file);
      if (!this.started) return this.catchUp(path, file, size, mtime);
    }
    if (size < file.offset) file.offset = size; // rewritten: only follow what comes next
    if (size === file.offset) return;
    for (const line of this.readLines(path, file, size))
      this.emitAll(file, this.normalize(line, file));
  }

  /** Startup: show recent sessions in their latest state, skip the rest. */
  private catchUp(path: string, file: Tracked, size: number, mtime: number): void {
    const recentMs = this.options.recentMs ?? 10 * 60_000;
    const finished = file.ctx.parentAgentId && readMeta(path)?.finished;
    if (Date.now() - mtime > recentMs || finished) {
      file.offset = size;
      return;
    }
    file.offset = Math.max(0, size - TAIL_BYTES);
    const cut = file.offset > 0;
    const lines = this.readLines(path, file, size);
    // A tail starts in the middle of a line.
    if (cut) lines.shift();
    const events = lines.flatMap((line) => this.normalize(line, file));
    const last = events.at(-1);
    if (last) this.emitAll(file, [last]);
  }

  private readLines(path: string, file: Tracked, size: number): string[] {
    const buffer = Buffer.alloc(size - file.offset);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, file.offset);
    } finally {
      closeSync(fd);
    }
    // Keep a half-written last line for the next read.
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return [];
    file.offset += end + 1;
    return buffer
      .subarray(0, end)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim());
  }

  private normalize(line: string, file: Tracked): OfficeEvent[] {
    try {
      return normalizeTranscriptLine(JSON.parse(line), file.ctx, new Date());
    } catch {
      return [];
    }
  }

  private emitAll(file: Tracked, events: OfficeEvent[]): void {
    for (const event of events) {
      if (file.ended) return;
      if (file.ctx.parentAgentId && !file.announced) {
        file.announced = true;
        if (event.type !== "subagent.ended")
          this.options.onEvent({ ...event, type: "subagent.started", detail: { ...event.detail } });
      }
      if (event.type === "subagent.ended") file.ended = true;
      this.options.onEvent(event);
    }
  }

  /** Claude Code marks a subagent's .meta.json as finished when it stops. */
  private checkFinished(path: string): void {
    const file = this.files.get(path);
    if (!file || file.ended || !file.announced || !readMeta(path)?.finished) return;
    file.ended = true;
    this.options.onEvent({
      v: 1,
      type: "subagent.ended",
      source: "claude-code",
      sessionId: file.ctx.sessionId,
      agentId: file.ctx.agentId,
      parentAgentId: file.ctx.parentAgentId,
      agentName: file.ctx.agentName,
      cwd: file.ctx.cwd,
      timestamp: new Date().toISOString(),
      detail: {},
    });
  }
}

export const defaultTranscriptRoot = (home: string): string =>
  join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
