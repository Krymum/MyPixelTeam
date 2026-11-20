# Watching your agents

How Claude Code sessions reach the office, what each character shows, and how agents are sent to rooms.

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
  `npm run setup:claude` again. Hooks installed from the Windows `.exe` run a copy of the
  hook script kept in `%APPDATA%\agent-office\adapters`, refreshed at each launch, so the
  `.exe` can be moved freely.
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
