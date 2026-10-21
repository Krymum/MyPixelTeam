import { describe, expect, it } from "vitest";
import { OfficeEvent, OfficeEventInput } from "../src/shared/protocol/schema";

const valid = {
  v: 1,
  type: "agent.tool",
  source: "claude-code",
  sessionId: "s1",
  agentId: "s1",
  timestamp: "2026-10-21T19:47:00.000Z",
  detail: { tool: "edit", summary: "edit src/app.ts" },
};

describe("OfficeEvent", () => {
  it("accepts a well-formed event", () => {
    expect(OfficeEvent.parse(valid)).toEqual(valid);
  });

  it("rejects unknown types, sources and versions", () => {
    expect(OfficeEvent.safeParse({ ...valid, type: "agent.dancing" }).success).toBe(false);
    expect(OfficeEvent.safeParse({ ...valid, source: "copilot" }).success).toBe(false);
    expect(OfficeEvent.safeParse({ ...valid, v: 2 }).success).toBe(false);
  });

  it("defaults detail to an empty object", () => {
    expect(OfficeEvent.parse({ ...valid, detail: undefined }).detail).toEqual({});
  });
});

describe("OfficeEventInput", () => {
  it("fills v, timestamp and agentId for hand-written events", () => {
    const e = OfficeEventInput.parse({ type: "agent.idle", source: "custom", sessionId: "x" });
    expect(e.v).toBe(1);
    expect(e.agentId).toBe("x");
    expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
  });
});
