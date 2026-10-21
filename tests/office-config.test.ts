import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createRoleResolver,
  DEFAULT_CONFIG,
  OfficeConfig,
} from "../src/shared/config/office-config";
import type { OfficeEvent } from "../src/shared/protocol/schema";

const event = (extra: Partial<OfficeEvent>): OfficeEvent => ({
  v: 1,
  type: "agent.tool",
  source: "claude-code",
  sessionId: "s",
  agentId: "s",
  timestamp: "2026-10-21T20:00:00Z",
  detail: {},
  ...extra,
});

describe("office config", () => {
  it("ships an office.config.json identical to the built-in defaults", () => {
    const file = OfficeConfig.parse(JSON.parse(readFileSync("office.config.json", "utf8")));
    expect(file).toEqual(DEFAULT_CONFIG);
  });

  it("rejects unknown roles, empty matches and broken regexes", () => {
    expect(
      OfficeConfig.safeParse({ rules: [{ match: { agentName: "x" }, role: "chef" }] }).success,
    ).toBe(false);
    expect(OfficeConfig.safeParse({ rules: [{ match: {}, role: "qa" }] }).success).toBe(false);
    expect(OfficeConfig.safeParse({ rules: [{ match: { cwd: "(" }, role: "qa" }] }).success).toBe(
      false,
    );
  });
});

describe("createRoleResolver", () => {
  const resolve = createRoleResolver(DEFAULT_CONFIG);

  it("maps common subagent types to rooms", () => {
    expect(resolve(event({ agentName: "code-reviewer" }))).toBe("qa");
    expect(resolve(event({ agentName: "test-runner" }))).toBe("qa");
    expect(resolve(event({ agentName: "Explore" }))).toBe("research");
    expect(resolve(event({ agentName: "deploy-bot" }))).toBe("ops");
    expect(resolve(event({ cwd: "C:\\work\\infra\\prod" }))).toBe("ops");
    expect(resolve(event({ cwd: "/home/me/k8s" }))).toBe("ops");
  });

  it("falls back to the default role and honors explicit roles", () => {
    expect(resolve(event({ agentName: "Claude" }))).toBe("dev");
    expect(resolve(event({ agentName: "code-reviewer", role: "ops" }))).toBe("ops");
  });

  it("requires every field of a rule to match and anchors patterns", () => {
    const custom = createRoleResolver(
      OfficeConfig.parse({
        defaultRole: "research",
        rules: [{ match: { source: "codex", agentName: "bot" }, role: "ops" }],
      }),
    );
    expect(custom(event({ source: "codex", agentName: "bot" }))).toBe("ops");
    expect(custom(event({ source: "codex", agentName: "robot" }))).toBe("research");
    expect(custom(event({ source: "gemini", agentName: "bot" }))).toBe("research");
  });
});
