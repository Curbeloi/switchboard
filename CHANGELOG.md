# Changelog

All notable changes to `@icurbe/switchboard` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); this project
uses [Semantic Versioning](https://semver.org/).

## [3.3.0] - 2026-06-26

First npm release since 2.8.0. It bundles the whole (previously unpublished) 3.x
line — the move to conversations, DSP contracts, and the web UI — plus the
multi-provider reviewer and the `master` mediator. Upgrading from 2.8.0 is a
**major** change for API consumers (messages moved from channels to
conversations); the on-disk store migrates existing data forward automatically on
boot (`PRAGMA user_version`). No manual migration step — but back up
`~/.switchboard/switchboard.db` first.

### Added
- **Multi-provider LLM reviewer.** The `llm` supervision reviewer is now
  provider-agnostic: **OpenAI**, **Google Gemini**, **Ollama** (local), and
  **OpenCode** (CLI) alongside Anthropic and the Claude CLI. `auto` keeps the
  legacy behavior (Anthropic key, else the `claude` CLI). Pick the provider/model
  live from **⚙ Settings → LLM provider** (applied without a restart); the model
  field has a dropdown populated from the provider, and CLI providers report
  whether they're installed. Provider config persists in `~/.switchboard/config.json`
  under `reviewer` (written `0600`); API keys are write-only over the HTTP API.
  New endpoints: `GET`/`PUT /api/reviewer`, `GET /api/reviewer/models`.
- **`master` — an LLM-mediated supervisor presence per conversation.** Compose a
  message to the agents from your instruction + the thread context (preview, edit,
  then delivered immediately as `master`, addressed so the listener wakes the
  recipients), or analyze the conversation for yourself. Target all members or one
  agent; a `verbatim` toggle skips the LLM. Endpoints
  `POST /api/conversations/:id/master` and `.../master/send`.
- **Channel membership from the web UI** — add/remove a connected agent from the
  conversations column (`POST`/`DELETE /api/channels/:c/members`).
- Conversations from 3.0.0; per-conversation state docs (PROGRESS.md); DSP
  contracts with the built-in `dsp.v1` from 3.1.0; multi-language (ES/EN) UI and
  light/dark/auto theme from 3.2.0.

### Fixed
- **Auto-wake listener.** `switchboard listen` polled the pre-v3
  `/api/channels/:c/messages` endpoint (removed in 3.0, now `410`), so agents
  never woke on new messages. It now enumerates each channel's conversations and
  polls `/api/conversations/:id/messages` (delivered-only).

### Changed
- UI: conversations list newest-at-bottom; the pending-approval block moved below
  the messages so it's visible without scrolling up.
- i18n: Spanish strings are neutral (no Argentine voseo).
- `package.json` `test` script works with current Node's `--test` discovery.

## [3.2.0] - prior (unpublished)
- Web UI: multi-language (ES/EN) and light/dark/auto theme.

## [3.1.0] - prior (unpublished)
- DSP P1: the relay enforces a contract per conversation; built-in `dsp.v1`.

## [3.0.1] - prior (unpublished)
- Web UI can manage conversations without an agent token.

## [3.0.0] - prior (unpublished)
- Conversations within channels; 3-column Tailwind supervision UI. **Breaking:**
  messages and state docs moved from channels to conversations.

## [2.8.0] - last published before 3.x
- Channel state doc (PROGRESS.md); the skill teaches the loop pattern.

[3.3.0]: https://github.com/Curbeloi/switchboard/releases/tag/v3.3.0
