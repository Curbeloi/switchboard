# Design: subagent-reviewers

> Created: 2026-06-29 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>

## Architecture at a glance

```
Canvas view (full page)            Relay (Node, server-side)
  master                           ┌───────────────────────────────────────┐
   └ project                       │ routes/index.js  (CRUD + run endpoints) │
      └ environment   ── trigger ─▶│ orchestrator.js  (LangGraphJS)          │
         └ subagent (review node)  │   compile deps → StateGraph             │
         └ subagent  ── depends ─▶ │   each node → reviewer.js complete()    │
                                   │ config.js  (subagents.json persistence) │
                                   └───────────────────────────────────────┘
```

Subagents are **configuration + server-side LLM calls**, not processes. LangGraph is used purely for **orchestration** (dependency-ordered, concurrent execution with shared state); the LLM call inside each node reuses the existing multi-provider layer. This keeps provider/key logic in one place (`reviewer.js`).

## Data model (config.js — mirror the `environments` pattern)

New durable file `~/.switchboard/subagents.json`: array of
```
{ id, environmentId, name, role, provider?, model?, dependsOn: string[], createdAt }
```
- `role` — the skill/rubric prompt (what to check; becomes the LLM `system`).
- `provider`/`model` — optional; fall back to the configured reviewer (`config.readReviewerConfig()` / `getEngine`-style default).
- `dependsOn` — ids of upstream subagents in the **same** environment (edges of the DAG).

New methods on `createStore`-style config object (`src/relay/config.js`), mirroring `addEnvironment`/`readEnvironments`/`getEnvironment`/`removeEnvironment`/`environmentsOfProject`:
- `readSubagents()`, `getSubagent(id)`, `subagentsOfEnvironment(environmentId)`, `addSubagent({environmentId,name,role,provider,model,dependsOn})`, `updateSubagent(id, patch)`, `removeSubagent(id)`.
- Validation: `validName(name)`; `environmentId` must exist; `dependsOn` ids must be subagents of the same environment; **reject cycles** (DFS) and self-deps. Cascade: `removeEnvironment` also removes its subagents (extend the existing cascade like `removeProject`).

## Orchestration (new `src/relay/agents/orchestrator.js`, LangGraphJS)

- Dependency: `@langchain/langgraph` (+ its peer `@langchain/core`). Server-side only.
- `createReviewGraph(subagents)` → builds a `StateGraph`:
  - State channels: `input` (the work under review), `verdicts` (map subagentId → verdict, reducer = merge).
  - One node per subagent; edges from each `dependsOn` id; roots wired from `START`, leaves to `END`. Independent nodes run concurrently (LangGraph executes ready nodes in parallel).
  - Node fn: call `complete(provider, { key, model, system: buildSystem(subagent), user: buildUser(input, upstreamVerdicts) })`, parse to `{decision, reason}` reusing `reviewer.js` `decisionFrom()`/`normalizeDecision()`. **Fail-safe:** any throw → `{decision:"escalate", reason:"<subagent> errored: …"}`.
- `runReview({ environmentId, input })` → resolve subagents, compile, `graph.invoke({input})`, return `{ verdicts: [...] }`. Provider keys resolved with the same helper routes already use (`resolveProviderKey`), so no new secret handling.
- **Input (what gets reviewed)** for v1: built by the route from (a) the environment's git diff (reuse the existing `/master/review` git-diff logic) and/or (b) the recent transcript of a chosen conversation. Master picks the scope.

## API (src/relay/routes/index.js — human/master surface, no agent token)

- `GET  /api/environments/:envId/subagents` → list.
- `POST /api/environments/:envId/subagents` → create (validates name/deps/cycles) → broadcast `subagent.created`.
- `PUT  /api/subagents/:id` → update (role/provider/model/dependsOn) → `subagent.updated`.
- `DELETE /api/subagents/:id` → remove → `subagent.deleted`.
- `POST /api/environments/:envId/review` → run the graph; body `{ conversation?, dir? }` selects input; returns `{ verdicts }`; broadcast `subagent.review` with results. (Distinct from the existing master `/conversations/:id/master/review` git-diff helper, which it may reuse internally.)
- `GET  /api/graph` → the whole node graph for the canvas: projects + environments + subagents (one call to bootstrap the view). Reuses existing project/environment reads + new subagent reads.

Broadcast events handled in `app.js` (like `environment.created` etc.) so the canvas updates live.

## UI — full-page canvas (src/ui/static)

- **Entry point:** a new header button next to `#settings-btn` (an inline `OCIcon` "graph"/"nodes"), toggling a full-page view that takes over the main area (pattern like `#console-pane`, not the `#overlay` modal). Hidden by default; toggled on click; Esc/close returns to the app.
- **Canvas library (decision below):** render nodes for master → projects → environments → subagents with hierarchy edges + subagent dependency edges; pan/zoom; auto-layout (left-to-right or top-down).
- **Config panel:** selecting a subagent opens a side form (name, role/skill textarea, provider `<select>` + model, dependsOn multi-select of sibling subagents). Selecting an environment offers "＋ subagent" and a "Run review" action (with scope picker: conversation and/or git diff). Verdicts render on/near each subagent node (approve/reject/escalate badge + reason), reusing the markdown renderer (`mdToHtml`) for reasons.
- i18n strings (en + es neutral) for all labels; colored gradient/logo language consistent with the rest of the UI.

## Key decisions

1. **LangGraph for orchestration, `reviewer.js` for the LLM call.** LangGraphJS (`@langchain/langgraph`) handles the dependency graph, concurrency, and shared state; each node calls the existing `complete()` so provider/keys/fail-safe stay in one place. (Chosen over LangChain model classes to avoid duplicating provider logic, and over a hand-rolled scheduler because the user wants LangGraph and it gives stateful graphs for free — enabling phase-2 review→fix→re-review loops.)
2. **Canvas: vanilla, no-build.** Recommend **Cytoscape.js** (vendored to `src/ui/static/vendor/`, loads without a bundler; mature pan/zoom + auto-layout) for rendering, plus a side panel for configuration (dependencies set in the form). **Alternative: Drawflow** (a node-wiring editor) if drag-to-connect editing is wanted now. → confirm during review; default Cytoscape + side-panel.
3. **Subagents are config + server-side calls, not PTYs.** Matches "a skill with an LLM behind it"; no new process management.
4. **Manual master trigger first.** Auto-trigger on coder "task done" (e.g. a `dsp.v1`-tagged completion message) is phase 2.

## Risks / open points
- **New deps** (`@langchain/langgraph`, `@langchain/core`) enlarge the install; verify they run under Node >= 22 ESM with no bundler. Pin versions.
- **Canvas lib** is the one UI dependency added to the no-build UI; vendoring a UMD/ESM build keeps "no build" true.
- **Cycle/large-graph** handling: validate cycles on write; cap graph size sanely.
- **Review input fidelity:** git diff + transcript is a heuristic of "the coder's work"; refine after first use.

## Phasing
- **Phase 1 (this spec):** data model + CRUD + canvas (view/configure) + manual master review run via LangGraph + verdicts. 
- **Phase 2 (follow-up specs):** auto-trigger on task completion; drag-to-wire edges; review→fix→re-review loops (LangGraph state shines here); export verdicts to the audit trail.
