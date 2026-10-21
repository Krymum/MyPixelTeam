import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { Normalizer } from "../shared/normalize";
import { OfficeEventInput, PROTOCOL_VERSION, type OfficeEvent } from "../shared/protocol/schema";

export const TOKEN_HEADER = "x-agent-office-token";
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface IngestServerOptions {
  /** When set, every POST must carry it in the X-Agent-Office-Token header. */
  token?: string;
  normalizers: Partial<Record<string, Normalizer>>;
  onEvent: (event: OfficeEvent) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Invalid JSON");
  }
}

/**
 * Guards against web pages poking the local server: browsers always send Origin on
 * cross-site requests and cannot send application/json without a CORS preflight we never
 * answer. The Host check defeats DNS rebinding.
 */
function checkRequest(req: http.IncomingMessage, token: string | undefined): void {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!ALLOWED_HOSTS.has(host)) throw new HttpError(403, "Forbidden host");
  if (req.headers.origin) throw new HttpError(403, "Browser requests are not allowed");
  if (req.method !== "POST") return;
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  if (token && req.headers[TOKEN_HEADER] !== token) throw new HttpError(401, "Bad token");
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createIngestServer(options: IngestServerOptions): http.Server {
  const { token, normalizers, onEvent } = options;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    checkRequest(req, token);
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, protocol: PROTOCOL_VERSION });
    }

    if (req.method === "POST" && path === "/events") {
      const body = await readJson(req);
      const parsed = z.array(OfficeEventInput).safeParse(Array.isArray(body) ? body : [body]);
      if (!parsed.success) throw new HttpError(400, "Invalid event", z.treeifyError(parsed.error));
      parsed.data.forEach(onEvent);
      return send(res, 202, { accepted: parsed.data.length });
    }

    const ingest = /^\/ingest\/([a-z0-9-]+)$/.exec(path);
    if (req.method === "POST" && ingest) {
      const normalize = normalizers[ingest[1]!];
      if (!normalize) throw new HttpError(404, `No normalizer for source "${ingest[1]}"`);
      const events = normalize(await readJson(req), new Date());
      events.forEach(onEvent);
      return send(res, 202, { accepted: events.length });
    }

    throw new HttpError(404, "Not found");
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message, details: err.details });
      } else {
        console.error("[agent-office] ingest error", err);
        send(res, 500, { error: "Internal error" });
      }
    });
  });
}

/** Starts listening; resolves with the actual port (useful with port 0 in tests). */
export function listen(server: http.Server, port: number, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
