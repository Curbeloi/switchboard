---
source_hash: 65e7d2ee5da0f9a4649693023cbc89040483819a
generated_at: 2026-06-29T20:43:22.712Z
---
# tests

## Purpose
Unit test suite for the switchboard relay's core internal modules. Covers persistence (config store, message store), the LLM review pipeline (reviewer + orchestrator), and the subagents subsystem. All tests use Node's native test runner (`node:test`) with isolated temporary directories to avoid state leakage between runs.

## Key Components
- `config.test.js` — tests `createConfigStore`: config file creation, reads, writes, and persistence across instances
- `store.test.js` — tests `createStore` and `dmKeyFor`: agent registration, channel operations, messaging, read cursors, inbox counts, and waiter resolution
- `reviewer.test.js` — tests `createReviewer` with a stubbed `fetch`, verifying approve/reject/escalate decisions and fail-safe escalation on errors; also exercises `REVIEWER_PROVIDERS`
- `orchestrator.test.js` — tests `runReview` from the multi-agent orchestrator, using a mock `makeComplete` factory that simulates subagent completions or throws
- `subagents.test.js` — tests the subagents layer (likely spawning/config of review subagents) using a fresh config store per test

## Exports / Public Interface
No exports — all test files are executables run via `node --test` or `pnpm test`.

## Dependencies
- `node:test`, `node:assert/strict` — native test runner
- `node:fs`, `node:os`, `node:path` — temp directory isolation
- `../src/relay/config.js` — `createConfigStore`
- `../src/relay/store.js` — `createStore`, `dmKeyFor`
- `../src/relay/reviewer.js` — `createReviewer`, `REVIEWER_PROVIDERS`
- `../src/relay/agents/orchestrator.js` — `runReview`

## Notes
Each test file creates isolated state via `mkdtempSync` + cleanup, ensuring no shared disk state. The orchestrator and subagents tests mock out external calls rather than hitting real LLM APIs, keeping the suite fast and offline-safe. The `makeComplete` helper in `orchestrator.test.js` simulates both success paths and failure injection (`throwFor`), confirming the fail-safe escalation invariant holds.