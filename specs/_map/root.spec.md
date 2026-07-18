---
source_hash: 232d9895e526383bd2c6a517f27716213f71a6c2
generated_at: 2026-06-29T20:43:36.709Z
---
# root

## Purpose
Project root for `@icurbe/switchboard` (v3.4.0), a supervised inter-agent messaging relay for Claude Code. It wires together the relay daemon, MCP stdio server, supervision UI, CLI dispatcher, and config/token persistence into a single npm package. The root holds project metadata, documentation, and build config — not runtime logic.

## Key Components
- `package.json` — declares ESM package, `bin/switchboard` entry, pnpm as package manager, Node ≥ 22 requirement
- `CLAUDE.md` — authoritative architecture guide for AI assistants working in this repo
- `README.md` — user-facing quickstart, CLI reference, and feature overview
- `CHANGELOG.md` — semantic versioning history (currently at 3.4.0)
- `tailwind.config.js` — Tailwind CSS config for the supervision UI (must run `pnpm tailwind:build` after adding new classes)

## Exports / Public Interface
- `src/index.js` (main) — package entry point
- `bin/switchboard` — CLI dispatcher for `start`, `mcp`, `listen`, `send`, `install`, `uninstall`, `doctor`

## Dependencies
- Runtime: `express`, `ws`, `ajv`, `@anthropic-ai/sdk` (for LLM reviewer), `node:sqlite` (built-in, Node ≥ 22)
- Dev: `tailwindcss`, native Node test runner
- No bundler, no TypeScript

## Notes
- Plain ESM throughout — no `require`, always `node:` prefixes
- The package is designed to be globally linked (`pnpm link --global`) for dogfooding during development
- Tailwind CSS requires a manual rebuild step after adding new utility classes to UI files