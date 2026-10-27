import type { Fetch } from "../src/main/integrations/http";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A fetch that answers from `routes` ("GET /path?query" prefix -> body, or [status, body])
 * and records every call.
 */
export function fakeFetch(routes: Record<string, unknown>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({
      method,
      url: url.toString(),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && `${url.pathname}${url.search}`.startsWith(p!);
    });
    if (!key) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    const value = routes[key];
    const [status, body] =
      Array.isArray(value) && typeof value[0] === "number" ? value : [200, value];
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as Fetch;
  return { fetch: fetchImpl, calls };
}
