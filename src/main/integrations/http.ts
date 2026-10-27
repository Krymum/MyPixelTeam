/** Minimal JSON-over-HTTPS client shared by the Jira, GitHub and Bitbucket clients. */

export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const TIMEOUT_MS = 20_000;

/** Pulls a readable message out of the error bodies the three APIs return. */
export function errorMessage(status: number, body: unknown): string {
  const b = body as {
    errorMessages?: string[];
    errors?: Record<string, string> | { message?: string }[];
    message?: string;
    error?: { message?: string; detail?: string };
  } | null;
  const parts: string[] = [];
  if (b && typeof b === "object") {
    if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages);
    if (b.errors && !Array.isArray(b.errors)) parts.push(...Object.values(b.errors));
    if (Array.isArray(b.errors)) parts.push(...b.errors.flatMap((e) => e.message ?? []));
    if (typeof b.message === "string") parts.push(b.message);
    if (b.error?.message) parts.push(b.error.message);
    if (b.error?.detail) parts.push(b.error.detail);
  }
  const detail = parts.filter(Boolean).join(" · ");
  if (status === 401) return `Invalid credentials${detail ? ` (${detail})` : ""}`;
  if (status === 403) return `Not allowed for this account${detail ? `: ${detail}` : ""}`;
  return detail || `HTTP ${status}`;
}

export interface JsonClient {
  <T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** `path` may be absolute (pagination links) or relative to `base`. */
export function jsonClient(
  base: string,
  headers: Record<string, string>,
  fetchImpl: Fetch = fetch,
): JsonClient {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const url = path.startsWith("https://") ? path : `${base}${path}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach ${new URL(url).host}: ${reason}`, { cause: err });
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) throw new HttpError(res.status, errorMessage(res.status, parsed));
    return parsed as T;
  };
}

export const basicAuth = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
