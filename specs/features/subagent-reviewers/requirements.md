# Requirements: subagent-reviewers

> Created: 2026-06-29 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>

## Overview

Add a new hierarchy level — **subagents** — under environments. A subagent is a configurable **review node**: a role/skill prompt + an LLM (provider + model). Subagents supervise and review the work produced by an environment's coder agent. They form a dependency graph (tree/DAG) per environment, orchestrated with **LangGraph** (LangGraphJS, server-side in the relay). The human **master** can invoke threads of these subagents to verify a finished task and collect verdicts. A new **full-page canvas view** (not a modal, opened by an icon next to ⚙ Settings) visualizes the node graph `master → projects → environments → subagents` and lets the user configure subagents.

Resulting hierarchy: **master → projects → environments → subagents**. The first three already exist and are created by the existing flows; subagents are the new, user-configurable layer.

## Goals
- Configure named review subagents per environment (role/skill + provider + model + dependencies).
- Let the master trigger a review run that executes the environment's subagent graph over a task's work and returns per-subagent verdicts.
- Provide a full-page canvas to visualize the whole node graph and configure subagents.
- Reuse the existing multi-provider LLM layer (`reviewer.js` `complete()`, keys via `config.js`) — no new key handling.

## Non-goals (v1)
- Automatic invocation on coder "task done" (phase 2 — manual master trigger first).
- Drag-to-wire edge editing on the canvas (phase 2 — dependencies set via a config panel first).
- Subagents as separate spawned CLI processes (they are server-side LLM calls, not PTYs).
- Replacing the message reviewer (`llm` mode) — subagents review *work/tasks*, the reviewer gates *messages*; they coexist.

## User stories & acceptance criteria

### US1 — Configure subagents under an environment
As a supervisor, I want to add/edit/remove review subagents on an environment.
- WHEN the user opens an environment in the canvas, THE SYSTEM SHALL list its subagents and offer "add subagent".
- WHEN creating a subagent, THE SYSTEM SHALL require a name (valid name chars) + role/skill text, and accept an optional provider, model, and a set of upstream dependencies (other subagents of the same environment).
- WHEN provider/model are omitted, THE SYSTEM SHALL fall back to the configured reviewer provider/model.
- THE SYSTEM SHALL persist subagents in the config store and survive relay restarts.
- WHEN a dependency cycle would be created, THE SYSTEM SHALL reject the change with a clear error.

### US2 — Master invokes a review run
As the master, I want to verify a finished task by running the environment's subagent graph.
- WHEN the master triggers a review for an environment (optionally scoped to a conversation and/or the env's git diff), THE SYSTEM SHALL compile the subagents into a LangGraph graph (edges = dependencies) and execute it.
- THE SYSTEM SHALL run independent subagents concurrently and respect dependency order (a node sees its upstream nodes' verdicts).
- THE SYSTEM SHALL return one verdict per subagent: `{ subagent, decision: approve|reject|escalate, reason, ... }`.
- IF a subagent's LLM call errors, THE SYSTEM SHALL record that node as `escalate` (fail-safe) — never a silent pass. (Mirrors the reviewer fail-safe.)
- THE SYSTEM SHALL surface results to the master UI (and broadcast an event so the canvas/feed can react).

### US3 — Full-page canvas view
As a supervisor, I want a dedicated canvas to see and configure the whole graph.
- WHEN the user clicks the canvas icon next to ⚙ Settings, THE SYSTEM SHALL open a full-page view (taking over the main area, not a modal overlay) and render nodes for master, each project, each environment, and each subagent, with edges for the hierarchy and subagent dependencies.
- THE SYSTEM SHALL let the user select a node to view/edit its config (subagents editable; master/project/environment read-only here).
- THE SYSTEM SHALL let the user trigger a review run for an environment from this view and show per-subagent verdicts inline.
- THE SYSTEM SHALL work in light and dark themes and require no Tailwind rebuild for CSS-only/inline-SVG changes.

## Constraints
- ESM only, Node >= 22, no bundler. Browser UI stays vanilla/no-build; any canvas lib must load without a bundler.
- LangGraphJS runs only in the relay (server-side), never in the browser.
- Identity stays token-based; subagent config is a human/master surface (no agent token required), consistent with setup/contracts endpoints.
- Routes use only the store's documented methods; subagent persistence mirrors the `environments` pattern in `config.js`.
