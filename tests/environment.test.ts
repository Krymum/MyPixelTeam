import { describe, expect, it } from "vitest";
import { checkEnvironment, readAuthStatus, type Exec } from "../src/main/work/environment";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const missing = { code: 1, stdout: "", stderr: "", missing: true };

function fakeExec(answers: Record<string, ReturnType<typeof ok>>): Exec {
  return async (command, args) => answers[`${command} ${args.join(" ")}`] ?? missing;
}

describe("readAuthStatus", () => {
  it("reads a signed-in account", () => {
    const out = ok(JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "pro" }));
    expect(readAuthStatus(out, {})).toEqual({ ok: true, detail: "a@b.c, pro plan" });
  });

  it("reports a signed-out CLI, unless an API key is set", () => {
    const out = { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
    expect(readAuthStatus(out, {})).toEqual({ ok: false, detail: "Not signed in" });
    expect(readAuthStatus(out, { ANTHROPIC_API_KEY: "sk" }).ok).toBe(true);
  });

  it("falls back to stderr when the output is not JSON", () => {
    const out = { code: 1, stdout: "", stderr: "unknown command\nmore" };
    expect(readAuthStatus(out, {})).toEqual({ ok: false, detail: "unknown command" });
  });
});

describe("checkEnvironment", () => {
  it("passes on a ready machine", async () => {
    const env = await checkEnvironment(
      "claude",
      fakeExec({
        "git --version": ok("git version 2.49.0\n"),
        "claude --version": ok("2.1.311 (Claude Code)\n"),
        "claude auth status": ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })),
      }),
    );
    expect(env).toEqual({
      git: { ok: true, detail: "git version 2.49.0" },
      claude: { ok: true, detail: "2.1.311 (Claude Code)" },
      claudeAuth: { ok: true, detail: "claude.ai" },
    });
  });

  it("explains what is missing", async () => {
    const env = await checkEnvironment("claude", fakeExec({}));
    expect(env.git).toEqual({ ok: false, detail: "git is not installed" });
    expect(env.claude.detail).toMatch(/not installed/);
    expect(env.claudeAuth).toEqual({ ok: false, detail: "Install Claude Code first" });
  });
});
