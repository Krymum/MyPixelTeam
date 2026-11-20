# Development

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
The interface follows the system language; `npm run demo -- --lang=en-US` forces English.

If the app crashes at start with `Cannot read properties of undefined (reading
'commandLine')`, Electron is running as plain Node: unset `ELECTRON_RUN_AS_NODE`, which some
editors' terminals set.

## Project layout

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

## Adding support for another CLI

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
[`src/shared/normalize/tool-summary.ts`](../src/shared/normalize/tool-summary.ts), which
already knows the Claude Code, Codex and Gemini tool names.
