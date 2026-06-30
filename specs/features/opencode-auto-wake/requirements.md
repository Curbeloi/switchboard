# Requirements: opencode-auto-wake

> Created: 2026-06-29 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>

## Overview

Make **OpenCode** agents react to incoming messages **on their own**, the same way
Claude Code agents already do. Today Switchboard lets the supervisor pick the engine
(Claude Code / OpenCode) and an OpenCode environment connects to the relay (MCP via
`opencode.json`, with all `agent_*` tools), but an OpenCode agent stays **inert**
until a human types in its console: it has no equivalent of Claude's background
`switchboard listen --once` wake mechanism (armed by `armListener`, gated to
`engine === "claude"`).

The fix is an **OpenCode plugin** that is generated into the environment alongside
`opencode.json`. The plugin polls the relay's read-only endpoints (the same ones
`src/listen.js` uses) and, on a new message addressed to the agent, **injects a turn**
into the active OpenCode session via the SDK — so the agent reads and replies without
a human prompt, symmetric to Claude's listener.

## Design notes (decision already taken)

- **Plugin, not server mode.** OpenCode auto-loads local plugins from
  `<cwd>/.opencode/plugins/*.{js,ts}` (no npm, no config entry). A plugin is
  `export const X = async (ctx) => ({ ...hooks })`; `ctx` brings `client` (the
  OpenCode SDK), `directory`, `$`, etc. The plugin runs **inside** the opencode
  process and loads at startup **without a human turn** — which is exactly the
  primitive Claude's PTY injection provides. The server-mode alternative
  (`opencode serve` + relay-driven `prompt_async`) would force rewriting the
  PTY-backed web console, so it is rejected. (Full rationale in the approved plan
  `revisa-algo-crees-que-moonlit-penguin.md`.)
- **Scope is `src/install.js` only.** The relay, store, broadcast, manager (PTY) and
  console do not change. `armListener` stays Claude-only (already returns early for
  opencode). The wake logic lives in the generated plugin, next to where we already
  generate the skill and `opencode.json`.
- **Read-only + decoupled, like the listener.** The plugin uses no agent token, never
  advances read cursors (the agent still consumes with `agent_read`), and seeds its
  watermark to "now" so it only reacts to **new** messages, never replays history.

## Goals
- An OpenCode environment, once installed, **auto-reacts** to messages addressed to it
  (mentions + DMs) by reading and replying — no human turn required.
- Faithful parity with `src/listen.js`'s detection (same endpoints, same "for me"
  filter, same skip-own-messages rule to avoid loops).
- Idempotent generation: writing the plugin never clobbers user files; `force`
  overwrites (same contract as the skill).

## Non-goals (v1)
- Persisted watermark across opencode restarts (in-memory "from now" is enough; a
  message arriving while the agent was off is picked up via `agent_inbox` on next use).
- Changing the relay, store, manager, or console.
- A CLI `install --engine opencode` path (the UI manager already calls
  `installOpencode`; a CLI flag is an optional extra).
- Auto-wake correctness when OpenCode has **no AI provider** configured (`opencode
  auth`) — that is a user prerequisite, independent of Switchboard.

## User stories & acceptance criteria

### US1 — OpenCode environment gets the wake plugin on install
As a supervisor, when I create/start an OpenCode environment, the wake plugin is
written so the agent can react on its own.
- WHEN `installOpencode` runs, THE SYSTEM SHALL write
  `<cwd>/.opencode/plugins/switchboard-wake.js` with the agent name and relay URL
  embedded.
- WHEN the plugin file already exists and `force` is not set, THE SYSTEM SHALL leave it
  untouched; WHEN `force` is set, THE SYSTEM SHALL overwrite it.
- THE SYSTEM SHALL keep writing `opencode.json` (mcp.switchboard + instructions) and
  the instruction file exactly as today (no regression).
- THE generated plugin SHALL be valid standalone JS (passes `node --check`) and import
  nothing from switchboard.

### US2 — The plugin wakes the agent on a new addressed message
As an OpenCode agent, I want to be nudged to read and reply when a message targets me.
- WHEN the relay has a new message in a conversation the agent belongs to, addressed to
  the agent (`to` includes the agent, or the conversation is a DM), THE plugin SHALL
  inject a turn into the active OpenCode session instructing it to
  `agent_read("<conversationId>")` and reply.
- THE plugin SHALL skip messages where `from === AGENT` (no self-wake loops).
- THE plugin SHALL seed its watermark to the load time and only react to messages newer
  than the last poll (no history replay).
- IF the active session id is unknown, THE plugin SHALL resolve it from OpenCode events
  and fall back to `client.session.list()` (most recent); if still unknown, it SHALL
  skip injection and retry on the next poll (never crash).
- IF any relay poll fails, THE plugin SHALL ignore the error and retry on the next tick
  (best-effort, never throw out of the interval).

### US3 — Uninstall removes the plugin
As a supervisor, when I uninstall, the generated plugin is cleaned up.
- WHEN uninstall runs in an environment, THE SYSTEM SHALL remove
  `<cwd>/.opencode/plugins/switchboard-wake.js` if present (leaving other plugins and
  files intact).

## Verification
- `node --check` on `src/install.js` and on a generated sample plugin.
- Unit-level: `opencodeWakePluginBody({agent, relay})` embeds the given agent/relay and
  produces `node --check`-valid source; `installOpencode` writes the plugin (idempotent
  + `force`); uninstall removes it.
- E2E (supervisor-run, needs `opencode auth`): Settings → engine OpenCode → start an
  OpenCode environment → from master send a message to it → within ~5s the agent runs
  `agent_read` and replies; no self-loop; restart reacts only to new messages.
