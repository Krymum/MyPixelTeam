import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeClaudeCode } from "../src/shared/normalize/claude-code";
import { OfficeEvent } from "../src/shared/protocol/schema";

const DIR = join(__dirname, "fixtures", "claude-code");
const NOW = new Date("2026-10-21T20:00:00Z");
const SESSION = "94a1df67-c170-4377-b3d3-e6caabc86449";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf8"));
const one = (name: string) => {
  const events = normalizeClaudeCode(fixture(name), NOW);
  expect(events).toHaveLength(1);
  return events[0]!;
};

describe("normalizeClaudeCode", () => {
  it("turns every fixture into schema-valid events", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      for (const event of normalizeClaudeCode(fixture(file), NOW)) {
        const parsed = OfficeEvent.safeParse(event);
        expect(parsed.success, `${file}: ${parsed.error?.message}`).toBe(true);
      }
    }
  });

  it("maps the session lifecycle", () => {
    expect(one("session-start.json")).toMatchObject({
      type: "agent.started",
      source: "claude-code",
      sessionId: SESSION,
      agentId: SESSION,
      agentName: "Claude",
      timestamp: NOW.toISOString(),
    });
    expect(one("user-prompt-submit.json")).toMatchObject({
      type: "agent.thinking",
      detail: { message: "Fix the failing tests in the cart module", mode: "auto" },
    });
    expect(one("stop.json").type).toBe("agent.idle");
    expect(one("notification-idle-prompt.json").type).toBe("agent.idle");
    expect(one("session-end.json").type).toBe("agent.ended");
  });

  it("summarizes tool calls relative to the project", () => {
    expect(one("pre-tool-use-edit.json")).toMatchObject({
      type: "agent.tool",
      detail: { tool: "edit", summary: "edit src/cart.ts" },
    });
    expect(one("pre-tool-use-bash.json").detail).toMatchObject({
      tool: "bash",
      summary: "npm test -- --run cart",
    });
    expect(one("pre-tool-use-grep.json").detail).toMatchObject({
      tool: "search",
      summary: 'grep "TODO"',
    });
    expect(one("pre-tool-use-webfetch.json").detail).toMatchObject({
      tool: "web",
      summary: "fetch vitest.dev",
    });
    expect(one("pre-tool-use-agent.json").detail).toMatchObject({
      tool: "agent",
      summary: "spawn Explore",
    });
    expect(one("post-tool-use-read.json").type).toBe("agent.thinking");
  });

  it("gives subagents their own character linked to the session", () => {
    const start = one("subagent-start.json");
    expect(start).toMatchObject({
      type: "subagent.started",
      agentId: `${SESSION}/a3a4692cbdd1b0651`,
      parentAgentId: SESSION,
      agentName: "Explore",
    });
    expect(one("pre-tool-use-read-subagent.json")).toMatchObject({
      type: "agent.tool",
      agentId: start.agentId,
      parentAgentId: SESSION,
      detail: { tool: "read" },
    });
    expect(one("subagent-stop-subagent.json")).toMatchObject({
      type: "subagent.ended",
      agentId: start.agentId,
    });
  });

  it("reports waiting and failures", () => {
    expect(one("permission-request-bash.json")).toMatchObject({
      type: "agent.waiting",
      detail: { message: "Allow rm -rf dist?" },
    });
    expect(one("notification-permission-prompt.json")).toMatchObject({
      type: "agent.waiting",
      detail: { message: "Claude needs your permission to use Bash" },
    });
    expect(one("post-tool-use-failure-bash.json")).toMatchObject({
      type: "agent.error",
      detail: { message: "Exit code 1" },
    });
    expect(one("stop-failure.json").detail.message).toBe("API Error: Rate limit reached");
  });

  it("ignores garbage and unknown hooks instead of throwing", () => {
    for (const raw of [
      null,
      42,
      "x",
      {},
      { session_id: "" },
      { session_id: "s", hook_event_name: "PreCompact" },
    ]) {
      expect(normalizeClaudeCode(raw, NOW)).toEqual([]);
    }
  });
});
