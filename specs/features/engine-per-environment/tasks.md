# Tasks: engine-per-environment

> Created: 2026-07-02 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>
> UI-only: `src/ui/static/app.js` + `src/ui/static/i18n.js`. No backend changes.

## 1. New-environment form (app.js `openEnvForm`)
- [x] Add an engine `field` with `<select id="pf-engine">` reusing `engineOptionsHtml()`
      (id now parameterized, default "wiz-engine"), preselected with the global engine
      (`lastSetup?.engine`, refreshed best-effort via `GET /api/setup` on open; fallback
      "claude"); hint via new i18n key `envEngineHint`.
- [x] Include `engine: <select value>` in the POST body for both modes (new/existing).

## 2. Engine visibility (app.js)
- [x] `envRow`: small read-only badge next to the name — "Claude" / "OpenCode" via new
      `engineLabelOf()` helper (compiled Tailwind classes verified; tooltip = engine label).
- [x] `openConsole`: header becomes `agentName · <engine label> · dir`.

## 3. i18n (i18n.js, en + es neutral)
- [x] Add `envEngineHint`; reuse `engineLabel` / `engineClaude` / `engineOpencode`.

## 4. Verify
- [x] `node --check` app.js + i18n.js; `pnpm test` green (34/34).
- [x] Live (relay running): POST /api/environments with explicit `engine:"opencode"` →
      created with `engine=opencode` while the global stayed `claude`; invalid engine →
      400; test env deleted after. (Form/badge visual check is the supervisor's.)
- [x] `sdd spec refresh`; commit with Co-Authored-By Claude.
