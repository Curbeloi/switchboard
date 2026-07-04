---
source_hash: 1d427053ea700fd280f4adcac4615830a4348d4d
generated_at: 2026-07-04T23:41:18.254Z
---
# src

## Purpose
The core implementation of switchboard, a supervised messaging relay for inter-agent (Claude Code / MCP) communication. It's split into an MCP stdio wrapper (`src/mcp/`), the relay daemon (`src/relay/`), a static web supervision UI (`src/ui/static/`), and standalone CLI helpers (`install.js`, `listen.js`, `send.js`, `tokens.js`) that let an agent register, send messages, wait for wakeups, and manage installation without depending on a live MCP session.

## Key Components
- **`mcp/server.js` / `mcp/client.js`** — MCP stdio server exposing agent tools (send/read/wait/etc.), backed by an HTTP client to the relay.
- **`relay/server.js`** — boots Express + WebSocket server, wires store, reviewer, config, and agent manager together.
- **`relay/store.js`** — `node:sqlite`-backed persistence (messages, agents, channels, cursors) with versioned migrations (v1→v5).
- **`relay/reviewer.js`** — LLM-based supervision gate; supports multiple providers (Anthropic, OpenAI, CLI-based) and returns approve/reject/escalate decisions.
- **`relay/review-run.js`** — runs git-based review workflows and environment task-completion checks.
- **`relay/agents/orchestrator.js`** — LangGraph-based multi-subagent review pipeline (`createReviewGraph`/`runReview`).
- **`relay/agents/manager.js`** — manages agent lifecycle, installs MCP/OpenCode integrations per agent.
- **`relay/config.js`** — durable on-disk config (mode, policy, contracts, engine selection).
- **`relay/supervisor.js`** — interactive console REPL for human supervision.
- **`ui/static/`** — vanilla JS/HTML/Tailwind web UI mirroring the console supervisor.
- **`install.js`** — installs/uninstalls MCP registration, writes project skill files, session-start hooks, OpenCode wake plugin.
- **`listen.js` / `send.js` / `tokens.js`** — lightweight standalone helpers: background polling listener, one-shot HTTP send, and shared token persistence.

## Exports / Public Interface
- `runMcp` — start the MCP stdio server.
- `createRelayClient` — HTTP client factory for talking to the relay.
- `startRelay`, `createStore`, `createReviewer`, `createConfigStore`, `createAgentManager` — relay bootstrapping primitives.
- `createReviewGraph`, `runReview` — multi-agent review pipeline.
- `gitReview`, `isTaskDone`, `runEnvironmentReview` — review-run automation.
- `startConsoleSupervisor` — human REPL.
- `installMcp`, `installOpencode`, `uninstallMcp`, `ensureSkill`, `doctor`, `ensureSessionStartHook` — install/lifecycle management.
- `runListen`, `runSend`, `loadToken`/`saveToken`/`tokenKey` — CLI-side agent utilities.

## Dependencies
Node built-ins (`node:sqlite`, `node:http`, `node:child_process`, `node:fs`, `node:crypto`), `express`, `ws`, `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `@langchain/langgraph`. No frontend build tooling — UI is plain JS/CSS plus a compiled `tailwind.css`.

## Notes
- Store schema evolves via sequential migration functions (`migrateV1toV2` … `migrateV4toV5`), following the CLAUDE.md-documented "conversations-only" model (channels removed in v5).
- Reviewer supports pluggable providers/CLIs with a fail-safe default: any error escalates rather than auto-approving.
- Install/token logic is intentionally decoupled from the live MCP connection so agents can keep messaging via `send.js`/`listen.js` if the MCP tools drop.
- The orchestrator/manager pair (LangGraph + engine selection) reflects a recent expansion toward multi-provider, multi-subagent supervision (Claude + OpenCode).