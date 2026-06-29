# Tasks: subagent-reviewers

> Created: 2026-06-29 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>
> Phase 1 only (config + canvas + manual master review run). Phase 2 items live in design.md.

## 1. Data model (config.js)
- [x] Add `subagents.json` IO + methods on the config store mirroring `environments`: `readSubagents`, `getSubagent`, `subagentsOfEnvironment`, `addSubagent`, `updateSubagent`, `removeSubagent` (`src/relay/config.js`).
- [x] Validate on write: `validName(name)`, `environmentId` exists, `dependsOn` are sibling subagents, reject self-deps and cycles (DFS).
- [x] Cascade: `removeEnvironment` removes its subagents; `removeProject` cascade covers them transitively.
- [x] Unit tests for add/list/update/remove + cycle rejection + cascade (`tests/subagents.test.js`, `node:test`).

## 2. Orchestrator (LangGraphJS)
- [x] Add deps `@langchain/langgraph` + `@langchain/core` (pin versions); confirm ESM import under Node >= 22, no bundler.
- [x] New `src/relay/agents/orchestrator.js`: `createReviewGraph(subagents)` building a `StateGraph` (state: `input`, `verdicts` with merge reducer; edges from `dependsOn`; roots from START, leaves to END).
- [x] Node fn calls `complete(provider, {key,model,system,user})` (reuse `reviewer.js`), parse with `decisionFrom`/`normalizeDecision`; any throw → `escalate` (fail-safe).
- [x] `runReview({ environmentId, input })` → resolve subagents, compile, invoke, return `{ verdicts }`. Resolve keys via the routes' `resolveProviderKey` helper (export/share it).
- [x] Tests: graph runs independent nodes concurrently, respects deps, and a thrown node yields `escalate` (mock `complete`).

## 3. Routes (routes/index.js)
- [x] CRUD: `GET/POST /api/environments/:envId/subagents`, `PUT/DELETE /api/subagents/:id`; broadcast `subagent.created|updated|deleted`.
- [x] `POST /api/environments/:envId/review` (body `{ conversation?, dir? }`) → build input (reuse the existing git-diff review helper + conversation transcript), call `orchestrator.runReview`, return `{ verdicts }`, broadcast `subagent.review`.
- [x] `GET /api/graph` → `{ projects, environments, subagents }` to bootstrap the canvas.
- [x] Validation errors return 400 with clear messages (name/cycle/unknown env).

## 4. UI — full-page canvas (src/ui/static)
- [x] Vendor the chosen canvas lib (default Cytoscape.js) into `vendor/` (no-build load); add `<script>` in `index.html`.
- [x] Header: add a canvas button next to `#settings-btn` (inline `OCIcon`); toggle a full-page `#graph-pane` that takes over the main area (pattern like `#console-pane`, not `#overlay`).
- [x] Render nodes (master → projects → environments → subagents) + edges (hierarchy + `dependsOn`) from `GET /api/graph`; pan/zoom + auto-layout; light/dark aware.
- [x] Config panel: select subagent → form (name, role textarea, provider `<select>`, model, dependsOn multi-select); create/update/delete via the CRUD routes.
- [x] Environment node actions: "＋ subagent" and "Run review" → `POST .../review`; render per-subagent verdict badges + reason (via `mdToHtml`). (Scope picker: git diff default; conversation scope is phase 2.)
- [x] Handle broadcast events (`subagent.*`) in `app.js` to update the canvas live.
- [x] i18n strings (en + es neutral) for all new labels.

## 5. Verify (end-to-end)
- [x] Subagent CRUD verified live (create/list/400/delete) + persistence + cascade + cycle-reject covered by `tests/subagents.test.js`.
- [x] Review run verified at unit level (`tests/orchestrator.test.js`): dependency order + concurrency + thrown node → `escalate` + no-provider → `escalate`. (A real-provider run through the canvas is the supervisor's to validate — it spends the configured provider's tokens.)
- [x] `pnpm test` green (32/32); `node --check` on all edited JS; relay healthy; `cytoscape.min.js` served; no Tailwind rebuild needed (graph UI uses custom `.graph-*`/`.verdict-*` classes).
- [x] `sdd spec refresh` updated `specs/_map/`.
