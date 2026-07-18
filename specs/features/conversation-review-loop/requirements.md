# Requirements: conversation-review-loop

> Created: 2026-07-04 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>

## Overview

Close the supervision loop between conversations and the LangGraph review subagents.
Today the reviewers live isolated in the Agent-graph canvas: running them requires a
view switch and the verdicts never reach the conversation where the coder works, and
"master" does not react when agents tag it. Three pieces, one loop:

1. **Run subagents from the conversation** — a master-bar button runs the project's
   review graph(s) and posts the verdicts INTO the conversation.
2. **Auto-draft when master is @tagged** — when a *delivered* message mentions
   `master`, the relay composes a reply draft (LLM) that appears in the master bar.
   **The human ALWAYS approves before it is sent** (explicit user rule — never
   auto-posted).
3. **Auto-trigger on "task done"** — when the coder posts a task-finished marker, the
   relay runs the reviewers of the SENDER's environment and posts the verdicts into
   the conversation addressed to the coder: approve → continue; reject → the coder
   fixes on its own; escalate → the human. Supervision by exception.

## Key design decisions (settled with the user)

- Verdicts POST AUTOMATICALLY into the conversation (user: "los veredictos caen en la
  conversación"). What the human always approves is the master's composed reply.
- Task-done detection: explicit marker `[task-done]` in content OR
  `data.task_status === "done"` — both, documented in the generated skill. No
  natural-language heuristics (false positives).
- The auto-trigger runs ONLY the sender's environment; the manual button can run all
  (or one) of the project's environments with subagents.
- Automation toggles (`masterDraftOnMention`, `reviewOnTaskDone`) default ON,
  editable in ⚙ Settings, persisted in `config.json`.
- React only to `message.delivered` — supervision (manual/llm) stays the gate.
- Anti-loop guards: ignore `from === "master"`, ignore `data.kind ===
  "review-verdicts"`, one in-flight review per environment.
- Fail-safe everywhere: reviewer/orchestrator errors → escalate (existing); compose
  errors → no draft (log only); automation never blocks or fails message delivery.

## User stories & acceptance criteria

### US1 — Master runs subagents from the conversation
- WHEN the supervisor clicks "Run subagents" in the master bar, THE SYSTEM SHALL run
  the review graph of the project's environment(s) with subagents (all by default; a
  picker when more than one) over git diff + conversation transcript.
- THE SYSTEM SHALL post one verdict message per environment into the conversation
  (from "master", `data.kind = "review-verdicts"`), rendered with per-subagent
  decision badges.
- IF the conversation has no project or no environment has subagents, THE SYSTEM
  SHALL return 409 with a clear error.

### US2 — Auto-draft on @master mention (human always approves)
- WHEN a delivered message includes "master" in `to` AND `masterDraftOnMention` is
  on AND a reviewer LLM is available, THE SYSTEM SHALL compose a reply draft and
  broadcast `master.draft` (kept in memory per conversation, retrievable via GET).
- THE draft SHALL appear in the master bar preview (editable); ONLY a human click on
  Send posts it (existing `/master/send`). THE SYSTEM SHALL NEVER auto-post it.
- IF composing fails, THE SYSTEM SHALL log and produce no draft (delivery unaffected).

### US3 — Auto-review on task done
- WHEN a delivered agent message matches `isTaskDone` (marker `[task-done]` or
  `data.task_status === "done"`) AND `reviewOnTaskDone` is on, THE SYSTEM SHALL
  resolve the sender's environment (`env.agentName === m.from`), and if it has
  subagents, run its review graph (git diff + conversation) and post the verdicts
  into the conversation addressed to the sender.
- Verdict messages and master messages SHALL NOT re-trigger automation (guards).
- Concurrent triggers for the same environment SHALL be coalesced (in-flight flag).

### US4 — Automation settings
- `GET/PUT /api/automation` SHALL read/update `{ masterDraftOnMention,
  reviewOnTaskDone }`, persisted in `config.json`, broadcasting `automation.updated`.
- ⚙ Settings SHALL show an "Automation" section with both toggles.

### US5 — Skill convention
- THE generated skill (Claude + OpenCode share `skillBody`) SHALL document: when a
  task is finished, post a message including `[task-done]` (or data
  `{task_status:"done"}`) so the environment's reviewers verify it and reply in the
  conversation.

## Verification
- Unit: `isTaskDone` (marker/data/negatives), from→env mapping, anti-loop guards,
  `runEnvironmentReview` with mocked `complete`, review-subagents 409 paths.
- Live: manual button posts verdicts; a `--to master` message produces an editable
  draft (never auto-sent); a `[task-done]` message triggers verdicts addressed to the
  coder without re-triggering; toggles off → no automation. (LLM runs spend provider
  tokens — supervisor-validated.)
