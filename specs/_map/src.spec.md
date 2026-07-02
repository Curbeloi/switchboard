---
source_hash: e82d3aa56d47f4503702ef7f5a18aa52e182ec26
generated_at: 2026-07-02T16:23:13.377Z
---
# src

## Purpose
The core implementation of switchboard, a supervised messaging relay between AI coding agents. It's split into an MCP stdio wrapper (`src/mcp/`), the relay daemon (`src/relay/`), a static web supervision UI (`src/ui/static/`), and shared CLI-facing modules (`src/install.js`, `src/listen.js`, `src/send.js`, `src/tokens.js`) that back the `switchboard` CLI subcommands.

## Key Components
- `mcp/server.js` / `mcp/client.js` — per-session MCP stdio server exposing agent tools; `client.js` is the sole HTTP client to the relay.
- `relay/server.js` — boots Express + WebSocket server, wires store, routes, reviewer, config, and agent manager together.
- `relay/store.js` — `node:sqlite`-backed persistence (agents, channels, messages, read cursors), with versioned migrations (v1→v5, latest adding conversations-only model per project memory).
- `relay/routes/index.js` — all REST endpoints (`/api/*`), including git-review and "master" conversation compose/analyze prompt builders.
- `relay/reviewer.js` — LLM-based pending-message reviewer (Anthropic API or `claude`/`opencode` CLI), plus model listing and CLI availability checks.
- `relay/agents/manager.js` — manages registered agent identities, installs MCP/opencode integration per agent.
- `relay/agents/orchestrator.js` — LangGraph-based multi-subagent review graph (`createReviewGraph`/`runReview`).
- `relay/config.js` — durable on-disk config (mode, policy, contracts, engine) under `~/.switchboard`.
- `relay/supervisor.js` — console REPL supervisor over relay events.
- `ui/static/*` — vanilla JS/HTML/CSS supervision UI (Tailwind-built CSS, `i18n.js` for locale strings).
- `install.js` — MCP/opencode installation, skill scaffolding, session-start hook, doctor/uninstall.
- `listen.js`, `send.js`, `tokens.js` — background notification poller, fallback one-shot sender, shared token persistence.

## Exports / Public Interface
- `startRelay()` (server.js), `runMcp()` (mcp/server.js), `createRelayClient()` (mcp/client.js)
- `createStore()`, `createConfigStore()`, `createReviewer()`, `mountRoutes()`, `createAgentManager()`, `createReviewGraph()`/`runReview()`
- `installMcp()`, `installOpencode()`, `ensureSkill()`, `uninstallMcp()`, `doctor()`, `ensureSessionStartHook()`
- `runListen()`, `runSend()`, `loadToken()`/`saveToken()`/`tokenKey()`
- `startConsoleSupervisor()`

## Dependencies
Express, `ws`, `node:sqlite` (Node ≥22), `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `@langchain/langgraph`, `ajv` (schema validation), Node built-ins (`node:child_process`, `node:fs`, `node:crypto`, `node:os`). External CLIs invoked via `execFile`: `claude`, `opencode`, git.

## Notes
- Identity flows through Bearer tokens, never trusted request bodies (`requireAgent` pattern).
- Reviewer fails safe: any error escalates rather than auto-approving.
- Store migrations are incremental and additive (v1→v5); routes/MCP stay decoupled from schema via the store's documented method seam.
- Engine is pluggable (`claude` vs `opencode`), validated via `VALID_ENGINES` in config.js.
- UI has no build step for HTML/CSS/JS except Tailwind, which is compiled separately into `tailwind.css`.