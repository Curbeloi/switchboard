---
source_hash: a0ef4232aecd89b0d788132367bcb17e490af12f
generated_at: 2026-06-29T20:42:59.676Z
---
# bin

## Purpose
Entry point dispatcher for the `switchboard` CLI. Parses subcommands via `parseArgs` and routes to the appropriate module handler. Reads `package.json` for version info and exposes a `help()` function for usage output.

## Key Components
- `switchboard.js` — thin dispatcher; handles `start`, `mcp`, `listen`, `send`, `install`, `uninstall`, `doctor` subcommands

## Exports / Public Interface
None — this is a runnable script (`#!/usr/bin/env node`), not an importable module.

## Dependencies
- `node:util` (`parseArgs`), `node:fs` (`readFileSync`)
- `src/relay/server.js` → `startRelay`
- `src/relay/supervisor.js` → `startConsoleSupervisor`
- `src/mcp/server.js` → `runMcp`
- `src/install.js` → `installMcp`, `uninstallMcp`, `doctor`
- `src/listen.js` → `runListen`
- `src/send.js` → `runSend`

## Notes
Intentionally thin — no business logic lives here. Each subcommand delegates immediately to a dedicated module, keeping the dispatcher easy to extend. Flag parsing is done with Node's built-in `parseArgs`, no third-party CLI framework.