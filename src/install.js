import { readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const DEFAULT_RELAY = "http://127.0.0.1:8765";
const REPO = "https://github.com/Curbeloi/switchboard";
const SKILL_REL = join(".claude", "skills", "switchboard");

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

## Notes

- There are no push notifications. After sending and expecting a reply, either \`agent_wait\` or check \`agent_inbox\` on your next step.
- Agent names are unique. Your name ("${agent}") is fixed for this project.
- The human monitor (${relay}) shows every channel and holds pending messages for approval.
`;
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

  process.stdout.write(
    `registered switchboard MCP via claude (scope: ${scope}, agent: ${agent}, relay: ${relay})\n`
  );
  process.stdout.write(`  no project .mcp.json was touched.\n`);
  process.stdout.write(
    skill.created ? `created skill ${skill.file}\n` : `skill already present (${skill.file})\n`
  );
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
