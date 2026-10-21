# Agent Office

A pixel-art open space where your AI coding agents live and work.

Every agent session you run (Claude Code today, Codex CLI and Gemini CLI soon) shows up as a
little 16-bit character. It walks in through the front door, sits at a desk in its team's
room, types while it uses tools, thinks, waits for you, goes for coffee when idle, and leaves
when the session ends. Subagents spawn next to their parent and head to their own room.

Agent Office only **observes**: it never calls a model API and never drives your agents. Your
CLIs report what they do through their own hook systems to a small local HTTP server inside
the app.

```
 Claude Code ──hook──▶ adapters/claude-code.mjs ──POST──▶ 127.0.0.1:4777 ──▶ the office
 your script ──────────────── curl ───────────────POST──▶ /events
```

## Requirements

- Node.js 22.12 or newer
- Windows, macOS or Linux

## Quick start

```bash
git clone <this repo> agent-office
cd agent-office
npm install        # also downloads the Electron binary
npm run demo       # opens the office with six simulated agents
```

The demo needs no AI at all: it simulates agents from every source, with subagents, plan
mode, waiting, errors and coffee breaks. Click a character to see its details and recent
timeline.

To watch your real agents, start the app without the demo:

```bash
npm run dev
```

The top bar shows `● listening on http://127.0.0.1:4777` when the server is up.

## Connecting Claude Code

Install the hooks once, then keep using Claude Code as usual.

```bash
# Every project you open with Claude Code (writes ~/.claude/settings.json)
npm run setup:claude

# Or a single project (writes <dir>/.claude/settings.local.json)
npm run setup:claude -- --project /path/to/your/project
```

`--user` (the default) and `--project` pick the scope. `--project` without a folder, or with
a relative one, is resolved from the directory you run the command in.

The setup script never changes anything silently:

- it prints the file, the command and the events it is about to add, then asks for
  confirmation. `--yes` (or `-y`) skips the question; without a terminal and without
  `--yes` it stops and changes nothing;
- it backs up the existing file as `<file>.bak-YYYYMMDD-HHMMSS` (UTC) before writing;
- it keeps every hook you already have and is safe to run twice;
- `--dry-run` prints the resulting file without writing it;
- `--uninstall` removes only the Agent Office hooks.

New Claude Code sessions pick the hooks up. Then open Claude Code in any project: your agent
appears at reception and walks to its desk.

### Things to know

- **Agent Office can be closed.** When the app is not running, the hook gives up quickly
  (500 ms for the request, at most 2 s waiting for its input), prints nothing and exits 0.
  Claude Code is never blocked or slowed down: hooks are installed with `"async": true`
  and `"timeout": 10`.
- **Don't move this folder after setup.** The hooks call
  `node "<absolute path>/adapters/claude-code.mjs"`. If you move or re-clone the repo, run
  `npm run setup:claude` again.
- **Don't commit a project's `.claude/settings.local.json`.** It contains a path that only
  exists on your machine. Check that it is in that project's `.gitignore`.

### What the office shows

| Claude Code hook                                                                                                               | In the office                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `SessionStart`                                                                                                                 | arrives at reception, walks to a desk                                       |
| `UserPromptSubmit`                                                                                                             | thinking bubble (`...`)                                                     |
| `PreToolUse`                                                                                                                   | typing, bubble with the action (`edit src/app.ts`, `npm test`)              |
| `PostToolUse`                                                                                                                  | thinking again while reading the result                                     |
| `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`) | blinking `?` bubble with the question                                       |
| `PostToolUseFailure`, `StopFailure`                                                                                            | red `!` bubble with the error (an interruption with Esc just makes it idle) |
| `Stop`, `Notification` (`idle_prompt`)                                                                                         | idle                                                                        |
| `SubagentStart` / `SubagentStop`                                                                                               | a new character next to its parent / it leaves                              |
| `SessionEnd`                                                                                                                   | walks out through the front door                                            |

- An idle agent stays at its desk, then goes for coffee 15 s after its last event. Waiting
  and failing agents stay at their desk so you can spot them.
- A session in plan mode moves to the meeting room.
- A session silent for 30 minutes is assumed gone, in case `SessionEnd` was missed. Its
  subagents leave with it.

## Rooms and roles

Each agent gets a role, and each role has a room: `dev`, `qa`, `ops` or `research`. Idle
agents gather in the kitchen; agents in plan mode use the meeting room.

Roles come from `office.config.json` at the root of this repo. The file is checked every
second and reloaded when it changes; rules apply to agents that arrive afterwards.

The shipped file:

```json
{
  "defaultRole": "dev",
  "rules": [
    { "match": { "agentName": ".*(review|test|qa|lint|verif).*" }, "role": "qa" },
    {
      "match": { "agentName": "explore|plan|.*(research|doc|search|guide).*" },
      "role": "research"
    },
    { "match": { "agentName": ".*(deploy|devops|infra|ops|release).*" }, "role": "ops" },
    { "match": { "cwd": ".*[\\\\/](infra|ops|deploy|terraform|k8s)([\\\\/].*)?" }, "role": "ops" }
  ]
}
```

To send every agent working in one project to a room, put a rule like this **first**:

```json
{ "match": { "cwd": ".*[\\\\/]my-infra-repo([\\\\/].*)?" }, "role": "ops" }
```

- A rule matches on `agentName`, `source`, `cwd` and/or `sessionId`. Each value is a regular
  expression, case-insensitive, matched against the **whole** field. Every field listed in a
  rule must match.
- `agentName` is the subagent type for subagents (`Explore`, `code-reviewer`…) and `Claude`
  for a main Claude Code session.
- The **first** matching rule wins, otherwise `defaultRole` applies. A `role` sent in an
  agent's first event wins over the rules.
- An agent keeps the role it got when it arrived; changing the rules does not move agents
  already in the office.
- If the file is invalid, the top bar shows a warning, the terminal explains why, and the
  built-in defaults apply until you fix it.

Set `AGENT_OFFICE_CONFIG=/path/to/office.config.json` to keep the file elsewhere.

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

The schema lives in [`src/shared/protocol/schema.ts`](src/shared/protocol/schema.ts) and is
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

| Variable              | Where            | Default                                | Purpose                                                     |
| --------------------- | ---------------- | -------------------------------------- | ----------------------------------------------------------- |
| `AGENT_OFFICE_PORT`   | app              | `4777`                                 | Server port                                                 |
| `AGENT_OFFICE_TOKEN`  | app and adapters | none                                   | When set, every POST must send it in `X-Agent-Office-Token` |
| `AGENT_OFFICE_CONFIG` | app              | `office.config.json` in the app folder | Role rules file                                             |
| `AGENT_OFFICE_DEMO`   | app              | none                                   | `1` turns on demo mode, like `npm run demo`                 |
| `AGENT_OFFICE_URL`    | adapters         | `http://127.0.0.1:4777`                | Where the adapters send events                              |
| `AGENT_OFFICE_DEBUG`  | adapters         | none                                   | `1` prints adapter failures on stderr                       |

When you use a token, the adapters must see it too: set `AGENT_OFFICE_TOKEN` in the
environment Claude Code is started from, or in the `env` section of its settings.

## Development

```bash
npm run dev          # app with hot reload
npm run demo         # app + simulated agents
npm test             # unit tests (vitest); npm run test:watch to keep them running
npm run typecheck    # TypeScript, strict
npm run lint         # ESLint
npm run format       # Prettier (format:check only reports)
npm run build        # production build into out/; npm start previews it
npx tsx scripts/sprite-preview.ts out.png   # contact sheet of every character variant
```

`AGENT_OFFICE_SCREENSHOT=out.png` saves a capture of the window after 12 s
(`AGENT_OFFICE_SCREENSHOT_DELAY` in ms changes the delay), handy to check rendering changes.

### Project layout

```
adapters/            hook scripts run by the CLIs (plain Node, no dependencies)
  forward.mjs        shared: stdin -> POST /ingest/<source>, 500 ms timeout, always exit 0
  claude-code.mjs
scripts/setup.mjs    install / uninstall hooks in a CLI's config
src/shared/          pure TypeScript, no Electron or DOM
  protocol/          event schema (zod)
  normalize/         raw hook payload -> protocol events, one file per CLI
  config/            office.config.json schema and role rules
  engine/            office state, floor plan, A* pathfinding, seat assignment, simulation
  demo/              the simulated agents of `npm run demo`
src/main/            Electron main process: HTTP server, config, IPC
src/preload/         the bridge exposed to the page
src/renderer/        canvas rendering: scenery, pixel-art characters, side panel
tests/               vitest; tests/fixtures/<cli>/ holds real hook payloads
```

The simulation in `src/shared/engine` decides where everyone is and what they do; the
renderer only draws it. That keeps the behaviour testable and lets the graphics be replaced
without touching the logic.

### Adding support for another CLI

1. Add the new source name to `SOURCES` in `src/shared/protocol/schema.ts`.
2. Add `adapters/<cli>.mjs`: `import { forward } from "./forward.mjs"; await forward("<source>");`
3. Write `src/shared/normalize/<cli>.ts`, which turns one raw payload into protocol events and
   never throws, then register it in `src/shared/normalize/index.ts`.
4. Capture real payloads into `tests/fixtures/<cli>/` (remove personal paths and prompts) and
   test the normalizer against them.
5. Write `scripts/setup/<cli>.mjs` (pure install/uninstall functions, like
   `scripts/setup/claude.mjs`), add an entry to `TARGETS` in `scripts/setup.mjs`, and a
   `setup:<cli>` script in `package.json`.

Tool names are turned into bubble text by
[`src/shared/normalize/tool-summary.ts`](src/shared/normalize/tool-summary.ts), which
already knows the Claude Code, Codex and Gemini tool names.

## Status

| Piece                          | State                           |
| ------------------------------ | ------------------------------- |
| Office, characters, animations | done                            |
| Local server and protocol v1   | done                            |
| Demo mode                      | done                            |
| Claude Code                    | done, tested with live sessions |
| Codex CLI                      | planned                         |
| Gemini CLI                     | planned                         |

Out of scope for v1: controlling agents from the app, several machines, long-term history,
a map editor.

## Credits

All graphics are drawn in code by this project; there are no third-party assets.
