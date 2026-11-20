# Event protocol and configuration

Any program can report to the office over a small local HTTP API. This page also lists every environment variable.

## Sending events from anything else

Any program can report to the office with one HTTP request. Only `type`, `source` and
`sessionId` are required:

```bash
curl -X POST http://127.0.0.1:4777/events \
  -H "content-type: application/json" \
  -d '{"type":"agent.tool","source":"custom","sessionId":"build-42","agentName":"ci-bot","detail":{"tool":"bash","summary":"make release"}}'
```

Send `agent.ended` with the same `sessionId` to make the character leave. You can also POST
an array of events.

### Event format (protocol v1)

| Field            | Required | Description                                                                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `v`              | no       | Protocol version, `1` (defaults to 1)                                                                                                |
| `type`           | yes      | See below                                                                                                                            |
| `source`         | yes      | `claude-code`, `codex`, `gemini` or `custom`                                                                                         |
| `sessionId`      | yes      | Groups events of one session (max 200 characters)                                                                                    |
| `agentId`        | no       | One character. Defaults to `sessionId`; use a distinct id per subagent (max 200)                                                     |
| `parentAgentId`  | no       | Makes this agent a subagent of another one (max 200)                                                                                 |
| `agentName`      | no       | Name under the character, also used by role rules (max 100)                                                                          |
| `role`           | no       | `dev`, `qa`, `ops` or `research` (anything else goes to dev). Only read from the agent's first event; overrides `office.config.json` |
| `cwd`            | no       | Working directory, used by role rules and shown in the panel (max 1000)                                                              |
| `timestamp`      | no       | ISO 8601 with `Z` or an offset; defaults to now                                                                                      |
| `detail.tool`    | no       | `edit`, `bash`, `read`, `search`, `web`, `agent` or `other`                                                                          |
| `detail.summary` | no       | A few words for the bubble (max 80)                                                                                                  |
| `detail.message` | no       | Longer text: waiting question, error message, prompt excerpt (max 2000)                                                              |
| `detail.mode`    | no       | Agent mode, kept until a new one arrives; `plan` sends the agent to the meeting room (max 40)                                        |

Event types: `agent.started`, `agent.thinking`, `agent.tool`, `agent.waiting`, `agent.idle`,
`agent.error`, `agent.ended`, `subagent.started`, `subagent.ended`.

The schema lives in [`src/shared/protocol/schema.ts`](../src/shared/protocol/schema.ts) and is
validated with zod.

### Server endpoints

| Endpoint                | Use                                                                        |
| ----------------------- | -------------------------------------------------------------------------- |
| `GET /health`           | `{"ok":true,"protocol":1}` when the app is up                              |
| `POST /events`          | One event or an array, in the format above                                 |
| `POST /ingest/<source>` | A raw hook payload from a CLI, converted by the app (used by the adapters) |

Accepted events get `202 {"accepted": <count>}`. Errors:

| Status | When                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------- |
| 400    | Invalid JSON, or an invalid event (with the list of problems). One invalid event rejects the whole array |
| 401    | A token is configured and the request does not carry it                                                  |
| 403    | The request has an `Origin` header, or a `Host` other than `127.0.0.1`/`localhost`                       |
| 404    | Unknown path, or no converter for that `<source>`                                                        |
| 413    | Body over 1 MB                                                                                           |
| 415    | A POST without `content-type: application/json`                                                          |

The server only listens on `127.0.0.1`. Browsers always send `Origin` on cross-site requests
and cannot send JSON without a preflight the server never answers, and the `Host` check
blocks DNS rebinding: a web page you visit cannot inject fake agents.

## Configuration

| Variable                        | Where            | Default                                | Purpose                                                     |
| ------------------------------- | ---------------- | -------------------------------------- | ----------------------------------------------------------- |
| `AGENT_OFFICE_PORT`             | app              | `4777`                                 | Server port                                                 |
| `AGENT_OFFICE_TOKEN`            | app and adapters | none                                   | When set, every POST must send it in `X-Agent-Office-Token` |
| `AGENT_OFFICE_CONFIG`           | app              | `office.config.json` in the app folder | Role rules file                                             |
| `AGENT_OFFICE_DEMO`             | app              | none                                   | `1` turns on demo mode, like `npm run demo`                 |
| `AGENT_OFFICE_TRANSCRIPTS`      | app              | on                                     | `0` stops following Claude Code transcripts                 |
| `AGENT_OFFICE_CLAUDE`           | app              | `claude`                               | Claude Code CLI used for agents put on tickets              |
| `AGENT_OFFICE_GITHUB_CLIENT_ID` | app              | none                                   | GitHub OAuth app client id for "Sign in with GitHub"        |
| `AGENT_OFFICE_URL`              | adapters         | `http://127.0.0.1:4777`                | Where the adapters send events                              |
| `AGENT_OFFICE_DEBUG`            | adapters         | none                                   | `1` prints adapter failures on stderr                       |

When you use a token, the adapters must see it too: set `AGENT_OFFICE_TOKEN` in the
environment Claude Code is started from, or in the `env` section of its settings.
