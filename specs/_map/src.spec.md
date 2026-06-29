---
source_hash: dece0e53f222f3d3bc8d0bad6b3b75f043013d1f
generated_at: 2026-06-29T20:43:36.361Z
---
# src

## Purpose
The `src` directory is the complete implementation of Switchboard — a supervised inter-agent messaging relay. It splits into two runtime halves: a **relay daemon** (`src/relay/`) that persists messages, manages agent identities, enforces supervision policy, and serves a web UI; and an **MCP wrapper** (`src/mcp/`) that runs as a per-session stdio server giving Claude Code agents eight messaging tools. Supporting modules handle CLI install/uninstall, background listening, fallback sending, and token persistence.

## Key Components
- `relay/server.js` — entry point for the daemon; wires Express + WebSocket server, store, reviewer, config, agent manager, and routes onto a single `http.Server`
- `relay/store.js` — SQLite-backed (`node:sqlite`) data layer; owns agents, channels, messages (with `pending`/`delivered` lifecycle), read cursors, and inbox counts; versioned schema with migrations V1→V5
- `relay/routes/index.js` — all REST endpoints (`/api/*`); mounts via `mountRoutes`; handles message post/approve/reject, channel/agent CRUD, setup wizard, contracts, policy, git review, and AI compose/analyze for the conversation master
- `relay/reviewer.js` — LLM supervision gate; supports Anthropic, OpenAI (via Responses API), and `claude`/`opencode` CLIs; returns `approve`/`reject`/`escalate`; fail-safe escalates on any error
- `relay/agents/orchestrator.js` — LangGraph-based multi-subagent review graph (`createReviewGraph`/`runReview`) that fans pending messages through configurable subagents
- `relay/agents/manager.js` — manages launched agent processes (install MCP + opencode, token lifecycle) attached to the relay
- `relay/config.js` — durable file-backed config under `~/.switchboard`: mode, engine, policy, contracts; also owns `VALID_ENGINES`
- `relay/supervisor.js` — interactive console REPL for the human supervisor (approve/reject/escalate by command)
- `mcp/server.js` — stdio MCP server (`runMcp`); registers agent identity, exposes 8 tools (`agent_send`, `agent_dm`, `agent_read`, `agent_inbox`, `agent_wait`, `agent_join`, `agent_list_channels`, `agent_list_agents`)
- `mcp/client.js` — HTTP client factory (`createRelayClient`) — sole place that knows relay URL + Bearer auth shape
- `ui/static/` — vanilla HTML/CSS/JS supervision console; single WebSocket to `/subscribe`; handles all broadcast events; includes setup wizard and Settings overlay; i18n via `i18n.js`; Tailwind-generated `tailwind.css` + hand-written `style.css` for overlays
- `install.js` — `installMcp`/`uninstallMcp`/`ensureSkill`/`installOpencode`/`doctor`; shells out to `claude mcp add --scope local`, never writes `.mcp.json` directly
- `listen.js` — poll-based background listener (`runListen`); tracks a watermark per relay+agent, emits one stdout line per new message; never advances read cursors
- `send.js` — one-shot HTTP fallback sender (`runSend`) for when MCP tools drop mid-session
- `tokens.js` — shared token IO (`loadToken`/`saveToken`/`tokenKey`) under `~/.switchboard/tokens.json`

## Exports / Public Interface
- `startRelay(opts)` — starts the full daemon
- `runMcp({ agent, relayUrl })` — starts the MCP stdio server
- `createRelayClient(relayUrl, token)` — HTTP client for relay API
- `mountRoutes(app, { store, broadcast, reviewer, config, agents })` — mounts all REST routes
- `createStore(opts)` — SQLite store factory
- `createReviewer(config)` / `complete(provider, opts)` / `listModels(provider, opts)` — reviewer factory and LLM backends
- `createConfigStore(dir)` — config file factory
- `createAgentManager({ relay, broadcast, store })` — agent process manager
- `createReviewGraph` / `runReview` — LangGraph orchestrator
- `runListen(opts)` / `runSend(opts)` — background listener and fallback sender
- `installMcp` / `uninstallMcp` / `ensureSkill` / `installOpencode` / `doctor` — install lifecycle
- `loadToken` / `saveToken` / `tokenKey` — token persistence

## Dependencies
- **External:** `express`, `ws`, `@modelcontextprotocol/sdk`, `@langchain/langgraph`, `@anthropic-ai/sdk`, `ajv`
- **Node built-ins:** `node:sqlite`, `node:http`, `node:crypto`, `node:fs`, `node:readline`, `node:child_process`, `node:path`, `node:os`, `node:module`
- **Internal cross-cutting:** `tokens.js` is shared by `mcp/server.js`, `send.js`, and `relay/agents/manager.js`; `install.js` is shared by `mcp/server.js` and `relay/agents/manager.js`; `mcp/client.js` is shared by `mcp/server.js` and `send.js`

## Notes
- Identity is derived from the Bearer token server-side; client-supplied `from` fields are never trusted.
- Supervision mode (`manual`/`auto`/`llm`) is stored in-memory in the store and restored from `config.js` on boot; changing it persists to disk.
- All message delivery, approval, and waiter resolution flow through the store — routes and MCP tools never bypass it.
- The reviewer fail-safe (escalate on error) ensures `llm` mode never auto-approves on failure.
- The UI is framework-free; `tailwind.css` must be rebuilt (`pnpm tailwind:build`) after adding new Tailwind classes.
- DB schema is versioned with explicit migration functions (V1→V5); the current model is Project › Environment › Conversation (no freestanding channels).