import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceLogin, githubCliToken } from "../src/main/integrations/github-login";
import { isTrustedAuthor } from "../src/main/integrations/trackers";
import type { Exec } from "../src/main/work/environment";
import { hookCommand, hooksStatus, installHooks, uninstallHooks } from "../src/main/work/hooks";
import { fakeFetch } from "./work-helpers";

const noWait = async () => {};

describe("DeviceLogin", () => {
  const code = {
    device_code: "dev-1",
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  };

  /** A fetch that answers the token endpoint from a list, one answer per poll. */
  function polling(answers: unknown[]) {
    const { fetch, calls } = fakeFetch({ "POST /login/device/code": code });
    let i = 0;
    const wrapped = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/login/oauth/access_token")) {
        calls.push({
          method: "POST",
          url: String(input),
          headers: {},
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify(answers[i++]), { status: 200 });
      }
      return fetch(input, init);
    }) as typeof fetch;
    return { fetch: wrapped, calls };
  }

  it("shows the code, then waits for approval", async () => {
    const { fetch, calls } = polling([
      { error: "authorization_pending" },
      { error: "slow_down", interval: 10 },
      { access_token: "gho_token" },
    ]);
    const login = new DeviceLogin("client-1", fetch, noWait);
    const shown = await login.start();
    expect(shown).toMatchObject({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    expect(calls[0]!.body).toEqual({ client_id: "client-1", scope: "repo" });
    expect(await login.token()).toBe("gho_token");
    expect(calls.at(-1)!.body).toMatchObject({
      device_code: "dev-1",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it("stops when refused, expired or cancelled", async () => {
    const denied = new DeviceLogin("c", polling([{ error: "access_denied" }]).fetch, noWait);
    await denied.start();
    await expect(denied.token()).rejects.toThrow(/refused/);

    const expired = new DeviceLogin("c", polling([{ error: "expired_token" }]).fetch, noWait);
    await expired.start();
    await expect(expired.token()).rejects.toThrow(/expired/);

    const cancelled = new DeviceLogin("c", polling([]).fetch, noWait);
    await cancelled.start();
    cancelled.cancel();
    await expect(cancelled.token()).rejects.toThrow(/cancelled/);
  });

  it("needs a client id", () => {
    expect(() => new DeviceLogin("")).toThrow(/not set up/);
  });
});

describe("githubCliToken", () => {
  const exec =
    (code: number, stdout: string): Exec =>
    async () => ({ code, stdout, stderr: "" });

  it("reuses the GitHub CLI login when there is one", async () => {
    expect(await githubCliToken(exec(0, "gho_cli\n"))).toBe("gho_cli");
    expect(await githubCliToken(exec(1, ""))).toBeUndefined();
    expect(await githubCliToken(exec(0, "  "))).toBeUndefined();
  });
});

describe("isTrustedAuthor", () => {
  it("trusts owners, members and collaborators only", () => {
    for (const a of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(isTrustedAuthor(a)).toBe(true);
    for (const a of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", undefined])
      expect(isTrustedAuthor(a)).toBe(false);
  });
});

describe("hooks", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "office-hooks-"));
    const adapter = join(dir, "app", "adapters", "claude-code.mjs");
    const settings = join(dir, ".claude", "settings.json");
    return { adapter, settings };
  };
  const node: Exec = async () => ({ code: 0, stdout: "v22.12.0\n", stderr: "" });

  it("installs next to the person's own hooks, with a backup, and removes cleanly", async () => {
    const { adapter, settings } = setup();
    // The adapter must exist for an install.
    expect(() => installHooks(settings, adapter)).toThrow(/Hook script missing/);
    mkdirSync(join(dir, "app", "adapters"), { recursive: true });
    writeFileSync(adapter, "");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const own = {
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "beep" }] }] },
    };
    writeFileSync(settings, JSON.stringify(own));

    expect(await hooksStatus(settings, adapter, node)).toMatchObject({
      installed: false,
      outdated: false,
    });
    installHooks(settings, adapter);
    const written = JSON.parse(readFileSync(settings, "utf8"));
    expect(written.model).toBe("opus");
    expect(written.hooks.Stop[0].hooks[0].command).toBe("beep");
    expect(written.hooks.Stop[1].hooks[0].command).toBe(hookCommand(adapter));
    expect(readdirSync(join(dir, ".claude")).some((f) => f.startsWith("settings.json.bak-"))).toBe(
      true,
    );
    expect(await hooksStatus(settings, adapter, node)).toMatchObject({
      installed: true,
      outdated: false,
    });
    // Moved app: the hooks point at the old copy.
    expect(await hooksStatus(settings, join(dir, "elsewhere.mjs"), node)).toMatchObject({
      outdated: true,
    });

    uninstallHooks(settings);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(own);
  });

  it("never touches a settings file that isn't valid JSON", async () => {
    const { adapter, settings } = setup();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, "app", "adapters"), { recursive: true });
    writeFileSync(adapter, "");
    writeFileSync(settings, "{ oops");
    expect(() => installHooks(settings, adapter)).toThrow(/not valid JSON/);
    expect(readFileSync(settings, "utf8")).toBe("{ oops");
    expect(existsSync(join(dir, ".claude", "settings.json.bak"))).toBe(false);
  });

  it("says when Node.js is missing", async () => {
    const { adapter, settings } = setup();
    const missing: Exec = async () => ({ code: 1, stdout: "", stderr: "", missing: true });
    expect((await hooksStatus(settings, adapter, missing)).node.ok).toBe(false);
  });
});
