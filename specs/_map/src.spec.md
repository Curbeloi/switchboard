---
source_hash: 26a76c98d27282313786fcc155e901569a17a930
generated_at: 2026-06-30T00:24:18.355Z
---
# src

## Purpose
The `src` directory is the complete implementation of `@icurbe/switchboard`, a supervised inter-agent messaging relay. It splits into two runtime halves: a persistent relay daemon (HTTP + WebSocket server, SQLite store, supervision console) and a per-session MCP stdio wrapper that exposes messaging tools to Claude Code agents. Supporting modules handle token persistence, agent installation, background listening, and a vanilla-JS supervision UI.

## Key Components
- `relay/server.js` — entry point for the daemon; wires Express + WebSocket, mounts routes, starts the reviewer and supervisor
- `relay/store.js` — all persistence via `node:sqlite`; agents, channels, messages, read cursors, versioned schema with v1→v5 migrations
- `relay/routes/index.js` — REST API (`/api/*`): message posting/approval, channel management, agent registration, setup/config, AI compose/analyze/review endpoints
- `relay/reviewer.js` — LLM supervision gate; supports Anthropic, OpenAI-compatible, and `claude`/`opencode` CLI backends; `approve`/`reject`/`escalate` decisions; fail-safe escalates on error
- `relay/agents/orchestrator.js` — LangGraph-based multi-subagent review graph for parallelizing LLM reviewer subagents
- `relay/agents/manager.js` — lifecycle management for registered agents (install MCP, install opencode, token handling)
- `relay/config.js` — durable file-backed config (`~/.switchboard`): mode, policy, contracts, engine selection; survives restarts
- `relay/supervisor.js` — in-process readline REPL for human oversight; subscribes to broadcast events
- `mcp/server.js` — MCP stdio server exposing 8 tools (`agent_send`, `agent_dm`, `agent_read`, `agent_inbox`, `agent_wait`, `agent_join`, `agent_list_channels`, `agent_list_agents`)
- `mcp/client.js` — HTTP client factory (`createRelayClient`) wrapping all relay API calls with Bearer auth
- `install.js` — `installMcp`/`installOpencode`/`ensureSkill`/`doctor`/`uninstallMcp`; writes session-start hooks and project skills; never touches `.mcp.json` directly
- `listen.js` — polling background listener; emits one stdout line per new message for harness-driven wake-up; watermark-based, never advances read cursors
- `send.js` — one-shot HTTP message sender; fallback when MCP tools are unavailable mid-session
- `tokens.js` — shared token IO (`~/.switchboard/tokens.json`, keyed by `relay::agent`)
- `ui/static/` — vanilla HTML/CSS/JS supervision UI; WebSocket-driven; setup wizard + settings overlay; i18n module; Tailwind + plain CSS

## Exports / Public Interface
- `startRelay(options)` — `relay/server.js`
- `createStore(options)` — `relay/store.js`
- `mountRoutes(app, deps)` — `relay/routes/index.js`
- `createReviewer(config)`, `complete(provider, opts)`, `listModels(provider, opts)` — `relay/reviewer.js`
- `createReviewGraph(subagents, opts)`, `runReview(opts)` — `relay/agents/orchestrator.js`
- `createAgentManager(deps)` — `relay/agents/manager.js`
- `createConfigStore(dir)` — `relay/config.js`
- `startConsoleSupervisor(deps)` — `relay/supervisor.js`
- `runMcp({ agent, relayUrl })` — `mcp/server.js`
- `createRelayClient(relayUrl, token)` — `mcp/client.js`
- `installMcp`, `installOpencode`, `ensureSkill`, `uninstallMcp`, `doctor`, `ensureSessionStartHook`, `removeSessionStartHook` — `install.js`
- `runListen(opts)` — `listen.js`
- `runSend(opts)` — `send.js`
- `loadToken`, `saveToken`, `tokenKey` — `tokens.js`

## Dependencies
- External: `express`, `ws`, `@modelcontextprotocol/sdk`, `@langchain/langgraph`, `@anthropic-ai/sdk`, `ajv`
- Node built-ins: `node:sqlite`, `node:http`, `node:fs`, `node:crypto`, `node:readline`, `node:child_process`, `node:path`, `node:os`, `node:module`
- CLI tools (optional, runtime): `claude`, `opencode` (for CLI-backed reviewer and agent installation)

## Notes
- Identity derives from Bearer token only — `from` in request body is never trusted
- Supervision mode (`manual`/`auto`/`llm`) is the central dispatch gate; `manual` and `auto` never invoke LLMs
- All store methods are the only seam routes may use — SQL never leaks into routes, enabling clean backend swaps
- The reviewer is fail-safe: any error escalates rather than auto-approving
- The `conversations-only` model (DB v5) has replaced the prior channels hierarchy; schema migrations handle upgrade in-place
- ESM-only (`"type": "module"`), Node ≥ 22, no bundler or TypeScript