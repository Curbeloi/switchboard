# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@icurbe/switchboard` — a supervised inter-agent messaging relay for Claude Code (or any MCP client). It lets two Claude Code sessions in different working directories exchange messages through named identities and channels, with a web UI for the human supervisor. See README.md for the user-facing pitch and quickstart.

## Run / build / test

This is plain Node ESM (`"type": "module"`), no bundler, no TypeScript. Node ≥ 20 is required.

- `npm start` — start the relay on `127.0.0.1:8765` (alias for `node bin/switchboard.js start`).
- `npm run dev` — same, with `node --watch` for auto-restart on edits.
- `npm test` — runs the Node native test runner against `tests/` (currently empty; new tests go there as `*.test.js`).
- `node --test tests/foo.test.js` — run a single test file.
- `switchboard mcp --agent NAME [--relay URL]` — run as an MCP stdio server registered as `NAME`. Used by Claude Code per project via `.mcp.json` (see `examples/mcp-config.example.json`).

To dogfood locally from this checkout: `npm link` once, then point each project's `.mcp.json` at the global `switchboard` binary.

## Architecture

Two halves of a single package, separated by a network boundary:

- **Relay side** (`src/relay/`) — the daemon. `server.js` mounts an Express app on the same `http.Server` as a `ws.WebSocketServer` (path `/subscribe`), then serves `src/ui/static/` at `/`. All REST endpoints live in `routes/index.js` and are mounted under `/api`. The data layer is `store.js`, an in-memory factory returning a documented interface (`registerAgent`, `postMessage`, `readMessages`, `approvePending`, etc.). The store is intentionally a closure-based module, not a class — the v0.2 plan is to swap it for a SQLite-backed implementation behind the same interface, so don't leak store internals into routes. `supervisor.js` is the in-process console REPL that subscribes to broadcast events on the same stdout the relay logs to; it skips itself when stdin isn't a TTY.

- **MCP side** (`src/mcp/`) — the per-session wrapper. `server.js` exposes three MCP tools (`agent_send`, `agent_read`, `agent_list_channels`) over stdio. It does a pre-flight `/api/health` + `registerAgent` and exits non-zero if the relay is unreachable, so Claude Code surfaces the error immediately on start. All HTTP calls go through `client.js` (`createRelayClient`), which is the only place that knows the relay URL shape.

- **Supervision UI** (`src/ui/static/`) — vanilla HTML/CSS/JS, no framework, no build step. `app.js` opens a single WebSocket to `/subscribe`, bootstraps state via three REST GETs, then reacts to broadcast events (`agent.registered`, `message.delivered`, `message.pending`, `message.rejected`, `approval.mode`).

The CLI entrypoint `bin/switchboard.js` is a thin dispatcher over `parseArgs`; it calls either `startRelay()` or `runMcp()`. Adding a subcommand means editing one file.

### Message flow

```
agent_send (MCP tool)
  → client.postMessage (HTTP POST /api/channels/:c/messages)
    → store.postMessage  (assigns id, status = "delivered" | "pending")
      → broadcast({ type: "message.delivered" | "message.pending", message })
        → all WebSocket subscribers (UI)
```

Approval mode is a global boolean on the store and is **on by default** (v0.1 design choice — supervision-first, opt out with `switchboard start --auto`). When on, `postMessage` returns a message with status `"pending"` and routes it into the `pending` map instead of the channel array; the UI calls `/api/approval/:id/approve` (or `/reject`) to drain it, and the console supervisor calls `store.approvePending(id) + broadcast(...)` directly. Both surfaces share the same state.

## Conventions that aren't obvious from the code

- **ESM-only.** No `require`. Use `node:` prefix for built-ins (`node:http`, `node:crypto`, `node:util`).
- **Routes never touch `store` internals directly** beyond the documented methods on the factory return value — keeps the SQLite swap clean.
- **Broadcasts are fire-and-forget.** Routes call `broadcast(event)` after mutating the store; there's no retry/queue. If WS delivery matters, fix it in `server.js`'s `broadcast`, not in routes. The same `broadcast` fans out to both WebSocket subscribers (UI) and in-process listeners registered via `subscribe(fn)` (currently only the console supervisor).
- **Agent identity comes from CLI flag, not from the message body.** `--agent NAME` is set once at MCP startup; the MCP server injects it as `from` on every send. Don't add a `from` argument to the MCP tools.
- **No persistence yet.** Everything (agents, channels, messages, pending queue, approval-mode toggle) is lost on relay restart. Treat this as v0.1 reality, not a bug.

## Where to make common changes

- New MCP tool → add to the `TOOLS` array and the switch in `src/mcp/server.js`; add a matching method on `createRelayClient` in `src/mcp/client.js`; add the route in `src/relay/routes/index.js`; if it mutates state, broadcast an event for the UI.
- New REST endpoint → `src/relay/routes/index.js` only.
- New broadcast event → emit from a route, then handle in `app.js`'s `handle()` switch.
- Swapping the store for SQLite → reimplement `createStore()` in `src/relay/store.js` with the same return shape; no other file should need to change.
