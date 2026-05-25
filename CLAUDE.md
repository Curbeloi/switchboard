# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@icurbe/switchboard` — a supervised inter-agent messaging relay for Claude Code (or any MCP client). Claude Code sessions in different working directories exchange messages through token-authenticated named identities and channels (with @mention-style addressing), supervised by a human from a console REPL or a web UI. See README.md for the user-facing pitch and quickstart.

## Run / build / test

Plain Node ESM (`"type": "module"`), no bundler, no TypeScript. Node ≥ 22 (the store uses the built-in `node:sqlite`).

- `npm start` — start the relay on `127.0.0.1:8765` (alias for `node bin/switchboard.js start`).
- `npm run dev` — same, with `node --watch`.
- `npm test` — Node native test runner against `tests/` (currently empty; add `*.test.js`).
- `node --test tests/foo.test.js` — run a single test file.
- `switchboard mcp --agent NAME [--relay URL]` — run as an MCP stdio server identified as `NAME`.
- `switchboard install --agent NAME` — register the MCP for a project via `claude mcp add` and write the project skill (see below).

Dogfood from this checkout: `npm link` once so the global `switchboard` resolves to your working copy, then `switchboard install --agent NAME` inside a test project.

## Architecture

Two halves of a single package, separated by a network boundary:

- **Relay side** (`src/relay/`) — the daemon. `server.js` mounts Express on the same `http.Server` as a `ws.WebSocketServer` (path `/subscribe`) and serves `src/ui/static/` at `/`. REST endpoints live in `routes/index.js` under `/api`. The data layer is `store.js`, a `node:sqlite`-backed closure factory at `<configDir>/switchboard.db` (don't leak its SQL/internals into routes — keep the documented-method seam). `supervisor.js` is the in-process console REPL; it `subscribe()`s to broadcast events and shares the relay's stdout, and skips itself when stdin isn't a TTY.

- **MCP side** (`src/mcp/`) — the per-session wrapper. `server.js` exposes eight tools (`agent_send`, `agent_dm`, `agent_read`, `agent_inbox`, `agent_wait`, `agent_join`, `agent_list_channels`, `agent_list_agents`) over stdio. On startup it does `/api/health`, registers (obtaining a token), ensures the project skill exists, and exits non-zero if the relay is unreachable or the name is taken. All HTTP goes through `client.js` (`createRelayClient(url, token)`), the only place that knows the relay URL/auth shape.

- **Config store** (`src/relay/config.js`) — durable on-disk config under `~/.switchboard` (override `--config-dir`): `config.json` (mode + setupComplete), `policy.md` (reviewer rubric), `contracts/<name>.json` (named JSON Schemas). The relay reads it on boot to restore mode/policy; the web setup wizard and Settings panel write it. Unlike the message store, this **persists** across restarts.

- **Background listener** (`src/listen.js`, `switchboard listen --agent NAME`) — polls the relay's read-only endpoints (no token) and prints one stdout line per new message addressed to the agent (mentions + DMs), so a harness that turns stdout into notifications wakes the agent without blocking. Decoupled from consumption: it never advances read cursors. The generated skill tells each session to run it in the background.

- **Install/skill** (`src/install.js`) — `installMcp` shells out to the `claude` CLI (`claude mcp add --scope local`) so it never writes the project's `.mcp.json`; `ensureSkill` writes `.claude/skills/switchboard/SKILL.md` (idempotent). `uninstallMcp` removes the registration, cleans any legacy `.mcp.json` entry, and removes the skill. `doctor` checks relay + registration + skill.

- **Supervision UI** (`src/ui/static/`) — vanilla HTML/CSS/JS, no build. `app.js` opens one WebSocket to `/subscribe`, bootstraps via REST GETs, and shows a per-channel conversation view (click a channel → only its messages). Reacts to `agent.registered`, `channel.updated`, `message.delivered|pending|escalated|rejected`, `message.read`, `approval.mode`, `setup.updated`, `contracts.updated`, `policy.updated`. The mode control is a 3-way select (`llm` disabled when no reviewer); pending items render the reviewer's decision/reason and any structured `data`. On first run (when `~/.switchboard` config is missing) it shows a step-by-step **setup wizard** (mode → policy → contracts) that POSTs `/api/setup`; a **⚙ Settings** overlay edits mode/policy/contracts live afterward.

`bin/switchboard.js` is a thin `parseArgs` dispatcher: `start` / `mcp` / `listen` / `install` / `uninstall` / `doctor`.

### Message flow

```
agent_send(channel, content, to?)  [MCP tool, token attached]
  → client.postMessage (POST /api/channels/:c/messages, Bearer token)
    → requireAgent(token) → from = the token's agent (body `from` is never trusted)
      → store.postMessage (id, to[], status = "delivered" | "pending"; auto-joins sender + mentioned)
        → broadcast(message.delivered | message.pending) → WS (UI) + in-process listeners
          → on delivered: store.notifyWaiters() resolves any agent_wait long-polls
```

Supervision is a global **mode** (`store.getMode()`/`setMode()`): `manual` (default — every message held `pending` until a human approves), `auto` (deliver immediately), or `llm` (held `pending`, then an LLM reviewer drains the queue). `manual` and `auto` never call an LLM (zero tokens). A posted message is `pending` in manual/llm and `delivered` in auto; only on approval does it enter the channel, count toward inboxes, and wake waiters.

`llm` mode: `src/relay/reviewer.js` (`createReviewer`) judges each pending message against a rubric and returns `approve` / `reject` / `escalate`. server.js wires it via `subscribe()` on `message.pending` (only when `mode === "llm"`): approve→`approvePending`, reject→`rejectPending`, escalate→`markEscalated` (stays pending for a human, broadcasts `message.escalated`). **Fail safe: any reviewer error escalates — never auto-approves.** Two backends, picked at startup: the Anthropic API (Haiku + cached rubric) when `ANTHROPIC_API_KEY` is set, else `claude -p` headless when the `claude` CLI exists; otherwise the reviewer is unavailable and `llm` mode is rejected (409). The rubric treats the message as untrusted data (prompt-injection surface).

Verifiable contracts: `agent_send` accepts optional `data` plus either an inline `schema` (JSON Schema) or a `contract` name (resolved from the config store's `contracts/<name>.json`). `routes/index.js` validates `data` against the schema with `ajv` on post and returns 400 if it fails — a malformed contract never queues. The reviewer receives the (validated) structured data.

### Identity, channels, inbox, wake

- **Tokens.** `registerAgent(name, token?)` mints a token on first claim of a name; re-registering an existing name requires its token (else 409 → name uniqueness). The wrapper persists its token in `~/.switchboard/tokens.json` keyed by `relay::agent`, so a session restart re-claims its own name instead of colliding.
- **Channels have members.** `channels` maps name → `{ messages, members:Set, createdAt }`. `joinChannel`/`leaveChannel`; a DM is the canonical 2-member channel `dm:<sorted+names>`. Posting auto-joins the sender and any `to` mentions.
- **Read cursors + inbox.** Per-agent per-channel `lastReadAt`. `agent_read` advances the cursor (read receipt → `message.read` broadcast). `inboxFor(agent)` returns unread (and `mentioned`) counts per joined channel.
- **Wake.** `agent_wait` registers a waiter resolved by `notifyWaiters` on delivery (or returns already-unread immediately, or empty on timeout). Every MCP tool reply also appends an unread hint, so any tool call nudges the agent to read.

## Conventions that aren't obvious from the code

- **ESM-only.** No `require`. Use `node:` prefixes.
- **Identity is the token, not the body.** Agent-acting routes derive `from`/identity from the Bearer token via `requireAgent`. Never accept a `from` field from clients. Reads are token-optional (the human UI reads without one; a token only advances that agent's read cursor).
- **Routes use only the store's documented methods** — keeps the SQLite swap clean.
- **Broadcasts are fire-and-forget**, fanned out to WS subscribers (UI) and in-process `subscribe(fn)` listeners (the supervisor). Waiter resolution lives inside the store (`notifyWaiters`), not in routes.
- **Install never writes the project `.mcp.json`.** It uses `claude mcp add --scope local`. The only project files switchboard writes are under `.claude/skills/switchboard/`.
- **Everything persists.** Agents (+tokens), channels, membership, messages (incl. pending), and read cursors live in `<configDir>/switchboard.db` (`node:sqlite`, WAL) and survive relay restarts. The supervision **mode**, reviewer **policy**, and named **contracts** persist separately as files under `~/.switchboard` via `config.js`. Only live `agent_wait` waiters are in-memory (transient by nature). The `mode` value is held in-memory in the store but restored from `config.js` on boot.

## Where to make common changes

- New MCP tool → add to `TOOLS` + the switch in `src/mcp/server.js`; add a method on `createRelayClient` in `src/mcp/client.js`; add the route in `src/relay/routes/index.js` (gate with `requireAgent` if it acts as the agent); broadcast an event if it mutates state.
- New REST endpoint → `src/relay/routes/index.js`.
- New broadcast event → emit from a route (or the store), then handle it in `app.js`'s `handle()` switch.
- New supervisor command → `HELP` + the `handle()` switch in `src/relay/supervisor.js`.
- New persisted config (contracts/policy/mode/setup) → add IO to `src/relay/config.js`, expose it via routes (`/api/setup`, `/api/contracts`, `/api/policy`), and wire the wizard/Settings in `app.js`.
- Changing persistence/schema → `createStore()` in `src/relay/store.js` is `node:sqlite`-backed (tables created on boot with `CREATE TABLE IF NOT EXISTS`); keep the same return shape so routes/MCP stay untouched. Complex message fields (`to`, `data`, `schema`, `review`) are stored as JSON text columns.
