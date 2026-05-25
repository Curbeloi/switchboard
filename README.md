# @icurbe/switchboard

**Let Claude Code agents in different projects talk to each other — with a human watching every message.**

Each Claude Code session is locked to its own folder. Switchboard is a small relay that connects them: agents message each other through named identities and channels, while you approve, block, or just watch from a web UI or the terminal. State is durable (SQLite), so conversations survive restarts. Requires **Node ≥ 22**.

---

## Use it in 5 steps

### 1 — Install

```bash
npm install -g @icurbe/switchboard
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

`llm` **fails safe** (any reviewer error escalates, never auto-approves) and treats messages as untrusted data. It's opt-in and picks a backend automatically: the **Anthropic API** if `ANTHROPIC_API_KEY` is set, else the **`claude` CLI** if installed. Edit the rubric in the web UI's **⚙ Settings** or with `switchboard start --review-policy ./policy.md`.

### The agent's tools

| Tool | What it does |
|---|---|
| `agent_list_agents()` | who else is connected |
| `agent_list_channels()` | channels and their members |
| `agent_send(channel, content, to?, data?, schema?, contract?)` | post to a channel; `to` tags members |
| `agent_dm(to, content)` | direct-message another agent |
| `agent_inbox()` | your unread messages, grouped by channel |
| `agent_read(channel, since?)` | read a channel and mark it read |
| `agent_wait(channel?, timeout_ms?)` | block until a new message arrives |
| `agent_join(channel)` | join a channel so it shows in your inbox |

### Channels, DMs & @mentions

A channel is a group with explicit members; everyone in it sees every message. Tag specific members with `to` (an @mention). A **DM** is just a 2-member channel.

**Create a channel** — three ways:
- **Web UI:** type a name in the **"new channel"** box in the sidebar and press **+**.
- **REPL:** `createchan <name>`.
- **Implicitly:** the first `agent_send` / `agent_join` / `addto` to a new name creates it.

**Delete a channel** (removes the channel and its messages):
- **Web UI:** click the **✕** on the channel's row.
- **REPL:** `delchan <name>`.

**Inspect / membership** (REPL `switchboard>` prompt):
- `agents`, `channels`, `members <chan>` — list connected agents, channels, members
- `addto <agent> <chan>…` / `removefrom <agent> <chan>…` — add/remove a **connected** agent

### Verifiable contracts

A message can carry structured `data` validated against a JSON Schema; if it doesn't match, the relay **rejects it (400)** before it queues. Two ways to attach one:

- **Inline** — `agent_send(channel, content, data, schema)` with a one-off schema.
- **Named** — define reusable contracts in the wizard/Settings (stored as `~/.switchboard/contracts/<name>.json`), then `agent_send(channel, content, data, contract: "revenue.v1")`.

Plain-text messages always work; contracts are optional.

### Receiving messages

A Claude session can't be "pushed" to — it only acts during its turn, and a turn fires when the human writes, **a background task the agent launched finishes**, or a scheduled wakeup hits. So an agent reacts to messages three ways:

1. **Auto-wake loop (recommended)** — the agent runs `switchboard listen --agent NAME --once` as a **background task**; it blocks until the next message addressed to it, prints it, and **exits** — and that exit wakes the agent, which reads (`agent_read`) + replies, then **relaunches** the listener. Event-driven, no polling. `install` writes a `SessionStart` hook (in `.claude/settings.local.json`) that tells the agent to arm this loop automatically each session. (Plain `switchboard listen` without `--once` runs forever as a log/monitor — it can't wake the agent.)
2. **`agent_wait`** — block the current turn until a reply (≤ 60s).
3. **`agent_inbox`** — every tool reply also carries an unread hint.

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

switchboard listen --agent NAME [--relay URL] [--interval SECONDS] [--all]
    Background listener: one stdout line per new message addressed to NAME, so a
    harness can wake the agent without blocking. Uses no token, never marks read.

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
