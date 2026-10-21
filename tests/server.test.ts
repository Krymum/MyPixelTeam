import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer, listen } from "../src/main/server";
import type { OfficeEvent } from "../src/shared/protocol/schema";

let server: http.Server | undefined;

async function start(options: { token?: string } = {}) {
  const received: OfficeEvent[] = [];
  server = createIngestServer({
    ...options,
    normalizers: {
      custom: (raw) => [
        {
          v: 1,
          type: "agent.idle",
          source: "custom",
          sessionId: String((raw as { id: string }).id),
          agentId: String((raw as { id: string }).id),
          timestamp: new Date().toISOString(),
          detail: {},
        },
      ],
    },
    onEvent: (e) => received.push(e),
  });
  const port = await listen(server, 0);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { port, received, post };
}

afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

const event = { type: "agent.thinking", source: "custom", sessionId: "s1" };

describe("ingest server", () => {
  it("answers /health", async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ ok: true, protocol: 1 });
  });

  it("accepts single and batched events on /events", async () => {
    const { post, received } = await start();
    expect((await post("/events", event)).status).toBe(202);
    expect((await post("/events", [event, event])).status).toBe(202);
    expect(received).toHaveLength(3);
    expect(received[0]).toMatchObject({ agentId: "s1", v: 1 });
  });

  it("rejects invalid events and bad JSON with 400", async () => {
    const { post, received } = await start();
    expect((await post("/events", { ...event, type: "nope" })).status).toBe(400);
    expect((await post("/events", "{not json")).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("routes /ingest/:source through the matching normalizer", async () => {
    const { post, received } = await start();
    expect((await post("/ingest/custom", { id: "abc" })).status).toBe(202);
    expect(received[0]).toMatchObject({ sessionId: "abc", type: "agent.idle" });
    expect((await post("/ingest/unknown", {})).status).toBe(404);
  });

  it("enforces the token when configured", async () => {
    const { post } = await start({ token: "s3cret" });
    expect((await post("/events", event)).status).toBe(401);
    expect((await post("/events", event, { "x-agent-office-token": "s3cret" })).status).toBe(202);
  });

  it("refuses browser-originated requests and non-JSON content types", async () => {
    const { post, port } = await start();
    expect((await post("/events", event, { origin: "https://evil.example" })).status).toBe(403);
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(415);
  });
});
