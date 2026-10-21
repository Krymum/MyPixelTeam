import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ADAPTER = join(__dirname, "..", "adapters", "claude-code.mjs");

function runAdapter(stdin: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; ms: number; stdout: string }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [ADAPTER], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("close", (code) => resolve({ code, ms: Date.now() - started, stdout }));
    child.stdin.end(stdin);
  });
}

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe("claude-code adapter", () => {
  it("forwards the raw payload to /ingest/claude-code with the token", async () => {
    const received: { url?: string; token?: string; body: string }[] = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ url: req.url, token: req.headers["x-agent-office-token"] as string, body });
        res.writeHead(202).end("{}");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const payload = JSON.stringify({ session_id: "s", hook_event_name: "Stop" });
    const result = await runAdapter(payload, {
      AGENT_OFFICE_URL: `http://127.0.0.1:${port}`,
      AGENT_OFFICE_TOKEN: "t0k",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(received).toEqual([{ url: "/ingest/claude-code", token: "t0k", body: payload }]);
  });

  it("exits 0 quickly and silently when the app is not running", async () => {
    // Port 9 (discard) is essentially never listening.
    const result = await runAdapter('{"session_id":"s"}', {
      AGENT_OFFICE_URL: "http://127.0.0.1:9",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.ms).toBeLessThan(3000);
  });

  it("exits 0 when the server hangs", async () => {
    server = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const result = await runAdapter('{"session_id":"s"}', {
      AGENT_OFFICE_URL: `http://127.0.0.1:${port}`,
    });
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(3000);
    server.closeAllConnections();
  });
});
