import { describe, expect, it } from "vitest";
import {
  describeRequest,
  permissionResponse,
  promptMessage,
  readPermissionRequest,
  unsupportedResponse,
} from "../src/main/work/agent-protocol";

// Shape recorded from `claude -p --permission-prompt-tool stdio` (Claude Code 2.1.311).
const recorded = {
  type: "control_request",
  request_id: "ab9c817b-1d31-4513-b483-8af4f9815ad8",
  request: {
    subtype: "can_use_tool",
    tool_name: "PowerShell",
    display_name: "PowerShell",
    input: {
      command: 'cmd /c "echo permission-probe > probe.txt"',
      description: "Write permission-probe text to probe.txt",
    },
    description: "Write permission-probe text to probe.txt",
    permission_suggestions: [],
    tool_use_id: "toolu_01",
  },
};

const parseLine = (text: string) => {
  expect(text.endsWith("\n")).toBe(true);
  expect(text.slice(0, -1)).not.toContain("\n");
  return JSON.parse(text);
};

describe("permission requests", () => {
  it("reads what the agent asks", () => {
    const request = readPermissionRequest(recorded);
    expect(request).toMatchObject({
      requestId: "ab9c817b-1d31-4513-b483-8af4f9815ad8",
      toolName: "PowerShell",
      description: "Write permission-probe text to probe.txt",
    });
    expect(readPermissionRequest({ type: "assistant" })).toBeUndefined();
    expect(
      readPermissionRequest({ type: "control_request", request: { subtype: "initialize" } }),
    ).toBeUndefined();
  });

  it("describes it for the person", () => {
    const question = describeRequest(readPermissionRequest(recorded)!, "/wt");
    expect(question).toEqual({
      id: "ab9c817b-1d31-4513-b483-8af4f9815ad8",
      tool: "PowerShell",
      summary: expect.any(String),
      detail: 'cmd /c "echo permission-probe > probe.txt"',
      reason: "Write permission-probe text to probe.txt",
    });
    const edit = describeRequest({
      requestId: "r2",
      toolName: "Write",
      input: { file_path: "/etc/hosts", content: "x" },
    });
    expect(edit.detail).toBe("/etc/hosts");
    const other = describeRequest({ requestId: "r3", toolName: "Mcp", input: { a: 1 } });
    expect(other.detail).toContain('"a": 1');
  });

  it("answers allow with the original input, deny with the reason", () => {
    const request = readPermissionRequest(recorded)!;
    expect(parseLine(permissionResponse(request, { allow: true }))).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.requestId,
        response: { behavior: "allow", updatedInput: recorded.request.input },
      },
    });
    const denied = parseLine(permissionResponse(request, { allow: false, message: " not now " }));
    expect(denied.response.response).toEqual({ behavior: "deny", message: "not now" });
    const silent = parseLine(permissionResponse(request, { allow: false }));
    expect(silent.response.response.message).toMatch(/Refused/);
  });

  it("answers other control requests with an error so the agent never hangs", () => {
    const line = parseLine(
      unsupportedResponse({
        type: "control_request",
        request_id: "x1",
        request: { subtype: "hook_callback" },
      })!,
    );
    expect(line.response).toMatchObject({ subtype: "error", request_id: "x1" });
    expect(unsupportedResponse(recorded)).toBeUndefined();
    expect(unsupportedResponse({ type: "result" })).toBeUndefined();
  });

  it("sends the ticket as one stream-json user message", () => {
    expect(parseLine(promptMessage("Fix\nthe login"))).toEqual({
      type: "user",
      message: { role: "user", content: "Fix\nthe login" },
    });
  });
});
