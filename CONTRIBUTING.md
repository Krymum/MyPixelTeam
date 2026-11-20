# Contributing to MyPixelTeam

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/Krymum/MyPixelTeam.git
cd MyPixelTeam
npm install
npm run demo     # the office with simulated agents: the quickest way to see a change
```

[docs/development.md](docs/development.md) lists every script and explains how the code is
laid out.

## Before opening a pull request

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
```

- Keep pull requests focused on one change, and add or update tests in `tests/` for
  behaviour changes. The office simulation in `src/shared/engine` is pure TypeScript, so
  most logic can be tested without Electron.
- Interface texts go through `t()` in `src/renderer/src/i18n.ts`; add their French
  translation to `src/renderer/src/i18n-fr.ts` (an English-only pull request is fine too,
  just say so).
- Hook payloads used as test fixtures must not contain personal paths, prompts or tokens.

## Reporting a security issue

Please don't open a public issue for a vulnerability (for example a way for a web page or a
ticket's text to control an agent). Use GitHub's
[private vulnerability reporting](https://github.com/Krymum/MyPixelTeam/security/advisories/new)
instead.
