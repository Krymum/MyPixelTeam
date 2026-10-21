#!/usr/bin/env node
// Claude Code hook adapter. Installed by `npm run setup:claude`; see README.
import { forward } from "./forward.mjs";

await forward("claude-code");
