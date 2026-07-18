# Requirements: engine-per-environment

> Created: 2026-07-02 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>

## Overview

The agent **engine** (Claude Code / OpenCode) is already stored **per environment**
(frozen at creation from the global default in `~/.switchboard/config.json`), and
`POST /api/environments` already accepts and validates an explicit `engine` — but the
**UI never exposes it**: the new-environment form doesn't send the field (so every
environment silently inherits the global), and the engine is invisible everywhere
(environment rows, console header). Real consequence: an environment named
"cognidata-opencode" was actually `engine=claude` and nothing in the UI showed it.

This feature is **UI-only** (`src/ui/static/app.js` + `i18n.js`): let the user pick the
engine when creating an environment (defaulting to the global), and make each
environment's engine visible.

## Design decision

**Per-environment selector with global default** — NOT a per-project engine. The backend
is already wired (zero relay/store/route changes); per-environment is strictly more
flexible (one project can mix Claude and OpenCode environments). A project-level engine
would require adding `engine` to projects + migration + more UI, and lose flexibility.

## Goals
- Pick the engine in the "New environment" form, preselected with the current global.
- See each environment's engine at a glance (row badge) and in the console header.
- Zero backend changes; reuse `engineOptionsHtml` and existing i18n keys.

## Non-goals
- Migrating existing environments (documented behavior: they keep their engine).
- Editing an environment's engine after creation.
- Per-project engine.

## User stories & acceptance criteria

### US1 — Choose the engine when creating an environment
- WHEN the user opens "New environment", THE form SHALL show an engine `<select>`
  (Claude Code / OpenCode) preselected with the current global engine (refreshed
  best-effort from `GET /api/setup` on open; fallback `claude`).
- WHEN the user submits, THE request body SHALL include the selected `engine` in both
  modes (existing dir / new folder); the backend validates against `VALID_ENGINES`.
- WHEN the user doesn't touch the select, THE created environment SHALL use the global
  engine (unchanged behavior).

### US2 — See the engine everywhere it matters
- THE environment row SHALL show a small read-only badge with the engine ("Claude" /
  "OpenCode"), with a tooltip.
- THE console header SHALL include the engine label between the agent name and dir.

## Verification
- `node --check` on `app.js` + `i18n.js`; `pnpm test` green (no regression — UI-only).
- Live: create an OpenCode environment WITHOUT touching the global → `environments.json`
  shows `engine: "opencode"`, row shows the badge, starting it writes `opencode.json` +
  the wake plugin in its dir; a Claude environment coexists in the same project.
