---
source_hash: b935b9bf6a77b2be41d3103bd8064a0eb8821351
generated_at: 2026-06-30T00:24:05.686Z
---
# tests

## Purpose
Unit and integration test suite for the switchboard relay, using Node's native test runner. Covers the four main subsystems (config store, message store, LLM reviewer, multi-agent orchestrator) plus two feature-specific areas (opencode auto-wake install logic, subagent config persistence).

## Key Components
- `config.test.js` — tests `createConfigStore`: mode/policy/contracts persistence across restarts, file layout under a temp config dir.
- `store.test.js` — tests `createStore`/`dmKeyFor`: message posting, read cursors, inbox counts, waiter resolution, DM channel naming.
- `reviewer.test.js` — tests `createReviewer`/`REVIEWER_PROVIDERS`: approve/reject/escalate decisions, fetch stubbing for the Anthropic backend, fail-safe escalation on errors.
- `orchestrator.test.js` — tests `runReview`: multi-agent orchestration logic, decision aggregation, per-agent throw handling via a mock `makeComplete` factory.
- `subagents.test.js` — tests subagent config CRUD through `createConfigStore`: storing and retrieving per-environment subagent definitions.
- `opencode-wake.test.js` — tests `opencodeWakePluginBody`/`installOpencode` from `src/install.js`: generated plugin file content, idempotent install, file existence checks.

## Exports / Public Interface
None — test files only; executed via `pnpm test` or `node --test tests/<file>.test.js`.

## Dependencies
- `node:test`, `node:assert/strict` — native test runner
- `node:fs`/`node:fs/promises`, `node:os`, `node:path` — temp directory setup and teardown
- `node:child_process` (`execFileSync`) — used in opencode-wake tests to invoke CLI behavior
- `../src/relay/config.js` — `createConfigStore`
- `../src/relay/store.js` — `createStore`, `dmKeyFor`
- `../src/relay/reviewer.js` — `createReviewer`, `REVIEWER_PROVIDERS`
- `../src/relay/agents/orchestrator.js` — `runReview`
- `../src/install.js` — `opencodeWakePluginBody`, `installOpencode`

## Notes
Each test file creates isolated state via `mkdtempSync`/`mkdtemp` temp directories and cleans up with `rmSync`/`rm` — no shared global state between tests. The orchestrator tests use a `makeComplete` mock factory that can simulate per-agent throws and inject decisions, isolating orchestration logic from real LLM calls. Reviewer tests stub `fetch` directly to avoid network calls.