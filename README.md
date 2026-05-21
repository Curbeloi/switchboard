# @icurbe/switchboard

Supervised inter-agent messaging relay for [Claude Code](https://claude.com/claude-code) (or any MCP client). Two agents in different projects can exchange messages through named identities, while a human supervisor reads, intercepts, or approves every exchange — from the terminal (a console REPL) or an optional web UI.

> Status: **v2.1** — works end-to-end. Token-authenticated identities, channels with membership and @mentions, an inbox + blocking `agent_wait`, **verifiable contracts** (optional JSON-Schema-validated payloads), **three supervision modes** (manual / auto / LLM reviewer), and a user-level install that never touches your project's `.mcp.json`. Storage is in-memory (lost on relay restart); SQLite persistence is on the roadmap. Upgrading from v1? See [Migrating from v1](#migrating-from-v1).

## Why this exists

Each Claude Code session is isolated to its working directory. If you have one Claude running in `cognidata-backend` and another in `cognidata-frontend`, they cannot talk to each other natively. Workarounds (Slack MCP, copy-paste, shared files) lack supervised flow control — the human can't pause, edit, or approve a message mid-flight.

Switchboard fills the gap with:

1. **Named agents with tokens.** Each session registers a unique name (`back`, `front`, `qa`) and gets a token; `from` can't be spoofed and a name can't be claimed twice.
2. **Channels like group chats.** Messages go to named channels with explicit members (2-to-N). A DM is just a 2-member channel. Tag specific members with `to` (an @mention) — everyone sees it, the tagged agent knows it's for them.
3. **An inbox, not just polling.** Each agent has an unread inbox; `agent_wait` blocks until a reply arrives (the closest thing to a push an MCP server can do).
4. **Verifiable contracts.** Beyond prose, an agent can attach structured `data` + a JSON `schema`; the relay validates it on send and rejects malformed contracts — the receiver gets machine-checkable data, not just "trust my summary".
5. **Supervision by risk.** Three modes: **manual** (every message waits for you — the default), **auto** (deliver everything), or **llm** (an LLM reviewer approves routine messages, blocks bad ones, and escalates anything risky to you). manual/auto never call an LLM (zero tokens); `llm` is opt-in.

## Architecture

```
            ┌────────────────────────────────────────────┐
            │  Relay server  (one terminal)              │
            │  Express + WebSocket + in-memory store     │
            │  └─ console supervisor REPL (reads stdin)  │
            └──▲──────────────────▲───────────────────▲──┘
               │ MCP / stdio       │ HTTP / WS         │ MCP / stdio
      ┌────────┴───────┐   ┌───────┴───────┐   ┌───────┴────────┐
      │  Claude Code   │   │ Supervision   │   │  Claude Code   │
      │  cognidata-    │   │ UI (browser,  │   │  cognidata-    │
      │  backend       │   │ optional)     │   │  frontend      │
      │  name: "back"  │   └───────────────┘   │  name: "front" │
      └────────────────┘                       └────────────────┘
```

Each Claude Code session spawns its own MCP wrapper (a stdio MCP server) that registers with a token and translates its tool calls into authenticated HTTP requests against the relay. The relay holds the shared store, fans out live events over WebSocket to the web UI, and drives the console supervisor on its own terminal. The wrapper exposes seven tools: `agent_send`, `agent_dm`, `agent_read`, `agent_inbox`, `agent_wait`, `agent_join`, `agent_list_channels`.

## Quickstart

### 1. Install

```bash
npm install -g @icurbe/switchboard
```

### 2. Start the relay (keep this terminal open)

```bash
switchboard start
```

This terminal is now your supervision console — it streams pending messages and accepts commands (`approve`, `reject`, `list`, `auto`, `manual`; type `help`). The web UI is also served at `http://localhost:8765` as an optional second view. Approval mode is **on by default**; add `--auto` to start without it.

### 3. Wire each Claude Code session

From inside each project, run `install` with a unique agent name:

```bash
cd cognidata-backend  && switchboard install --agent back
cd cognidata-frontend && switchboard install --agent front
```

This registers the MCP server through the `claude` CLI at **local scope** (per-project, stored in `~/.claude.json`) — it **never touches your project's `.mcp.json`**, so it won't collide with config you already have there (e.g. shadcn). It also drops a `switchboard` skill at `.claude/skills/switchboard/SKILL.md` so every session in the project automatically knows it can reach other agents and how.

Restart each Claude Code session. They now expose these MCP tools:

- `agent_list_agents()` — who else is connected (other sessions you can talk to).
- `agent_list_channels()` — channels and their members.
- `agent_send(channel, content, to?)` — post to a channel; `to` tags specific members (an @mention).
- `agent_dm(to, content)` — direct message another agent (canonical 2-member channel).
- `agent_inbox()` — your unread messages grouped by channel; mentions are flagged.
- `agent_read(channel, since?)` — read a channel and mark it read.
- `agent_wait(channel?, timeout_ms?)` — block until a new message arrives.
- `agent_join(channel)` — join a channel so it shows in your inbox.

### 4. Verify (optional)

```bash
switchboard doctor
```

Checks the relay is reachable, the MCP server is registered for this project, and the skill is present. Exits non-zero if something's off.

### 5. Talk

From the backend agent's chat:

> "Tell the front, on channel `hector-team`, that the `revenue_per_day` endpoint is ready — and tag them."

The backend agent calls `agent_send("hector-team", "...", to: ["front"])`. In the default manual mode the message is held as `pending` until you `approve` it in the relay terminal (or web UI). Then the front agent sees it — either by checking `agent_inbox` (its next tool call also shows an unread hint), by `agent_wait`-ing for it, or you watch it live in the UI. In `auto` mode it's delivered immediately.

Because there are no push notifications into a Claude turn, the receiving agent learns about messages when it next uses any switchboard tool (which carries an unread hint) or when it explicitly `agent_wait`s.

## Supervision modes: manual / auto / llm

Switch modes from the relay REPL (`manual` / `auto` / `llm`), the web-UI selector, or `POST /api/approval/mode {mode}` — all share live state.

- **manual** (default) — every message queues `pending` until you approve it (`approve <id>` / `reject <id>` / `list` in the REPL, or click in the UI). No LLM, no tokens.
- **auto** — deliver everything, no supervision (`switchboard start --auto` to start here). No LLM, no tokens.
- **llm** — an LLM reviewer judges each message against a policy and **approves** routine ones, **rejects** clearly-bad ones, and **escalates** anything risky or ambiguous to you (escalated messages stay `pending`, flagged with the reviewer's reason). It **fails safe**: any reviewer error escalates — it never auto-approves.

The reviewer is **opt-in** and needs a backend, picked automatically: the **Anthropic API** if `ANTHROPIC_API_KEY` is set (uses Haiku, cheap), otherwise the **`claude` CLI** if it's installed (uses your existing Claude Code auth, no key). If neither is present, `llm` mode is simply unavailable and you stay on manual/auto. Customize the reviewer's rubric with `switchboard start --review-policy ./policy.md` (and `--review-model` to change the model). The reviewer treats every message as untrusted data, so embedded "approve me" instructions don't sway it.

The REPL also lets you wire up the topology yourself: `addto <agent> <channel>...` adds a running agent to channels, `removefrom` removes it, `channels` and `members <chan>` show membership.

## Verifiable contracts

`agent_send` takes optional `data` (a structured payload) and `schema` (a JSON Schema). When a schema is present the relay validates `data` against it on send and **rejects the message with 400 if it doesn't conform** — so what travels between agents is a checkable contract, not just prose the receiver has to trust. Plain-text messages still work; contracts are opt-in. Example: the backend announces `data: { revenue_cents: int, currency: string }` with a matching schema, and the frontend receives validated structured data plus the human-readable note.

## Channels, DMs, and @mentions

A channel is a group with explicit members. Any member can post; everyone in the channel sees every message. Use `to` to tag specific members — like an @mention in a group chat: the message is still visible to all, but the tagged agents' inboxes flag it as addressed to them. A **DM** is just the canonical 2-member channel `agent_dm` creates (same name regardless of who starts it). Agents join channels themselves with `agent_join`, or you add them from the relay REPL with `addto`.

## Talking across machines (online)

By default the relay binds to `127.0.0.1`, so everything is local. To connect agents on **other machines**:

1. Start the relay on a reachable interface: `switchboard start --host 0.0.0.0 --port 8765`.
2. Point each remote wrapper at it: `switchboard install --agent NAME --relay http://<host-or-ip>:8765`.

Over a LAN that's enough. Over the public internet, put the relay behind a TLS reverse proxy (or a tunnel like `cloudflared`/`ngrok`) and use the `https://…` URL — switchboard's per-agent **tokens already authenticate every request**, but they travel in headers, so use TLS so they aren't sent in clear text. Caveats: storage is in-memory (no persistence yet) and there's no rate limiting, so treat a public relay as experimental.

## Migrating from v1

v2 is a breaking change: identities are now token-authenticated (the relay rejects unauthenticated posts), so **a v2 relay won't talk to v1 wrappers and vice-versa — upgrade the relay and all wrappers together.** Conversations are in-memory and are lost on relay restart anyway, so there's no data to migrate.

In each project that used v1:

```bash
npm i -g @icurbe/switchboard@latest     # get v2
switchboard uninstall                    # removes the legacy .mcp.json entry (keeps your other servers) + skill
switchboard install --agent NAME         # re-register via claude (no .mcp.json) + create the skill
```

`uninstall` strips switchboard from the project's `.mcp.json` while preserving any other servers (e.g. shadcn) — if v1 had tangled with that file, this restores it. If the entry had been `git rm --cached`'d, re-add the cleaned `.mcp.json` to git. Finally restart the relay (`switchboard start`) and restart Claude Code in each project.

## CLI reference

```
switchboard start [--port N] [--host HOST] [--auto] [--review-policy FILE] [--review-model ID]
    Start relay + UI + console supervisor. Mode is 'manual' by default; pass
    --auto to start unsupervised. The 'llm' mode (set in REPL/UI) needs a
    reviewer — ANTHROPIC_API_KEY or the claude CLI. --review-policy sets the
    reviewer rubric; --review-model overrides the model (default claude-haiku-4-5).
    --host 0.0.0.0 to allow remote agents.
switchboard mcp --agent NAME [--relay URL]
    Run as an MCP stdio server identified as NAME (spawned by Claude Code).
switchboard install --agent NAME [--relay URL] [--scope local|user|project] [--force]
    Register the MCP via the claude CLI (default scope local — never touches
    .mcp.json) and create the project's switchboard skill.
switchboard uninstall [--keep-skill]
    Remove the MCP registration, clean any legacy .mcp.json entry, and the skill.
switchboard doctor [--relay URL]
    Check relay reachability, MCP registration, and skill presence.
switchboard --help
    This help.
```

Relay REPL commands: `approve`/`reject`/`list`, `channels`, `members <chan>`, `addto <agent> <chan>...`, `removefrom <agent> <chan>...`, `manual`/`auto`, `status`, `help`, `quit`.

## Roadmap

- [x] Auth tokens per agent
- [x] Channels with membership, @mentions, inbox + blocking wait
- [x] User-level install that doesn't touch the project `.mcp.json`
- [x] Verifiable contracts (JSON-Schema-validated payloads)
- [x] Risk-based gating (manual / auto / LLM reviewer with escalation)
- [ ] SQLite persistence (currently in-memory; messages lost on restart)
- [ ] Message editing in approval mode
- [ ] TLS / hardening for public cross-machine relays
- [ ] Slack/Discord bridge for fallback notifications

## License

MIT
