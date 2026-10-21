import { describe, expect, it } from "vitest";
import { displayPath, summarizeTool } from "../src/shared/normalize/tool-summary";

describe("displayPath", () => {
  it("shortens paths inside the project and elsewhere", () => {
    expect(displayPath("D:\\work\\shop\\src\\a.ts", "D:\\work\\shop")).toBe("src/a.ts");
    expect(displayPath("/home/me/shop/src/a.ts", "/home/me/shop/")).toBe("src/a.ts");
    expect(displayPath("/etc/nginx/conf.d/site.conf", "/home/me/shop")).toBe("…/conf.d/site.conf");
  });
});

describe("summarizeTool", () => {
  it("covers Claude Code tools", () => {
    expect(summarizeTool("Read", { file_path: "/p/src/x.ts" }, "/p")).toEqual({
      tool: "read",
      summary: "read src/x.ts",
    });
    expect(summarizeTool("WebSearch", { query: "zod v4" })).toEqual({
      tool: "web",
      summary: 'search "zod v4"',
    });
    expect(summarizeTool("mcp__github__create_issue", {})).toEqual({
      tool: "other",
      summary: "github: create_issue",
    });
    expect(summarizeTool("Bash", { command: "npm   test\n--watch" }).summary).toBe(
      "npm test --watch",
    );
    expect(
      summarizeTool("Bash", {
        command: 'S="/tmp/x"; for i in $(seq 1 9); do curl -s http://localhost:3000; done',
        description: "Poll the dev server",
      }).summary,
    ).toBe("Poll the dev server");
    expect(
      summarizeTool("Bash", { command: "git status", description: "Show status" }).summary,
    ).toBe("git status");
  });

  it("covers Codex and Gemini tools", () => {
    expect(summarizeTool("shell", { command: ["bash", "-lc", "cargo test"] }).summary).toBe(
      "cargo test",
    );
    expect(
      summarizeTool(
        "apply_patch",
        { input: "*** Begin Patch\n*** Update File: /p/src/lib.rs\n@@" },
        "/p",
      ),
    ).toEqual({ tool: "edit", summary: "patch src/lib.rs" });
    expect(summarizeTool("run_shell_command", { command: "ls" })).toEqual({
      tool: "bash",
      summary: "ls",
    });
    expect(summarizeTool("replace", { file_path: "/p/a.py" }, "/p")).toEqual({
      tool: "edit",
      summary: "edit a.py",
    });
    expect(summarizeTool("google_web_search", { query: "q" }).tool).toBe("web");
  });

  it("clips long text and survives odd input", () => {
    expect(summarizeTool("Bash", { command: "x".repeat(200) }).summary.length).toBeLessThanOrEqual(
      48,
    );
    expect(summarizeTool("Read", null)).toEqual({ tool: "read", summary: "read file" });
    expect(summarizeTool("SomethingNew", 5)).toEqual({ tool: "other", summary: "SomethingNew" });
  });
});
