# Tasks: conversation-review-loop

> Created: 2026-07-04 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>

## 1. Shared review runner (`src/relay/review-run.js`, NEW)
- [x] Move `gitReview(dir)` from routes; export it (routes re-imports).
- [x] `isTaskDone(m)`: `[task-done]` in content (case-insensitive) OR
      `data.task_status === "done"`. Pure, exported.
- [x] `runEnvironmentReview({ env, conversationId, store, config, reviewer, resolveKey,
      complete? })` → builds input (git diff + optional last-30 transcript) and calls
      orchestrator `runReview`; returns `{ verdicts, truncated }` (`complete` injectable
      for tests).

## 2. Config (`src/relay/config.js`)
- [x] `automation` in config.json: `getAutomation()` → `{ masterDraftOnMention: true,
      reviewOnTaskDone: true }` defaults; saved via `saveConfig({ automation })`.

## 3. Relay wiring (`src/relay/routes/index.js` + `src/relay/server.js`)
- [x] server.js passes `subscribe` into `mountRoutes`.
- [x] Route `/environments/:id/review` refactored onto `runEnvironmentReview`.
- [x] `postVerdicts(conv, env, verdicts, to)` helper: posts from "master" (delivered),
      markdown summary + `data:{kind:"review-verdicts",environmentId,verdicts}`,
      broadcasts `message.delivered` + `subagent.review` (with conversationId).
- [x] `POST /api/conversations/:id/review-subagents` `{environmentId?}` → run all/one
      project env(s) with subagents; 409 when none.
- [x] Automation listener on `message.delivered` (guards: from master, verdict kind,
      in-flight per env): @master mention → compose draft → Map + broadcast
      `master.draft`; task-done → sender's env review → postVerdicts. All errors
      logged + swallowed (never affects delivery).
- [x] `GET /api/conversations/:id/master/draft` (in-memory Map; null when none;
      consumed by `/master/send`).
- [x] `GET/PUT /api/automation` (+ broadcast `automation.updated`).

## 4. Skill convention (`src/install.js`)
- [x] Document `[task-done]` marker (and `data.task_status`) in `skillBody`.

## 5. UI (`src/ui/static/app.js`, `index.html`, `i18n.js`)
- [x] Master bar: "Run subagents" button (+ env `<select>` when >1 env with
      subagents; default all) → POST review-subagents; busy state; hidden when the
      conversation's project has no reviewable env.
- [x] `messageNode`: `data.kind === "review-verdicts"` → verdictBadge + mdToHtml
      render instead of raw `<pre>`.
- [x] `master.draft` in `handle()` + fetch pending draft on conversation select →
      fill `#master-draft`, show preview with "auto draft" label; send = existing
      human-approved flow.
- [x] Settings: "Automation" section with the two toggles (PUT /api/automation).
- [x] i18n keys (en + es neutral).

## 6. Tests (`tests/automation.test.js`, NEW)
- [x] `isTaskDone` marker + data + negatives (no NL heuristics).
- [x] `runEnvironmentReview` with mocked complete (2 subagents, transcript + dir in
      input; env without subagents rejects).
- [x] Guards + sender→env mapping via agentName.

## 7. Verify
- [x] `node --check` all touched; `pnpm test` green (39/39).
- [x] Live (relay restarted on new code): `/api/automation` defaults + PUT round-trip;
      draft endpoint null; review-subagents without project → 409 with clear error.
      (LLM-spending flows — button verdicts, @master draft, [task-done] cycle — are
      the supervisor's to validate visually.)
- [x] `sdd spec refresh`; commit (Co-Authored-By Claude).
