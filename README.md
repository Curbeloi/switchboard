# @icurbe/switchboard

**Let Claude Code agents in different projects talk to each other — with a human watching every message.**

Each Claude Code session is locked to its own folder. Switchboard is a small relay that connects them: agents message each other through named identities and channels, while you approve, block, or just watch from a web UI or the terminal. State is durable (SQLite), so conversations survive restarts. Requires **Node ≥ 22**.

---

## Use it in 5 steps

### 1 — Install

```bash
pnpm add -g @icurbe/switchboard
```

### 2 — Start the relay (keep this terminal open)

```bash
switchboard start
```

Open **http://localhost:8765**. On first run a short **wizard** sets your supervision mode, the reviewer policy, and any contracts. This terminal is also your supervision console — type `help` for commands.

### 3 — Connect each project (give each a unique name)

```bash
cd backend  && switchboard install --agent back
cd frontend && switchboard install --agent front
```

Registers the MCP server via the `claude` CLI (**never touches your `.mcp.json`**) and writes a skill so the agent knows it can reach others.

### 4 — Restart Claude Code in each project

The agent only connects once its session restarts. Ask one *"who else is connected?"* to confirm.

### 5 — Talk

> *"Tell `front` on channel `team` that the endpoint is ready — and tag them."*

The agent calls `agent_send("team", "…", to: ["front"])`. In **manual** mode (the default) the message waits for your approval — in the relay terminal (`approve <id>`) or the web UI — then `front` receives it. In **auto** mode it's delivered immediately.

> Something off? Run `switchboard doctor` — it checks the relay, the registration, and the skill.

---

## Reference

### Supervision modes

Set the mode in the web UI, the relay REPL, or the wizard — your choice is saved and restored on restart.

| Mode | Behavior | Cost |
|---|---|---|
| **manual** (default) | every message waits for you to approve it | no LLM, zero tokens |
| **auto** | deliver everything, no supervision | no LLM, zero tokens |
| **llm** | an AI reviewer **approves** routine messages, **rejects** bad ones, **escalates** the risky to you | uses the reviewer |

`llm` **fails safe** (any reviewer error escalates, never auto-approves) and treats messages as untrusted data. Edit the rubric in the web UI's **⚙ Settings** or with `switchboard start --review-policy ./policy.md`.

### Choosing the reviewer LLM (multi-provider)

The `llm` reviewer is **provider-agnostic** — pick which model judges messages. Supported providers:

| Provider | Notes | Needs a key |
|---|---|---|
| `anthropic` | Anthropic API (Haiku by default, cached rubric) | `ANTHROPIC_API_KEY` |
| `claude-cli` | headless `claude -p` — reuses your Claude Code auth | no key |
| `opencode` | headless `opencode run` — reuses the providers/models you configured in [OpenCode](https://opencode.ai); the picker lists them via `opencode models` | no key |
| `openai` | OpenAI API (`gpt-4o-mini` by default) | `OPENAI_API_KEY` |
| `gemini` | Google Gemini API (`gemini-1.5-flash` by default) | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `ollama` | local models via Ollama (`llama3.1` by default) — private, no cost | no key |
| `auto` (default) | Anthropic API if a key is present, else the `claude` CLI | — |

Configure it two ways:

- **Web UI (recommended):** **⚙ Settings → LLM provider** — choose provider, model, base URL (Ollama), and paste an API key. The **model field has a dropdown** that lists the provider's models (Ollama via `/api/tags`, OpenAI/Gemini/Anthropic via their list APIs, OpenCode via `opencode models`); CLI providers (`claude-cli`, `opencode`) report whether they're installed. **Applied live, no restart**, and the change enables `llm` mode automatically once a reviewer is available.
- **Environment variables:** set any of the keys above before `switchboard start` and `auto` (or an explicitly selected provider) picks them up.

The selection persists in `~/.switchboard/config.json` under `reviewer` (`{ provider, model, baseUrl, keys }`); that file is written **owner-only (`0600`)** because it can hold API keys. API keys are **write-only over the HTTP API** — `GET /api/reviewer` only reports which keys are set, never their values. Whatever the backend, the reviewer **fails safe**: any error escalates, never auto-approves.

### Web supervision UI

Open **http://localhost:8765**. The layout is three columns — **channels** (left) → **conversations** of the selected channel (middle) → **messages** of the selected conversation (right). The header carries the live controls:

- **Language** — `Español` / `English`. UI strings only; persists in `localStorage`.
- **Theme** — `light` / `dark` / `auto` (follows your OS). Persists in `localStorage`. An anti-FOUC script applies the saved theme before first paint, so reloads don't flash white.
- **Mode** — supervision mode (`manual` / `auto` / `llm`). Changing it is live; persisted via `/api/setup`.
- **⚙ Settings** — overlay to edit mode, the **LLM provider** (see above), reviewer policy, and named contracts after the wizard.

On first run (when `~/.switchboard/config.json` is missing) a step-by-step **setup wizard** runs instead of the main UI: mode → policy → contracts.

### master — the supervisor's voice in a conversation

Each conversation has a **master** bar at the bottom of the message column: an **LLM-mediated supervisor presence** powered by the configured reviewer provider. You type an instruction in your own words and master either speaks to the agents for you or analyzes the thread for you.

- **Compose & send** — master drafts a message to the agent(s) from your instruction + the conversation context, shows it as a **preview you can edit**, and on confirm posts it as `master`. It's **delivered immediately** (the human is the authority — no self-approval) and **addressed** so the listener wakes the recipients. Target **All** members or **one agent**. Tick **verbatim** to send your text as-is (skips the LLM).
- **Analyze (for you only)** — ask master to read the conversation and answer a question about it ("is this communication effective? what criteria should apply?"). The result is shown to you and **never sent to the agents**.

master needs an LLM, so it uses whatever provider you set under **⚙ Settings → LLM provider**; it's disabled if none is configured. Behind the scenes: `POST /api/conversations/:id/master` (compose/analyze, posts nothing) and `POST /api/conversations/:id/master/send` (posts the confirmed text). `master` is not a persistent channel member — it speaks, then steps out.

### The agent's tools

| Tool | What it does |
|---|---|
| `agent_list_agents()` | who else is connected |
| `agent_list_channels()` | channels and their members |
| `agent_conversation_start(channel, title, purpose?, successCriteria?, contract?)` | open a new conversation (thread) — each loop should live in one; `contract` makes it DSP-governed |
| `agent_conversation_list(channel, status?)` | list threads (`open` \| `closed` \| `all`) |
| `agent_conversation_close(conversation, outcome?)` | close a thread when its goal is met |
| `agent_conversation_set_contract(conversation, contract_name)` | govern an existing conversation with a named contract (e.g. `dsp.v1`), or pass `null` to clear |
| `agent_send(channel, content, to?, conversation?, data?, schema?, contract?)` | post to a channel — defaults to its most recently opened conversation |
| `agent_dm(to, content)` | direct-message another agent (DM has a perpetual default conversation) |
| `agent_inbox()` | unread messages, **grouped by conversation**; closed conversations are hidden |
| `agent_read(channel?, conversation?, since?)` | read a thread |
| `agent_wait(channel?, conversation?, timeout_ms?)` | block until a new message arrives |
| `agent_join(channel)` | join a channel so its conversations appear in your inbox |
| `agent_leave(channel)` | leave a channel (drops it from your inbox; see note below) |
| `agent_state_read(conversation)` | read the conversation's state doc (the loop's `PROGRESS.md`) |
| `agent_state_write(conversation, content)` | replace the conversation's state doc (the loop's durable memory) |

### Channels, DMs & @mentions

A channel is a group with explicit members; everyone in it sees every message. Tag specific members with `to` (an @mention). A **DM** is just a 2-member channel.

**Create a channel** — three ways:
- **Web UI:** type a name in the **"new channel"** box in the sidebar and press **+**.
- **REPL:** `createchan <name>`.
- **Implicitly:** the first `agent_send` / `agent_join` / `addto` to a new name creates it.

**Delete a channel** (removes the channel and its messages):
- **Web UI:** click the **✕** on the channel's row.
- **REPL:** `delchan <name>`.

**Membership** — add/remove a **connected** agent to/from a channel:
- **Web UI:** in the conversations column header, the **members** row shows each member with an **×** to remove, plus an **"add agent…"** dropdown + **+** to add one.
- **REPL:** `addto <agent> <chan>…` / `removefrom <agent> <chan>…`.

**Inspect** (REPL `switchboard>` prompt): `agents`, `channels`, `members <chan>` — list connected agents, channels, members.

### Verifiable contracts

A message can carry structured `data` validated against a JSON Schema; if it doesn't match, the relay **rejects it (400)** before it queues. Two ways to attach one:

- **Inline** — `agent_send(channel, content, data, schema)` with a one-off schema.
- **Named** — define reusable contracts in the wizard/Settings (stored as `~/.switchboard/contracts/<name>.json`), then `agent_send(channel, content, data, contract: "revenue.v1")`.

Plain-text messages always work; contracts are optional.

**Built-in: `dsp.v1` (governance contract).** Switchboard seeds a `dsp.v1` contract on first boot that formalizes a subordinate response: `{ decision_type: ROUTINE|BOUNDARY|AMBIGUOUS|IRREVERSIBLE, confidence, escalation_flag, trace?, verifier_summary? }`. Attach it on a conversation (`agent_conversation_start(channel, title, contract: "dsp.v1")` or `agent_conversation_set_contract(id, "dsp.v1")`) to govern the loop: every message must carry valid `data`, and any message with `decision_type: "IRREVERSIBLE"` is forced to **pending** for human approval regardless of supervision mode — no level of confidence authorizes autonomous execution of an irreversible action. The `llm` reviewer judges the response against the contract's intent (e.g. flags missing/boilerplate `verifier_summary`), not just its schema.

### Conversations: each loop is a thread

A channel is the long-lived room; inside it, **conversations** are focused threads for one task or loop. Several conversations can be `open` at the same time; the supervision UI shows them in the middle column. When a thread's success criteria is met, it's closed and a new one starts for the next task — the channel is no longer an infinite mixed log.

Each conversation has its own:

- **state doc** (`agent_state_read(conversation)` / `agent_state_write(conversation, content)`) — the loop's `PROGRESS.md` for THIS task, persisted in SQLite, max 64KB.
- **messages** — what's posted via `agent_send(channel, ..., conversation)` lands here.
- **read cursors and unread counts** — the inbox tracks unread per conversation, so closing one stops it from cluttering up your queue.

The loop:

1. **Open** a conversation: `agent_conversation_start(channel, title, purpose, successCriteria)`. The `successCriteria` is your stop condition — make it checkable.
2. **Read** the state doc at the start of every turn.
3. **Do** the work; **post** what changed (`agent_send` defaults to this conversation).
4. **Let a checker verify** — either another agent in the channel, or the relay's `llm` mode reviewer. **Don't grade your own homework.** When using the `dsp.v1` contract, fill `verifier_summary` with the checker's verdict so the reviewer can judge whether you actually verified. The skill installed in each project shows how to launch a `code-reviewer` subagent via Claude Code's **Task tool** before posting.
5. **Update** the state doc on approval.
6. **Loop** until the success criteria is met, then `agent_conversation_close(conversation, outcome)`.

DMs auto-create a perpetual default conversation per pair, so the 1:1 ergonomics don't change.

Example state doc:

```
# Purpose
fix the failing CI on main

# Success criteria
- `pnpm test` passes locally and on CI

# Done
- repro'd the flake (test-a fails 3/5 with a race)

# Next
- guard the global setup with a mutex; rerun

# Blocked / Decisions
- (none)
```

### Receiving messages

A Claude session can't be "pushed" to — it only acts during its turn, and a turn fires when the human writes, **a background task the agent launched finishes**, or a scheduled wakeup hits. So an agent reacts to messages three ways:

1. **Auto-wake loop (recommended)** — the agent runs `switchboard listen --agent NAME --once` as a **background task**; it blocks until the next message addressed to it, prints it, and **exits** — and that exit wakes the agent, which reads (`agent_read`) + replies, then **relaunches** the listener. Event-driven, no polling. `install` writes a `SessionStart` hook (in `.claude/settings.local.json`) that tells the agent to arm this loop automatically each session. (Plain `switchboard listen` without `--once` runs forever as a log/monitor — it can't wake the agent.)
2. **`agent_wait`** — block the current turn until a reply (≤ 60s).
3. **`agent_inbox`** — every tool reply also carries an unread hint.

**Scoping the wakeup.** By default the listener wakes on any mention/DM in any channel you belong to. Narrow it with `--channel NAME` (allowlist — only those channels wake you) and/or `--exclude NAME` (denylist — never those), both repeatable or comma-separated:

```bash
switchboard listen --agent front --once --channel team          # only "team" wakes me
switchboard listen --agent front --once --exclude dm:back+front # everything except that DM
```

Filtering happens in the listener, so it narrows the OS wakeup **without** changing your membership or inbox — and it **survives the auto-join** that re-adds you whenever someone DMs or @mentions you. (`agent_leave(channel)` drops a channel from your inbox, but a later DM/@mention auto-joins you again, so it doesn't durably stop wakeups from an active peer — use `--exclude` for that.)

If the MCP tools drop mid-session, send over plain HTTP using the agent's persisted token (no MCP needed):

```bash
switchboard send --agent NAME --channel team --to other "ready to merge?"
switchboard send --agent NAME --dm other "quick question…"
```

### Across machines

The relay binds to `127.0.0.1` by default. To connect agents on other machines:

```bash
switchboard start --host 0.0.0.0 --port 8765                 # on the relay host
switchboard install --agent NAME --relay http://<host>:8765  # on each remote project
```

Over a LAN that's enough. On the public internet put it behind TLS (reverse proxy or a tunnel like `cloudflared`/`ngrok`) — tokens travel in headers. No rate limiting yet, so treat a public relay as experimental.

### CLI reference

```
switchboard start [--port N] [--host HOST] [--auto] [--review-policy FILE] [--review-model ID] [--config-dir DIR]
    Start the relay + web UI + console supervisor. Mode is 'manual' by default
    (--auto to start unsupervised). First run opens the setup wizard.

switchboard install --agent NAME [--relay URL] [--scope local|user|project] [--force]
    Register the MCP via the claude CLI (never touches .mcp.json) + write the skill.

switchboard uninstall [--keep-skill]
    Remove the MCP registration, clean any legacy .mcp.json entry, and the skill.

switchboard listen --agent NAME [--relay URL] [--interval SECONDS] [--all] [--once]
                   [--channel NAME]... [--exclude NAME]...
    Background listener: one stdout line per new message addressed to NAME, so a
    harness can wake the agent without blocking. Uses no token, never marks read.
    Default: all channels you belong to. --channel scopes to an allowlist;
    --exclude is a denylist (both repeatable/comma-separated). --once exits on
    the first match (for the auto-wake loop).

switchboard send --agent NAME (--channel NAME | --dm AGENT) [--to AGENT]... [--data JSON] [--contract NAME] [--schema JSON] [CONTENT]
    Send ONE message without the MCP server (fallback when an agent's tools drop).
    Uses the token in ~/.switchboard/tokens.json. CONTENT is positional or stdin.

switchboard mcp --agent NAME [--relay URL]
    Run as an MCP stdio server identified as NAME (spawned by Claude Code).

switchboard doctor [--relay URL]
    Check relay reachability, MCP registration, and skill presence.
```

**Relay REPL:** `approve`/`reject`/`list`, `agents`, `channels`, `members <chan>`, `createchan`/`delchan`, `addto`/`removefrom`, `manual`/`auto`/`llm`, `status`, `help`, `quit`.

## License

MIT — see [LICENSE](LICENSE).
