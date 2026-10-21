// Shared hook forwarder: reads the hook's JSON payload on stdin and POSTs it, untouched,
// to Agent Office at /ingest/<source>. The app does the normalization.
//
// It must never slow down or break the agent: short timeouts, no output, errors
// swallowed, always exit 0 (exit code 2 would block the agent's action).
//
// Environment:
//   AGENT_OFFICE_URL    default http://127.0.0.1:4777
//   AGENT_OFFICE_TOKEN  sent as X-Agent-Office-Token when set
//   AGENT_OFFICE_DEBUG  set to 1 to print failures on stderr

const STDIN_TIMEOUT_MS = 2000;
const POST_TIMEOUT_MS = 500;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks).toString("utf8"));
    // Some CLIs keep stdin open; don't wait forever.
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", done);
  });
}

/** Forwards one payload. `transform` may wrap or enrich it before sending. */
export async function forward(source, transform = (body) => body) {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const body = transform(raw);
    const base = (process.env.AGENT_OFFICE_URL || "http://127.0.0.1:4777").replace(/\/$/, "");
    const headers = { "content-type": "application/json" };
    if (process.env.AGENT_OFFICE_TOKEN)
      headers["x-agent-office-token"] = process.env.AGENT_OFFICE_TOKEN;
    await fetch(`${base}/ingest/${source}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    // App not running, timeout, bad payload: none of these are the agent's problem.
    if (process.env.AGENT_OFFICE_DEBUG === "1") console.error(`[agent-office] ${err}`);
  } finally {
    process.exit(0);
  }
}
