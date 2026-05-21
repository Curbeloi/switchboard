import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRelayClient } from "./client.js";
import { ensureSkill } from "../install.js";

const TOKEN_DIR = join(homedir(), ".switchboard");
const TOKEN_FILE = join(TOKEN_DIR, "tokens.json");

/** Persist per-(relay, agent) tokens so a session restart re-claims its own name
 *  instead of colliding with the still-registered identity on a live relay. */
function loadToken(key) {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"))[key] ?? null;
  } catch {
    return null;
  }
}
function saveToken(key, token) {
  let data = {};
  try {
    data = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    /* fresh file */
  }
  data[key] = token;
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  } catch {
    /* best-effort */
  }
}

const TOOLS = [
  {
    name: "agent_send",
    description:
      "Send a message to a named channel. You are auto-joined to the channel. Other members can read it. Use `to` to tag specific agents (like an @mention in a group chat): everyone in the channel sees the message, and the tagged agents are flagged that it's for them. The human supervisor sees it live; in approval mode the message stays pending until approved.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel name (e.g. 'team', 'bug-43'). Created on first use.",
        },
        content: {
          type: "string",
          description: "Plain-text message body. Keep it self-contained.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Optional: agent name(s) this message is addressed to within the channel (an @mention). They must be registered agents and are auto-joined to the channel.",
        },
        data: {
          type: "object",
          description: "Optional: a structured payload (a verifiable contract) alongside the prose, e.g. the exact shape/fields you're announcing. The receiver gets machine-checkable data, not just text.",
        },
        schema: {
          type: "object",
          description: "Optional: a JSON Schema that `data` must satisfy. The relay validates `data` against it on send and rejects the message if it doesn't conform — so the contract is verified, not just asserted.",
        },
      },
      required: ["channel", "content"],
    },
  },
  {
    name: "agent_dm",
    description:
      "Send a direct message to another agent by name. Routes through a canonical 2-member channel (same name regardless of who starts it); both agents are auto-joined.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Name of the recipient agent (e.g. 'front')." },
        content: { type: "string", description: "Plain-text message body." },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "agent_read",
    description:
      "Read messages from a channel posted after a timestamp (epoch ms; 0 = all history). Marks the channel read for you (read receipt), clearing it from your inbox. Returns messages with { id, from, content, createdAt }.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to read from." },
        since: {
          type: "number",
          description: "Epoch ms cutoff. Pass the last createdAt you saw to poll; 0 for all history.",
          default: 0,
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "agent_inbox",
    description:
      "Show your unread messages grouped by channel (channels you belong to, messages from others you haven't read). Use this to discover what needs a reply.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_wait",
    description:
      "Block until a new message arrives for you (long-poll), then return it. Use this to actively wait for a reply instead of polling. Returns immediately if there are already unread messages in the channel. Times out with an empty result after timeout_ms.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel to wait on. Omit to wait across all channels you belong to. You are auto-joined to the named channel.",
        },
        timeout_ms: {
          type: "number",
          description: "How long to block before giving up (1000–60000, default 25000).",
          default: 25000,
        },
      },
    },
  },
  {
    name: "agent_join",
    description:
      "Join a channel so its messages appear in your inbox and you can wait on it. Creates the channel if it doesn't exist.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel name to join." } },
      required: ["channel"],
    },
  },
  {
    name: "agent_list_channels",
    description:
      "List every channel with its members and message count. Useful for discovery.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_list_agents",
    description:
      "List the agents currently registered on the relay (the other Claude sessions you can talk to), with when each was last seen. Use this to discover who is online before sending or DMing.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function runMcp({ agent, relayUrl }) {
  const client = createRelayClient(relayUrl);
  const tokenKey = `${relayUrl}::${agent}`;
  let token = loadToken(tokenKey);

  async function ensureRegistered() {
    const res = await client.registerAgent(agent, token);
    token = res.token;
    client.setToken(token);
    saveToken(tokenKey, token);
  }

  /* Pre-flight: relay must be reachable. */
  try {
    await client.health();
  } catch (err) {
    process.stderr.write(`switchboard mcp: cannot reach relay at ${relayUrl} (${err.message})\n`);
    process.exit(1);
  }

  /* Register this agent; a 409 means the name is taken by another live session. */
  try {
    await ensureRegistered();
  } catch (err) {
    if (err.status === 409) {
      process.stderr.write(
        `switchboard mcp: agent name "${agent}" is already taken by another session — pick a different --agent name\n`
      );
    } else {
      process.stderr.write(`switchboard mcp: registration failed (${err.message})\n`);
    }
    process.exit(1);
  }

  /* Ensure this project has the switchboard skill (idempotent; created if missing). */
  try {
    await ensureSkill({ agent, relay: relayUrl });
  } catch {
    /* best-effort — never block startup on skill creation */
  }

  /** Run a relay call; if the token was rejected (relay restarted), re-register once and retry. */
  async function call(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) {
        await ensureRegistered();
        return await fn();
      }
      throw err;
    }
  }

  /** Wrap a text result, appending an unread hint so any tool call nudges the agent to read. */
  async function reply(text, { hint = true } = {}) {
    let suffix = "";
    if (hint) {
      try {
        const ib = await client.inbox();
        if (ib.total > 0) {
          suffix = `\n\n(inbox: ${ib.total} unread in ${ib.channels.length} channel(s) — use agent_inbox / agent_read)`;
        }
      } catch {
        /* hint is best-effort */
      }
    }
    return { content: [{ type: "text", text: text + suffix }] };
  }

  function fmtMessages(messages) {
    return messages
      .map((m) => {
        const tag = Array.isArray(m.to) && m.to.length ? ` @${m.to.join(" @")}` : "";
        const mine = Array.isArray(m.to) && m.to.includes(agent) ? " (for you)" : "";
        const data = m.data != null ? `\n  data: ${JSON.stringify(m.data)}` : "";
        return `[${new Date(m.createdAt).toISOString()}] ${m.from}${tag}${mine}: ${m.content}${data}`;
      })
      .join("\n");
  }

  const server = new Server(
    { name: "@icurbe/switchboard", version: "2.2.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "agent_send": {
          const { channel, content, to, data, schema } = args;
          const toList = Array.isArray(to) ? to : to ? [to] : [];
          const msg = await call(() =>
            client.postMessage({ channel, content, to: toList, data, schema })
          );
          const tag = toList.length ? ` (to: ${toList.join(", ")})` : "";
          const contract = schema ? " [contract validated]" : "";
          return reply(
            `posted message ${msg.id} to channel "${channel}" as "${agent}"${tag}${contract} (status: ${msg.status})`
          );
        }
        case "agent_dm": {
          const { to, content } = args;
          const msg = await call(() => client.dm({ to, content }));
          return reply(
            `DM ${msg.id} sent to "${to}" via channel "${msg.channel}" (status: ${msg.status})`
          );
        }
        case "agent_read": {
          const { channel, since = 0 } = args;
          const messages = await call(() => client.readMessages({ channel, since }));
          if (messages.length === 0) {
            return reply(`no messages in "${channel}" since ${since}`);
          }
          return reply(fmtMessages(messages));
        }
        case "agent_inbox": {
          const ib = await call(() => client.inbox());
          if (ib.total === 0) return reply("inbox empty — no unread messages", { hint: false });
          const lines = ib.channels.map((c) => {
            const m = c.mentioned ? `, ${c.mentioned} for you` : "";
            return `  ${c.channel}: ${c.unread} unread${m} (last from ${c.lastFrom}: ${c.lastPreview})`;
          });
          const header = ib.mentioned
            ? `${ib.total} unread (${ib.mentioned} addressed to you):`
            : `${ib.total} unread:`;
          return reply(`${header}\n${lines.join("\n")}`, { hint: false });
        }
        case "agent_wait": {
          const { channel = null, timeout_ms = 25000 } = args;
          const messages = await call(() => client.wait({ channel, timeoutMs: timeout_ms }));
          if (messages.length === 0) {
            return reply(
              `no new messages${channel ? ` in "${channel}"` : ""} within ${Math.round(timeout_ms / 1000)}s`
            );
          }
          return reply(fmtMessages(messages));
        }
        case "agent_join": {
          const { channel } = args;
          const result = await call(() => client.joinChannel(channel));
          return reply(`joined "${channel}" (members: ${result.members.join(", ")})`);
        }
        case "agent_list_channels": {
          const channels = await call(() => client.listChannels());
          if (channels.length === 0) return reply("no channels yet", { hint: false });
          const lines = channels.map(
            (c) => `  ${c.name} — ${c.messageCount} messages, members: ${c.members.join(", ") || "(none)"}`
          );
          return reply(lines.join("\n"), { hint: false });
        }
        case "agent_list_agents": {
          const list = await call(() => client.listAgents());
          const others = list.filter((a) => a.name !== agent);
          if (others.length === 0) {
            return reply("no other agents are registered right now", { hint: false });
          }
          const lines = others.map(
            (a) => `  ${a.name} (last seen ${new Date(a.lastSeenAt).toISOString()})`
          );
          return reply(`agents you can talk to:\n${lines.join("\n")}`, { hint: false });
        }
        default:
          return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `switchboard error: ${err.message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  /* stays alive on stdio until the parent closes */
}
