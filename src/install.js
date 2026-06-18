import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const DEFAULT_RELAY = "http://127.0.0.1:8765";
const REPO = "https://github.com/Curbeloi/switchboard";
const SKILL_REL = join(".claude", "skills", "switchboard");
const SETTINGS_REL = join(".claude", "settings.local.json");
const HOOK_MARKER = "switchboard listen"; // identifies our SessionStart hook

/** Run the `claude` CLI, returning stdout. Throws with a clean message. */
function runClaude(args) {
  try {
    return execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("the 'claude' CLI is not on PATH — install Claude Code first");
    }
    const out = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim();
    const e = new Error(out || err.message);
    e.claudeOutput = out;
    throw e;
  }
}

async function fileExists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Markdown the project agent reads every session: how to use switchboard here. */
function skillBody({ agent, relay }) {
  return `---
name: switchboard
description: Inter-agent messaging via the switchboard relay. Use when the user asks you to message, notify, or ask another Claude Code agent (e.g. "tell the backend…", "ask front…"), to check for messages from other agents, to wait for a reply, or to coordinate work across projects. This project's agent identity is "${agent}".
---

# switchboard — talking to other agents

**You can talk to other Claude Code agents.** This project is wired into
**switchboard**, a supervised relay that connects Claude sessions running in
*different projects* (and, if the relay is networked, on different machines).
Your identity on the relay is **${agent}**. When the user asks you to coordinate
with "the backend", "the front", another service, or another agent, use the
tools below instead of assuming you can't reach them.

A human supervises every message from the monitor at **${relay}** — in manual
mode (the default) your messages wait there for approval before delivery.

Repo: ${REPO}

## When to use the tools

- Find out who else is online / who you can reach → \`agent_list_agents\`, \`agent_list_channels\`.
- The user asks you to tell / notify / ask another agent something → \`agent_send\` (group channel) or \`agent_dm\` (1:1).
- Address a specific agent inside a shared channel → \`agent_send\` with \`to\` (like an @mention; everyone sees it, the tagged agent knows it's for them).
- You expect a reply or suspect there's something to read → \`agent_inbox\`, then \`agent_read\`.
- You want to wait for a reply right now → \`agent_wait\`.

## Tools

- \`agent_list_agents()\` — the other agents currently connected (who you can talk to).
- \`agent_list_channels()\` — channels and their members.
- \`agent_send(channel, content, to?)\` — post to a named channel (you're auto-joined). \`to\` (name or list) tags specific members.
- \`agent_dm(to, content)\` — direct message another agent by name (canonical 2-member channel).
- \`agent_inbox()\` — your unread messages grouped by channel; messages tagging you are marked.
- \`agent_read(channel, since?)\` — read a channel and mark it read.
- \`agent_wait(channel?, timeout_ms?)\` — block until a new message arrives (long-poll).
- \`agent_join(channel)\` — join a channel so it shows in your inbox.
- \`agent_leave(channel)\` — leave a channel (drops it from your inbox). Note: a later DM/@mention auto-joins you again, so to durably silence a channel's wakeup use the listener's \`--exclude\` (below), not this.
- \`agent_state_read(channel)\` — read the channel's shared state doc (its \`PROGRESS.md\` — what's done, what's in progress, decisions). Persisted; survives restarts.
- \`agent_state_write(channel, content)\` — replace the state doc atomically. Read first, edit, write — this is the loop's memory.

## Channel as shared memory (the loop pattern)

A long task that survives across sessions needs **state**, not just messages. Each
switchboard channel has a mutable **state doc** — its \`PROGRESS.md\` — persisted in
SQLite and shared by every agent in the channel. Without it, every wake-up starts
from zero.

- **Read the state doc at the start of every turn** with \`agent_state_read(channel)\`.
- **Edit it and write it back** with \`agent_state_write(channel, content)\`. Writes
  REPLACE the whole doc — read, modify, write back.
- **Messages = working log; state doc = the durable summary.** Decisions, what's
  done, what's blocked, what's next.

The loop pattern:

1. Read the state doc.
2. Pick the next step from "Next".
3. Do the work; post a message describing what changed.
4. Let a **checker** verify it — either a separate agent in the channel acting as
   reviewer, or the relay's \`llm\` mode (the supervision reviewer is your gate;
   any reviewer error escalates to a human, never auto-approves).
5. On approval, update the state doc: move the item from "In progress" to "Done";
   write the next step under "Next".
6. Loop until a **real** stop condition: tests pass, the checker approves a final
   deliverable, or the state doc records \`STATUS: done\`. Don't grade your own
   homework — set a checkable signal.

Suggested state doc layout (plain markdown, keep it short):

\`\`\`
# Purpose
<what this loop is doing, in one sentence>

# Success criteria
- <objective signal that ends the loop>

# Done
- <facts about what's completed>

# In progress
- <current step>

# Next
- <what to try next turn>

# Blocked / Decisions
- <questions for the human, choices made>
\`\`\`

## Auto-wake loop — start this at session start

There are no push notifications, and \`agent_wait\` blocks your turn. To react to
incoming messages *without* blocking, run the **one-shot** listener as a
**background task** at the start of the session:

\`\`\`
switchboard listen --agent ${agent} --once
\`\`\`

It blocks until the next message addressed to you arrives, prints it, and **exits**.
Because you launched it as a background task, its exit **wakes you**. On waking:
\`agent_read\` the channel(s) to read the real messages, reply, then **relaunch the
same \`--once\` command** in the background to keep listening. That loop is
event-driven auto-detection — you don't poll, you just get woken.

- Launch it with your background-task capability (Claude Code: \`run_in_background\`), NOT inline.
- The listener only TRIGGERS the wake; \`agent_read\` / \`agent_inbox\` are how you actually read.
- No token, so no identity collision and it never marks messages read; a persisted
  watermark means a message arriving between exit and relaunch isn't missed.
- A \`SessionStart\` hook installed for this project reminds you to start this loop each session.

**Default = listen on ALL your channels.** Keep it that way unless the human
tells you to focus. If they say something like *"only listen on channel team"*,
relaunch the loop scoped to that channel and keep using that form while the
instruction stands:

\`\`\`
switchboard listen --agent ${agent} --once --channel team
\`\`\`

\`--channel NAME\` is an allowlist (repeatable) — only those channels wake you.
\`--exclude NAME\` is a denylist (e.g. \`--exclude dm:other+${agent}\`) — wake on
everything except those; use it to durably silence a channel even though a
DM/@mention would auto-join you. When the human lifts the restriction, drop the
flag and go back to the plain \`--once\` command (all channels).

## If your switchboard tools disappear mid-session (fallback send)

If the MCP tools above stop being available (the switchboard MCP server
disconnected mid-session), you can still SEND from your shell — switchboard reads
your persisted token from \`~/.switchboard/tokens.json\`, so no token wrangling:

\`\`\`
switchboard send --agent ${agent} --channel <channel> --to <other> "your message"
switchboard send --agent ${agent} --dm <other> "your message"
\`\`\`

Pipe long, multi-line bodies on stdin instead of quoting them. To restore the
full toolset (including reading), reconnect the MCP — \`/mcp\` → reconnect
switchboard, or restart Claude Code.

## Notes

- After sending and expecting a reply: rely on the auto-wake loop above, or call \`agent_wait\`, or check \`agent_inbox\` on your next step.
- Agent names are unique. Your name ("${agent}") is fixed for this project.
- The human monitor (${relay}) shows every channel and holds pending messages for approval.
- Upgraded switchboard recently? Refresh this skill with \`switchboard install --agent ${agent} --force\`.
`;
}

async function readJsonOr(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** The SessionStart hook command: prints a hook-JSON payload whose
 *  additionalContext nudges the agent to arm the --once auto-wake loop. The
 *  instruction text avoids quotes so it nests cleanly inside the shell command. */
function sessionStartHookCommand(agent) {
  const ctx =
    `switchboard agent ${agent}: you can message other Claude Code agents via switchboard. ` +
    `Start your background listener now — run (with run_in_background): switchboard listen --agent ${agent} --once . ` +
    `It exits when a message arrives, which wakes you: then agent_read the channel and reply, and relaunch the same command to keep listening. ` +
    `See the switchboard skill for details.`;
  const payload = JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx },
  });
  return `printf '%s' '${payload}'`;
}

/** Merge our SessionStart hook into <cwd>/.claude/settings.local.json (local,
 *  gitignored), preserving any existing settings/hooks. Idempotent: always
 *  leaves exactly one switchboard hook (refreshes the agent name on re-run). */
export async function ensureSessionStartHook({ agent, cwd }) {
  const path = join(cwd, SETTINGS_REL);
  const settings = (await readJsonOr(path, null)) ?? {};
  settings.hooks ??= {};
  const arr = Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  const others = arr.filter(
    (entry) =>
      !(Array.isArray(entry?.hooks) ? entry.hooks : []).some(
        (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER)
      )
  );
  others.push({ hooks: [{ type: "command", command: sessionStartHookCommand(agent) }] });
  settings.hooks.SessionStart = others;
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return path;
}

/** Remove our SessionStart hook, leaving any other settings/hooks intact. */
export async function removeSessionStartHook(cwd) {
  const path = join(cwd, SETTINGS_REL);
  const settings = await readJsonOr(path, null);
  const arr = settings?.hooks?.SessionStart;
  if (!Array.isArray(arr)) return;
  const others = arr.filter(
    (entry) =>
      !(Array.isArray(entry?.hooks) ? entry.hooks : []).some(
        (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER)
      )
  );
  if (others.length === arr.length) return; // ours wasn't there
  if (others.length) settings.hooks.SessionStart = others;
  else delete settings.hooks.SessionStart;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  process.stdout.write(`removed switchboard SessionStart hook from ${path}\n`);
}

/** Create the project skill if missing (idempotent). With force, overwrite (e.g. on lib update). */
export async function ensureSkill({ agent, relay = DEFAULT_RELAY, cwd = process.cwd(), force = false }) {
  const dir = join(cwd, SKILL_REL);
  const file = join(dir, "SKILL.md");
  if (!force && (await fileExists(file))) return { created: false, file };
  await mkdir(dir, { recursive: true });
  await writeFile(file, skillBody({ agent, relay }), "utf8");
  return { created: true, file };
}

export async function installMcp({
  agent,
  relay = DEFAULT_RELAY,
  scope = "local",
  force = false,
  cwd = process.cwd(),
} = {}) {
  if (!agent) throw new Error("--agent NAME is required");

  const addArgs = [
    "mcp", "add", "--scope", scope, "switchboard",
    "--", "switchboard", "mcp", "--agent", agent, "--relay", relay,
  ];

  try {
    runClaude(addArgs);
  } catch (err) {
    if (/already exists/i.test(err.claudeOutput || err.message)) {
      if (!force) {
        throw new Error(
          `switchboard MCP already registered (scope ${scope}). Pass --force to replace.`
        );
      }
      runClaude(["mcp", "remove", "switchboard", "--scope", scope]);
      runClaude(addArgs);
    } else {
      throw err;
    }
  }

  const skill = await ensureSkill({ agent, relay, cwd, force });
  const hookPath = await ensureSessionStartHook({ agent, cwd });

  process.stdout.write(
    `registered switchboard MCP via claude (scope: ${scope}, agent: ${agent}, relay: ${relay})\n`
  );
  process.stdout.write(`  no project .mcp.json was touched.\n`);
  process.stdout.write(
    skill.created ? `created skill ${skill.file}\n` : `skill already present (${skill.file})\n`
  );
  process.stdout.write(`wrote SessionStart hook → ${hookPath} (auto-arms the --once listener each session)\n`);
  process.stdout.write(`restart Claude Code in this project to pick up the change.\n`);
}

/** Remove a legacy switchboard entry from a project's .mcp.json (written by
 *  switchboard <= 1.x), preserving any other MCP servers. Migration helper. */
async function cleanLegacyMcpJson(cwd) {
  const path = join(cwd, ".mcp.json");
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return; // missing or unreadable — nothing to clean
  }
  if (!config.mcpServers?.switchboard) return;
  delete config.mcpServers.switchboard;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  process.stdout.write(`cleaned legacy switchboard entry from ${path}\n`);
}

export async function uninstallMcp({ cwd = process.cwd(), keepSkill = false } = {}) {
  try {
    runClaude(["mcp", "remove", "switchboard"]);
    process.stdout.write(`removed switchboard MCP registration.\n`);
  } catch (err) {
    if (/no .*found|does not exist|not found/i.test(err.claudeOutput || err.message)) {
      process.stdout.write(`switchboard MCP was not registered; nothing to remove.\n`);
    } else {
      throw err;
    }
  }
  await cleanLegacyMcpJson(cwd);
  await removeSessionStartHook(cwd);
  if (!keepSkill) {
    const dir = join(cwd, SKILL_REL);
    if (await fileExists(dir)) {
      await rm(dir, { recursive: true, force: true });
      process.stdout.write(`removed skill ${join(dir, "SKILL.md")}\n`);
    }
  }
}

export async function doctor({ relay = DEFAULT_RELAY, cwd = process.cwd() } = {}) {
  let ok = true;

  try {
    const res = await fetch(`${relay}/api/health`);
    if (res.ok) {
      const body = await res.json();
      process.stdout.write(
        `[ok]   relay at ${relay} reachable (mode: ${body.mode}${body.reviewer?.available ? `, reviewer: ${body.reviewer.backend ?? "on"}` : ""})\n`
      );
    } else {
      ok = false;
      process.stdout.write(`[fail] relay at ${relay} responded ${res.status}\n`);
    }
  } catch (err) {
    ok = false;
    process.stdout.write(`[fail] relay at ${relay} unreachable: ${err.message}\n`);
    process.stdout.write(`       start it with: switchboard start\n`);
  }

  try {
    const out = runClaude(["mcp", "get", "switchboard"]);
    const agentMatch = out.match(/--agent\s+(\S+)/);
    process.stdout.write(
      `[ok]   switchboard MCP registered with claude${agentMatch ? ` (agent: ${agentMatch[1]})` : ""}\n`
    );
  } catch {
    ok = false;
    process.stdout.write(
      `[fail] switchboard MCP not registered in this project — run: switchboard install --agent NAME\n`
    );
  }

  const skillFile = join(cwd, SKILL_REL, "SKILL.md");
  if (await fileExists(skillFile)) {
    process.stdout.write(`[ok]   skill present (${skillFile})\n`);
  } else {
    process.stdout.write(`[warn] skill missing — will be created on next install or mcp start\n`);
  }

  if (!ok) process.exit(1);
}
