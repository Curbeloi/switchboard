# @icurbe/switchboard

Supervised inter-agent messaging relay for [Claude Code](https://claude.com/claude-code) (or any MCP client). Two agents in different projects can exchange messages through named identities, while a human supervisor reads, intercepts, or approves every exchange — from the terminal (a console REPL) or an optional web UI.

> Status: **alpha / v0.1** — base scaffold. APIs may change.

## Why this exists

Each Claude Code session is isolated to its working directory. If you have one Claude running in `cognidata-backend` and another in `cognidata-frontend`, they cannot talk to each other natively. Workarounds (Slack MCP, copy-paste, shared files) lack supervised flow control — the human can't pause, edit, or approve a message mid-flight.

Switchboard fills the gap with three primitives:

1. **Named agents.** Each Claude session registers as `back`, `front`, `qa`, etc.
2. **Channels.** Messages are posted to named channels (e.g. `hector-team`, `bug-43`).
3. **Supervision.** Every message is held for human approval **by default** (manual mode). You approve or reject from the relay's terminal (a built-in console REPL) or from the optional web UI — both share the same live state. Flip to `auto` to let messages flow without supervision.

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

Each Claude Code session spawns its own MCP wrapper (a stdio MCP server) that translates `agent_send` / `agent_read` / `agent_list_channels` tool calls into HTTP requests against the relay. The relay holds the shared store, fans out live events over WebSocket to the web UI, and drives the console supervisor on its own terminal.

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

### 3. Wire each Claude Code session via MCP

From inside each project, let the CLI write the `.mcp.json` block for you:

```bash
cd cognidata-backend  && switchboard install --agent back
cd cognidata-frontend && switchboard install --agent front
```

`install` creates `.mcp.json` if missing or merges the `switchboard` entry into an existing one (it won't clobber other MCP servers). Prefer to do it by hand? Drop this into the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "switchboard": {
      "command": "switchboard",
      "args": ["mcp", "--agent", "back", "--relay", "http://127.0.0.1:8765"]
    }
  }
}
```

Restart each Claude Code session. They now expose three MCP tools:

- `agent_send(channel, content)` — post a message to a channel.
- `agent_read(channel, since?)` — pull messages from a channel since a timestamp.
- `agent_list_channels()` — list channels that have at least one message.

### 4. Verify (optional)

```bash
switchboard doctor
```

Checks that the relay is reachable and that the current project's `.mcp.json` is wired up. Exits non-zero if something's off.

### 5. Talk

From the backend agent's chat:

> "Send a message to channel `hector-team` saying that the new `revenue_per_day` endpoint is ready and lists the new field names."

In the default manual mode the message is held as `pending` — it does **not** reach the channel until you `approve` it in the relay terminal (or the web UI). Once approved, the frontend agent reads it with `agent_read` (or you watch it in the UI). In `auto` mode it's delivered immediately.

## Manual-approval mode

Manual mode is **on by default**. Every message an agent sends queues with status `pending` until you approve it — either from the terminal where the relay is running (typing `approve <id>` / `reject <id>` / `list`) or by clicking in the web UI. The relay's stdout doubles as a small REPL; type `help` for the full command list.

To run without supervision, start the relay with `--auto`, or type `auto` in the REPL (and `manual` to switch back). The web-UI toggle and the REPL share the same state.

## CLI reference

```
switchboard start [--port N] [--host HOST] [--auto]
    Start relay + UI + console supervisor. Manual approval is on by default;
    pass --auto to start without supervision.
switchboard mcp --agent NAME [--relay URL]
    Run as an MCP stdio server. Used per project via .mcp.json.
switchboard install --agent NAME [--relay URL] [--force] [--print]
    Add the switchboard MCP block to .mcp.json in the current directory.
switchboard uninstall
    Remove the switchboard MCP block from .mcp.json.
switchboard doctor [--relay URL]
    Check that the relay is reachable and .mcp.json is configured.
switchboard --help
    This help.
```

## Roadmap

- [ ] SQLite persistence (currently in-memory; messages lost on restart)
- [ ] Auth tokens per agent
- [ ] Message editing in approval mode
- [ ] Multi-relay federation (cross-machine)
- [ ] Slack/Discord bridge for fallback notifications

## License

MIT
