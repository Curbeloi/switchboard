---
source_hash: 95f394a8379b6dfddee9abf8afb0a9917efd2798
generated_at: 2026-06-29T20:42:57.251Z
---
# docs

## Purpose
Planning and design documentation directory. Currently holds a single product plan for the "web-console" feature — a UI enhancement to switchboard that co-locates project definition, agent launching, and agent console output into a single web view, eliminating the need to switch between the IDE/terminal and the switchboard UI.

## Key Components
- `docs/plans/web-console.md` — Product plan for the per-agent web console feature on branch `feat/web-console`. Covers linking agents to projects, surfacing the CLI (claude/opencode) terminal output inline, and orchestrating agents from the supervision UI.

## Exports / Public Interface
None — this is documentation only, no code or exported symbols.

## Dependencies
Conceptually depends on: the supervision UI (`src/ui/static/`), agent registration (`src/relay/`), and the project/environment/conversation hierarchy described in the conversations-only branch.

## Notes
The plan is in analysis/pre-code state. It aligns with the broader product direction of making switchboard a unified orchestration surface rather than a passive message relay — consistent with the `feat/conversations-only` branch work already in progress.