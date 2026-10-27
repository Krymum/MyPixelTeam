import { describe, expect, it } from "vitest";
import { CLAUDE_EVENTS, install, isOurs, uninstall } from "../scripts/setup/claude.mjs";

const COMMAND = 'node "D:/tools/agent-office/adapters/claude-code.mjs"';

/** A user config that already has hooks of its own. */
const existing = {
  model: "opus",
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
  },
};

describe("Claude Code setup", () => {
  it("adds one async hook per event and keeps the user's own hooks", () => {
    const next = install(existing, COMMAND);
    expect(next.model).toBe("opus");
    for (const event of CLAUDE_EVENTS) {
      const ours = next.hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks).filter(isOurs);
      expect(ours, event).toEqual([
        { type: "command", command: COMMAND, async: true, timeout: 10 },
      ]);
    }
    expect(next.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(next.hooks.PreToolUse[1].matcher).toBe("*");
    expect(next.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    // Input is not mutated.
    expect(existing.hooks.PreToolUse).toHaveLength(1);
  });

  it("is idempotent", () => {
    const once = install(existing, COMMAND);
    expect(install(once, COMMAND)).toEqual(once);
  });

  it("uninstalls cleanly back to the original config", () => {
    expect(uninstall(install(existing, COMMAND))).toEqual(existing);
    expect(uninstall(install({}, COMMAND))).toEqual({});
  });

  it("recognizes its hooks with Windows or POSIX paths only", () => {
    expect(isOurs({ command: 'node "C:\\x\\adapters\\claude-code.mjs"' })).toBe(true);
    expect(isOurs({ command: "node /opt/office/adapters/claude-code.mjs" })).toBe(true);
    expect(isOurs({ command: "node my-claude-code.mjs" })).toBe(false);
  });
});
