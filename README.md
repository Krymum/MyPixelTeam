# MyPixelTeam

A pixel-art open space where your AI coding agents live and work.

Every agent session you run (Claude Code today, Codex CLI and Gemini CLI soon) shows up as a
little 16-bit character. It walks in through the front door, sits at a desk in its team's
room, types while it uses tools, thinks, waits for you, goes for coffee when idle, and leaves
when the session ends. Subagents spawn next to their parent and head to their own room.

MyPixelTeam **observes** the agents you run yourself: Claude Code sessions are picked up
from the transcripts Claude Code already writes, with no setup. CLIs can also report what
they do through their own hook systems to a small local HTTP server inside the app.

It is also a **work tool**: connect GitHub (or Bitbucket), and Jira if your tickets live
there, pick a project, and put an agent on a ticket. The app runs Claude Code on it in its
own git worktree, moves the ticket along, and opens the pull request (see
[Working on tickets](#working-on-tickets)).

```
 Claude Code ──writes──▶ ~/.claude/projects/**/*.jsonl ──read──────────────▶ the office
 Claude Code ──hook──▶ adapters/claude-code.mjs ──POST──▶ 127.0.0.1:4777 ──▶ (optional)
 your script ──────────────── curl ───────────────POST──▶ /events
```

## Requirements

- Node.js 22.12 or newer
- Windows, macOS or Linux

## Quick start

```bash
git clone <this repo> mypixelteam
cd mypixelteam
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

### Windows executable

```bash
npm run dist       # builds dist/MyPixelTeam.exe, a single portable file
```

Copy the `.exe` anywhere and double-click it; launching it twice focuses the open window.
It is unsigned, so SmartScreen may ask for confirmation the first time. Hooks installed
from the `.exe` run a copy of the hook script kept in `%APPDATA%gent-officedapters`,
refreshed at each launch, so the `.exe` can be moved freely. In the `.exe`, the role
rules live in `%APPDATA%\agent-office\office.config.json` (copied from the shipped file on
first launch).

## Connecting Claude Code

**Nothing to install.** Claude Code writes every session to
`~/.claude/projects/<project>/<session>.jsonl` (`$CLAUDE_CONFIG_DIR/projects` when set),
and its subagents next to it. The app follows those files, read-only, so every session on
the machine shows up, whatever the project. At launch, sessions written in the last 10
minutes appear right away. Set `AGENT_OFFICE_TRANSCRIPTS=0` to turn this off.

Transcripts don't show everything: permission prompts and session ends are missing (an
agent with no activity for 30 minutes leaves on its own), and the format is internal to
Claude Code, so a future version may change it. Install the hooks for exact, documented
events; sessions that send hooks are then taken from the hooks only, never twice.

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
- `--uninstall` removes only the MyPixelTeam hooks.

New Claude Code sessions pick the hooks up. Then open Claude Code in any project: your agent
appears at reception and walks to its desk.

### Things to know

- **MyPixelTeam can be closed.** When the app is not running, the hook gives up quickly
  (500 ms for the request, at most 2 s waiting for its input), prints nothing and exits 0.
  Claude Code is never blocked or slowed down: hooks are installed with `"async": true`
  and `"timeout": 10`.
- **Don't move this folder after setup.** The hooks call
  `node "<absolute path>/adapters/claude-code.mjs"`. If you move or re-clone the repo, run
  `npm run setup:claude` again.
- **Don't commit a project's `.claude/settings.local.json`.** It contains a path that only
  exists on your machine. Check that it is in that project's `.gitignore`.

### What the office shows

The table lists hooks. Transcripts give the same picture except the rows marked "hooks
only": the user prompt, tool calls and results, end of turn, API errors and interruptions
all appear in them.

| Claude Code hook                                                                                                               | In the office                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `SessionStart`                                                                                                                 | arrives at reception, walks to a desk (transcripts: on its first prompt)                                  |
| `UserPromptSubmit`                                                                                                             | thinking bubble (`...`)                                                                                   |
| `PreToolUse`                                                                                                                   | typing, bubble with the action (`edit src/app.ts`, `npm test`)                                            |
| `PostToolUse`                                                                                                                  | thinking again while reading the result                                                                   |
| `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`) | blinking `?` bubble with the question (hooks only)                                                        |
| `PostToolUseFailure`, `StopFailure`                                                                                            | red `!` bubble with the error (an interruption with Esc just makes it idle; transcripts: API errors only) |
| `Stop`, `Notification` (`idle_prompt`)                                                                                         | idle                                                                                                      |
| `SubagentStart` / `SubagentStop`                                                                                               | a new character next to its parent / it leaves                                                            |
| `SessionEnd`                                                                                                                   | walks out through the front door (hooks only; otherwise after 30 min of silence)                          |

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

## Working on tickets

On first launch a **setup guide** walks through it all:

1. **Your machine**: checks git, Claude Code and its sign-in (`claude auth status`), and
   says how to fix what is missing. The top bar keeps a warning while agents can't run.
   One click installs the Claude Code hooks (optional, see
   [Connecting Claude Code](#connecting-claude-code)); Settings can update or remove them.
2. **Your accounts**: only what you use. GitHub alone is enough.
3. **Your projects**: the repositories you used Claude Code in lately, found automatically
   (see below), each with where its tickets live already chosen. Tick, add, done.

The guide is in **Settings** too, as are the accounts and projects; **Tickets** opens the
board of the active project.

### Accounts

Every account is optional; a project needs its code host, and Jira only if its tickets are
there:

| You use                 | Connect            | Tickets come from                 |
| ----------------------- | ------------------ | --------------------------------- |
| GitHub only             | GitHub             | the repository's GitHub Issues    |
| GitHub and Jira         | GitHub and Jira    | GitHub Issues or Jira, by project |
| Bitbucket (always Jira) | Bitbucket and Jira | Jira                              |

| Service         | What to enter                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira Cloud      | site (`acme` or `acme.atlassian.net`), Atlassian email, [API token](https://id.atlassian.com/manage-profile/security/api-tokens)                                                                                           |
| GitHub          | [fine-grained token](https://github.com/settings/personal-access-tokens/new) on the repositories agents may use: _Contents_, _Pull requests_ and _Issues_ read & write                                                     |
| Bitbucket Cloud | Atlassian email and an [API token with scopes](https://id.atlassian.com/manage-profile/security/api-tokens): `read:user`, `read:workspace`, `read:repository`, `write:repository`, `read:pullrequest`, `write:pullrequest` |

GitHub needs no token to create when you can sign in another way:

- **Sign in with GitHub**: the browser opens github.com, you type the code the app shows
  and approve. This uses a GitHub OAuth app with _Device Flow_ enabled
  (github.com/settings/developers → New OAuth app). Its client id is public: set it in
  `DEFAULT_GITHUB_CLIENT_ID` (`src/main/integrations/github-login.ts`) before building, or in
  `AGENT_OFFICE_GITHUB_CLIENT_ID`. The button only shows when one is set. The token gets
  the `repo` scope (code, pull requests and issues of every repository you can reach).
- **Use my GitHub CLI login**: shows when `gh` is installed and signed in, and reuses its
  token.

Each account is checked against the service before it is saved. Tokens are encrypted with
the OS keystore (DPAPI on Windows) in `accounts.bin` in the app's user data folder, stay in
the main process and are never shown again. Git gets them per command as an HTTP header: they
never land in `.git/config` or in a remote URL.

The app can do what the accounts can do, and nothing more: the ticket view only offers the
edits, status changes and comments Jira or GitHub allow that account.

### Projects

**Find my projects** (in the guide and in Settings) needs no typing:

- the folders come from the Claude Code transcripts (`~/.claude/projects`), most recent
  first; agents' own worktrees are left out and a worktree leads to its repository;
- each folder's `origin` remote names the GitHub or Bitbucket repository, which must be
  reachable by the connected account (a fine-grained GitHub token only sees the
  repositories it was given);
- tickets come from the repository's GitHub Issues, unless Jira is connected and ticket
  keys in the last 300 commit messages and in branch names (`PROJ-123`) name one of its
  projects. Either can be changed before adding.

**Add a folder…** does the same for any checkout, and **+ New project** sets one up by
hand. A project is a repository and where its tickets live (**Tickets from**: its GitHub
Issues, or a Jira project), plus:

- **Local folder**: an existing clone, or empty to let the app clone into
  `<user data>/repos/<host>/<owner>/<name>` on the first run.
- **Agent permissions**: what the mode doesn't allow on its own, the agent asks you (see
  [Answering agents](#answering-agents)). _Edit files, ask before commands_ (`acceptEdits`,
  the default) changes files freely and asks before every command; _Auto mode_ lets Claude
  Code judge each command and asks when unsure; _Everything_ (`bypassPermissions`) never
  asks and is for machines that are a sandbox.
- **Base branch**: where new ticket branches start and pull requests go (`develop`…);
  the repository's default branch when empty.
- **Model** and **instructions** added to every ticket ("run npm test before finishing").
- **Pull request**: push, open a pull request and move the ticket to review when done, or
  just commit locally.

The top bar picks the active project.

### Tickets

The board lists open tickets (search text or type a key, `PROJ-12` or `#12`; _done too_
shows the rest). A ticket shows its description and comments; you can change its summary,
description and status, comment, and create tickets. A Jira description is saved as plain
paragraphs, so rich formatting is lost; GitHub keeps its Markdown. GitHub issues are open or
closed (as completed or not planned).

### Putting an agent on a ticket

Before you start it, **Branch** picks where the agent works. The app asks origin for the
branches whose name mentions the ticket (`feature/HOT-1279-…`, `hot-1279`, `fix/#12`…): when
there is one, work may have started there and it is proposed first; otherwise the agent gets
a new branch from the base.

**▶ Put an agent on it** runs these steps:

1. fetches the base branch and creates a worktree in `<user data>/worktrees/<project>/<KEY>`,
   on the branch picked or on a new `agent/<KEY>-<summary>` (`agent/issue-12-…` for `#12`);
   your own checkout is never touched. On an existing branch the agent is told to build on
   what is there;
2. moves a Jira ticket to its "in progress" status, when it isn't already;
3. runs `claude -p` in the worktree with the ticket (title, description, latest comments) as
   the prompt; the character, named after the ticket, walks in and works like any other;
4. commits what the agent changed, pushes the branch and opens the pull request to the base
   branch (or finds the one already open). Only the agent's own work counts: an existing
   branch that it left untouched is not pushed again. A Jira ticket moves to a "review" status if the workflow has one
   and gets the pull request link as a comment; a GitHub issue is referenced with
   `Closes #12`, so merging the pull request closes it.

The **Agents** tab follows every run with its log and cost, and stops a run. Clicking the
character also links to its ticket and pull request. Running a ticket again reuses its
worktree and branch, so the new work lands in the same pull request. Closing the app stops
the agents it started.

Things to know:

- On GitHub, anyone can open an issue on a public repository, and an issue's text becomes
  the agent's instructions. Agents only take issues opened by the repository's owners,
  members and collaborators; for anyone else, the ticket shows a warning and the agent
  starts only once you tick "I read this issue and trust what it asks". Comments from
  people who aren't collaborators never reach an agent.
- Claude Code must be installed and signed in on this machine. `AGENT_OFFICE_CLAUDE` points
  at it when `claude` is not on the `PATH`.
- Statuses are matched by name and category ("In Progress", "En cours", "Code Review",
  "Revue"…). When no transition fits, the ticket is left as it is and the log says so.
- Worktrees stay on disk after a run so you can inspect them; remove them with
  `git worktree remove`.
- Runs are kept in `runs.json` in the user data folder (the last 50, with their logs). A
  run still going when the app crashed shows as failed.

### Answering agents

When an agent wants to do something its permission mode doesn't allow on its own (run
`npm test`, write outside its worktree…), it pauses and asks. Its character raises its hand
with a `?` bubble, the top bar shows "✋ 1 agent waiting for you", and a notification comes
up while the window is in the background. The ticket and the **Agents** tab show the exact
command with **Allow**, **Always allow for this run** (when Claude Code proposes a rule such
as `npm test:*`, it applies until the run ends and is written to no settings file) and
**Deny**; a refusal's reason is sent to the agent, which carries on without it. Clicking
the character links to the ticket.

### Continuing a run

Once a run is over, the ticket's **Continue where the agent left off** box resumes the same
Claude Code session (`--resume`) on the same branch and worktree: the agent remembers what it
did. Type what it should do next and, when there is a pull request, tick **Pass on the pull
request's review comments**: inline comments, reviews and general comments are added to the
instruction (on GitHub only those from owners, members and collaborators; on Bitbucket only
on private repositories). The new commits go to the same pull request.

Behind it, agents run with `--permission-prompt-tool stdio`: Claude Code sends each request
as a `control_request` on its output, and the app answers on its input.

### Notifications

While the window is not in front, a desktop notification tells you when an agent's pull
request is ready, when an agent failed, and when any agent waits for you (that one needs
the hooks, see [Connecting Claude Code](#connecting-claude-code)); the taskbar button
flashes too. Clicking a run notification opens its ticket. Turn them off in Settings.

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

## Development

```bash
npm run dev          # app with hot reload
npm run demo         # app + simulated agents
npm test             # unit tests (vitest); npm run test:watch to keep them running
npm run typecheck    # TypeScript, strict
npm run lint         # ESLint
npm run format       # Prettier (format:check only reports)
npm run build        # production build into out/; npm start previews it
npm run dist         # Windows portable executable: dist/MyPixelTeam.exe
npx tsx scripts/sprite-preview.ts out.png   # contact sheet of every character variant
```

`AGENT_OFFICE_SCREENSHOT=out.png` saves a capture of the window after 12 s
(`AGENT_OFFICE_SCREENSHOT_DELAY` in ms changes the delay), handy to check rendering changes;
`AGENT_OFFICE_OPEN=board` (or `settings`) opens that panel at start for the capture.

### Project layout

```
adapters/            hook scripts run by the CLIs (plain Node, no dependencies)
  forward.mjs        shared: stdin -> POST /ingest/<source>, 500 ms timeout, always exit 0
  claude-code.mjs
scripts/setup.mjs    install / uninstall hooks in a CLI's config
src/shared/          pure TypeScript, no Electron or DOM
  protocol/          event schema (zod)
  normalize/         raw hook payload -> protocol events, one file per CLI;
                     claude-transcript.ts does the same for transcript lines
  config/            office.config.json schema and role rules
  engine/            office state, floor plan, A* pathfinding, seat assignment, simulation
  demo/              the simulated agents of `npm run demo`
src/main/            Electron main process: HTTP server, transcript watcher, config, IPC
  integrations/      Jira Cloud, GitHub and Bitbucket REST clients, ADF <-> text;
                     trackers.ts: tickets from Jira or GitHub Issues behind one interface
  work/              encrypted accounts, projects, git worktrees, the agent runner
src/preload/         the bridge exposed to the page
src/renderer/        canvas rendering: scenery, pixel-art characters, side panel;
  src/work/          ticket board and settings dialog
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
| Claude Code (hooks)            | done, tested with live sessions |
| Claude Code (transcripts)      | done, tested with live sessions |
| Windows executable             | done, unsigned                  |
| Jira Cloud, GitHub, Bitbucket  | done, tested against mocks      |
| GitHub Issues as tickets       | done, tested against mocks      |
| Agents on tickets              | done                            |
| Codex CLI                      | planned                         |
| Gemini CLI                     | planned                         |

Out of scope for now: Jira Data Center, GitLab, several accounts per service, several
machines, long-term history, a map editor.

## Credits

All graphics are drawn in code by this project; there are no third-party assets.
