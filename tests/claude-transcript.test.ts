import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextFor, TranscriptWatcher } from "../src/main/transcripts";
import {
  normalizeTranscriptLine,
  type TranscriptContext,
} from "../src/shared/normalize/claude-transcript";
import { OfficeEvent } from "../src/shared/protocol/schema";

const NOW = new Date("2026-10-21T20:00:00Z");
const SESSION = "e8901574-8a50-487d-b61e-da547a6a8fd1";
const TS = "2026-10-21T21:09:30.843Z";

// Trimmed copies of real Claude Code transcript lines.
const prompt = {
  type: "user",
  message: { role: "user", content: "fix the login bug" },
  timestamp: TS,
  permissionMode: "auto",
  origin: { kind: "human" },
  promptSource: "typed",
  cwd: "D:\\dev\\shop",
  sessionId: SESSION,
};
const toolUse = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: { file_path: "D:\\dev\\shop\\src\\a.ts" },
      },
    ],
    stop_reason: "tool_use",
  },
  timestamp: TS,
  cwd: "D:\\dev\\shop",
};
const toolResult = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  timestamp: TS,
};
const endTurn = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    stop_reason: "end_turn",
  },
  timestamp: TS,
};

const mainCtx = (): TranscriptContext => ({
  sessionId: SESSION,
  agentId: SESSION,
  agentName: "Claude",
});
const subCtx = (): TranscriptContext => ({
  sessionId: SESSION,
  agentId: `${SESSION}/a1`,
  parentAgentId: SESSION,
  agentName: "Explore",
});

describe("normalizeTranscriptLine", () => {
  it("follows a turn: prompt, tool, result, end", () => {
    const ctx = mainCtx();
    const events = [prompt, toolUse, toolResult, endTurn].flatMap((l) =>
      normalizeTranscriptLine(l, ctx, NOW),
    );
    expect(events.map((e) => e.type)).toEqual([
      "agent.thinking",
      "agent.tool",
      "agent.thinking",
      "agent.idle",
    ]);
    expect(events[0]).toMatchObject({
      source: "claude-code",
      sessionId: SESSION,
      agentId: SESSION,
      agentName: "Claude",
      cwd: "D:\\dev\\shop",
      timestamp: TS,
      detail: { message: "fix the login bug", mode: "auto" },
    });
    expect(events[1]!.detail).toMatchObject({ tool: "edit", summary: "edit src/a.ts" });
    for (const e of events) expect(OfficeEvent.safeParse(e).success).toBe(true);
  });

  it("tracks plan mode from permission-mode lines", () => {
    const ctx = mainCtx();
    normalizeTranscriptLine({ type: "permission-mode", permissionMode: "plan" }, ctx, NOW);
    expect(normalizeTranscriptLine(toolUse, ctx, NOW)[0]!.detail.mode).toBe("plan");
  });

  it("ends the turn on turn_duration", () => {
    const [e] = normalizeTranscriptLine(
      { type: "system", subtype: "turn_duration" },
      mainCtx(),
      NOW,
    );
    expect(e).toMatchObject({ type: "agent.idle", timestamp: NOW.toISOString() });
  });

  it("reports interrupts and API errors", () => {
    const interrupt = {
      type: "user",
      message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
    };
    expect(normalizeTranscriptLine(interrupt, mainCtx(), NOW)[0]).toMatchObject({
      type: "agent.idle",
      detail: { message: "Interrupted" },
    });
    const apiError = {
      type: "assistant",
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "Overloaded" }], stop_reason: "stop_sequence" },
    };
    expect(normalizeTranscriptLine(apiError, mainCtx(), NOW)[0]).toMatchObject({
      type: "agent.error",
      detail: { message: "Overloaded" },
    });
  });

  it("hides injected messages and command tags", () => {
    expect(normalizeTranscriptLine({ ...prompt, isMeta: true }, mainCtx(), NOW)).toEqual([]);
    const command = { ...prompt, message: { content: "<command-name>/statusline</command-name>" } };
    expect(normalizeTranscriptLine(command, mainCtx(), NOW)[0]!.detail.message).toBeUndefined();
  });

  it("ends subagents on handback or end of turn", () => {
    const handback = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "SubagentHandback", input: {} }] },
    };
    expect(normalizeTranscriptLine(handback, subCtx(), NOW)[0]).toMatchObject({
      type: "subagent.ended",
      parentAgentId: SESSION,
    });
    expect(normalizeTranscriptLine(endTurn, subCtx(), NOW)[0]!.type).toBe("subagent.ended");
  });

  it("ignores bookkeeping lines and garbage", () => {
    for (const raw of [{ type: "file-history-snapshot" }, { type: "ai-title" }, null, "x", 3])
      expect(normalizeTranscriptLine(raw, mainCtx(), NOW)).toEqual([]);
  });
});

describe("TranscriptWatcher", () => {
  let root: string | undefined;
  let watcher: TranscriptWatcher | undefined;

  afterEach(() => {
    watcher?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const jsonl = (...lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

  function setup() {
    root = mkdtempSync(join(tmpdir(), "agent-office-"));
    const project = join(root, "D--dev-shop");
    mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
    const events: OfficeEvent[] = [];
    watcher = new TranscriptWatcher({ root, onEvent: (e) => events.push(e), rescanMs: 60_000 });
    return { root, project, events, main: join(project, `${SESSION}.jsonl`) };
  }

  it("recognizes session and subagent files", () => {
    const { root, project, main } = setup();
    expect(contextFor(root, main)).toMatchObject({ sessionId: SESSION, agentId: SESSION });
    const sub = join(project, SESSION, "subagents", "agent-a1.jsonl");
    writeFileSync(sub.replace(".jsonl", ".meta.json"), JSON.stringify({ agentType: "Explore" }));
    expect(contextFor(root, sub)).toMatchObject({
      agentId: `${SESSION}/a1`,
      parentAgentId: SESSION,
      agentName: "Explore",
    });
    expect(contextFor(root, join(project, "memory", "notes.jsonl"))).toBeUndefined();
  });

  it("shows a recent session in its latest state and skips old ones", () => {
    const { project, events, main } = setup();
    writeFileSync(main, jsonl(prompt, toolUse));
    const old = join(project, "old-session.jsonl");
    writeFileSync(old, jsonl(prompt));
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, hourAgo, hourAgo);

    watcher!.start();
    expect(events.map((e) => [e.agentId, e.type])).toEqual([[SESSION, "agent.tool"]]);
  });

  it("reads only appended lines and waits for half-written ones", () => {
    const { events, main } = setup();
    writeFileSync(main, "");
    watcher!.start();

    appendFileSync(main, jsonl(prompt) + JSON.stringify(toolUse).slice(0, 20));
    watcher!.rescan();
    expect(events.map((e) => e.type)).toEqual(["agent.thinking"]);

    appendFileSync(main, `${JSON.stringify(toolUse).slice(20)}\n`);
    watcher!.rescan();
    watcher!.rescan();
    expect(events.map((e) => e.type)).toEqual(["agent.thinking", "agent.tool"]);
  });

  it("announces new subagents and ends them when their meta says finished", () => {
    const { project, events } = setup();
    watcher!.start();
    const sub = join(project, SESSION, "subagents", "agent-a1.jsonl");
    const meta = sub.replace(".jsonl", ".meta.json");
    writeFileSync(meta, JSON.stringify({ agentType: "Explore" }));
    writeFileSync(sub, jsonl({ ...prompt, origin: undefined }, toolUse));
    watcher!.rescan();
    expect(events.map((e) => e.type)).toEqual(["subagent.started", "agent.thinking", "agent.tool"]);
    expect(events[0]).toMatchObject({ agentName: "Explore", parentAgentId: SESSION });

    writeFileSync(meta, JSON.stringify({ agentType: "Explore", finished: true }));
    watcher!.rescan();
    watcher!.rescan();
    expect(events.at(-1)!.type).toBe("subagent.ended");
    expect(events.filter((e) => e.type === "subagent.ended")).toHaveLength(1);
  });
});
