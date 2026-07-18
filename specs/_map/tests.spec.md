---
source_hash: dd04dbad5d63787257b820a6ce53741e42584c9d
generated_at: 2026-07-04T23:41:14.589Z
---
# tests

## Purpose
Node native test-runner suite covering the relay's core modules: message store, config store, LLM reviewer, multi-agent review orchestrator, subagent config, OpenCode wake-plugin install, and end-to-end automation (environment review runs).

## Key Components
- automation.test.js — exercises `runEnvironmentReview`/`isTaskDone` from `review-run.js` against a real (temp-dir) config + message store, i.e. an integration test of the automated review pipeline.
- config.test.js — unit tests for `createConfigStore` (persisted `~/.switchboard`-style config: mode, policy, contracts).
- opencode-wake.test.js — tests `opencodeWakePluginBody` and `installOpencode` from `install.js`, verifying the OpenCode auto-wake plugin file is generated/installed correctly.
- orchestrator.test.js — tests `runReview` from `relay/agents/orchestrator.js` using a fake "complete" agent stub with injectable throw/decision behavior, covering error and decision-branch paths.
- reviewer.test.js — tests `createReviewer`/`REVIEWER_PROVIDERS` from `reviewer.js`, stubbing `fetch` to simulate the Anthropic API / CLI-backed reviewer backends.
- store.test.js — unit tests for `createStore` and `dmKeyFor` (channels, membership, messages, DMs, read cursors).
- subagents.test.js — tests subagent-related config persisted via `createConfigStore`.

## Exports / Public Interface
No exports — these are `node:test` test files run via `pnpm test` / `node --test tests/<file>`.

## Dependencies
`node:test`, `node:assert/strict`, `node:fs`/`node:fs/promises`, `node:os`, `node:path`, `node:child_process`; and the modules under test: `src/relay/review-run.js`, `src/relay/config.js`, `src/relay/store.js`, `src/relay/reviewer.js`, `src/relay/agents/orchestrator.js`, `src/install.js`.

## Notes
- Tests favor real, isolated state over mocks: most create a fresh temp dir (`mkdtempSync`/`mkdtemp` + `tmpdir()`) per test and a real `createConfigStore`/`createStore` instance, cleaning up with `rmSync`/`rm`.
- External calls (LLM reviewer HTTP, agent execution) are stubbed at the boundary (`fetch` stub in reviewer.test.js, fake `complete` agent in orchestrator.test.js) rather than mocking internal modules.
- File naming maps 1:1 to the module under test (`store.test.js` ↔ `store.js`, etc.), except `automation.test.js`, which is a cross-module integration test rather than a single-unit test.