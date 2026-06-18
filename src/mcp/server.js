import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRelayClient } from "./client.js";
import { ensureSkill } from "../install.js";
import { loadToken, saveToken, tokenKey } from "../tokens.js";

const TOOLS = [
  {
    name: "agent_send",
    description:
      "Send a message to a channel. By default the message goes to the most recently opened conversation in that channel; pass `conversation` to target a specific thread. For channels with no open conversation, open one first with agent_conversation_start (DMs auto-create a default). Use `to` to @mention specific agents (everyone in the channel sees it; tagged agents are flagged it's for them).",
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
        conversation: {
          type: "string",
          description: "Optional: conversation (thread) id within the channel. Default: most recently opened conversation in that channel.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Optional: agent name(s) this message is addressed to (an @mention). They must be registered agents.",
        },
        data: {
          type: "object",
          description: "Optional: structured payload alongside the prose, validated by `schema` or `contract` if provided.",
        },
        schema: {
          type: "object",
          description: "Optional: a JSON Schema that `data` must satisfy. The relay validates and rejects mismatches before queueing.",
        },
        contract: {
          type: "string",
          description: "Optional: the name of a predefined contract (a JSON Schema saved on the relay). Use this instead of `schema` to reuse an agreed contract by name.",
        },
      },
      required: ["channel", "content"],
    },
  },
  {
    name: "agent_dm",
    description:
      "Send a direct message to another agent by name. Routes through a canonical 2-member channel `dm:<sorted+names>` whose default conversation is auto-created on first DM and lives forever. Both agents are auto-joined.",
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
      "Read messages from a conversation posted after a timestamp. Pass either `conversation` (direct), or `channel` (resolves to the most recently opened conversation of that channel — errors if none). Marks the conversation read for you (read receipt). Returns messages with `{ id, conversationId, from, content, createdAt }`.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name — resolves to its most recent open conversation." },
        conversation: { type: "string", description: "Conversation id (preferred when known)." },
        since: {
          type: "number",
          description: "Epoch ms cutoff. Pass the last createdAt you saw to poll; 0 for all history.",
          default: 0,
        },
      },
    },
  },
  {
    name: "agent_inbox",
    description:
      "Show your unread messages grouped by **conversation** (channels you belong to → their open conversations with unread). Closed conversations don't appear. Use this to discover what needs a reply.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_wait",
    description:
      "Block until a new message arrives for you (long-poll), then return it. Returns immediately if you already have unread for the named conversation. Times out empty after timeout_ms. Scope: pass `conversation` for a specific thread; pass `channel` to watch all conversations of a channel; omit both to watch everything you belong to.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel to watch. You are auto-joined." },
        conversation: { type: "string", description: "Conversation id to watch (preferred)." },
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
      "Join a channel so its conversations' messages appear in your inbox and you can wait on them. Creates the channel if it doesn't exist.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel name to join." } },
      required: ["channel"],
    },
  },
  {
    name: "agent_leave",
    description:
      "Leave a channel: stop its conversations from appearing in your inbox and from waking your listener. Note: a later DM/@mention auto-joins you again. To durably silence a channel's wakeup use the background listener's `--exclude` flag instead.",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string", description: "Channel name to leave." } },
      required: ["channel"],
    },
  },
  {
    name: "agent_conversation_start",
    description:
      "Open a new conversation (thread) inside a channel for a focused task. Each loop should live in its own conversation: it gets its own message stream, state doc (PROGRESS.md), and unread cursor. Returns `{ id, channel, title, status: 'open' }`. Pass `purpose` and `successCriteria` so the team knows what 'done' means.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel that owns the conversation." },
        title: { type: "string", description: "Short topic of the conversation (e.g. 'fix flaky-test-a')." },
        purpose: { type: "string", description: "What this conversation is doing, in one sentence." },
        successCriteria: { type: "string", description: "Objective signal that means 'close this loop'. Should be checkable." },
      },
      required: ["channel", "title"],
    },
  },
  {
    name: "agent_conversation_list",
    description:
      "List conversations in a channel. Filter by status (`open` | `closed` | `all`). Returns `[{ id, title, status, purpose, createdAt, closedAt?, closedOutcome? }, ...]`. Use this to discover existing threads before starting a new one or to browse history.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name." },
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter (default: open).",
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "agent_conversation_close",
    description:
      "Close a conversation when its goal is met. Closed conversations are archived and browseable but drop out of your inbox and stop accepting new messages. Use this as the stop condition of a loop (after the checker approves).",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: "Conversation id to close." },
        outcome: { type: "string", description: "Short note on how it ended (e.g. 'CI passing on main')." },
      },
      required: ["conversation"],
    },
  },
  {
    name: "agent_state_read",
    description:
      "Read a conversation's state doc — its `PROGRESS.md` (what's been done, what's in progress, decisions). Persisted; survives restarts. Returns the content plus when/by whom it was last updated. Read this at the start of every turn so the loop doesn't restart from zero.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: "Conversation id." },
      },
      required: ["conversation"],
    },
  },
  {
    name: "agent_state_write",
    description:
      "Replace a conversation's state doc with `content`. Writes are full replacements — read first, edit, write back. The state doc is the loop's durable memory: messages are the working log, the state doc is the summary (Done, In progress, Next, Blocked). Max 64KB.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: "Conversation id." },
        content: { type: "string", description: "Full state doc content (plain text/markdown)." },
      },
      required: ["conversation", "content"],
    },
  },
  {
    name: "agent_list_channels",
    description:
      "List every channel with its members and total message count across all its conversations. Useful for discovery.",
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
  const key = tokenKey(relayUrl, agent);
  let token = loadToken(key);

  async function ensureRegistered() {
    const res = await client.registerAgent(agent, token);
    token = res.token;
    client.setToken(token);
    saveToken(key, token);
  }

  try {
    await client.health();
  } catch (err) {
    process.stderr.write(`switchboard mcp: cannot reach relay at ${relayUrl} (${err.message})\n`);
    process.exit(1);
  }

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

  try {
    await ensureSkill({ agent, relay: relayUrl });
  } catch {
    /* best-effort */
  }

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

  async function reply(text, { hint = true } = {}) {
    let suffix = "";
    if (hint) {
      try {
        const ib = await client.inbox();
        if (ib.total > 0) {
          suffix = `\n\n(inbox: ${ib.total} unread across ${ib.channels.length} conversation(s) — use agent_inbox / agent_read)`;
        }
      } catch {
        /* hint is best-effort */
      }
    }
    return { content: [{ type: "text", text: text + suffix }] };
  }

  function fmtMessages(messages, { showConv = false } = {}) {
    return messages
      .map((m) => {
        const tag = Array.isArray(m.to) && m.to.length ? ` @${m.to.join(" @")}` : "";
        const mine = Array.isArray(m.to) && m.to.includes(agent) ? " (for you)" : "";
        const data = m.data != null ? `\n  data: ${JSON.stringify(m.data)}` : "";
        const convTag = showConv ? ` [conv ${m.conversationId.slice(0, 8)}]` : "";
        return `[${new Date(m.createdAt).toISOString()}] ${m.from}${tag}${mine}${convTag}: ${m.content}${data}`;
      })
      .join("\n");
  }

  /** Resolve a (channel, conversation) pair to a conversation id, defaulting
   *  to the latest open conversation of the channel when only `channel` is
   *  given. Throws a friendly error when neither is usable. */
  async function resolveConversationId({ channel, conversation }) {
    if (conversation) return conversation;
    if (!channel) throw new Error("either `channel` or `conversation` is required");
    const list = await call(() => client.listConversations(channel, "open"));
    if (list.length === 0) {
      throw new Error(
        `no open conversation in channel "${channel}" — open one with agent_conversation_start`
      );
    }
    // listConversations returns DESC by createdAt — first is the most recent.
    return list[0].id;
  }

  const server = new Server(
    { name: "@icurbe/switchboard", version: "3.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "agent_send": {
          const { channel, content, conversation, to, data, schema, contract } = args;
          const toList = Array.isArray(to) ? to : to ? [to] : [];
          const msg = await call(() =>
            client.postMessage({ channel, conversation, content, to: toList, data, schema, contract })
          );
          const tag = toList.length ? ` (to: ${toList.join(", ")})` : "";
          const validated = schema || contract
            ? ` [contract validated${contract ? `: ${contract}` : ""}]`
            : "";
          return reply(
            `posted message ${msg.id} to channel "${channel}" conv ${msg.conversationId.slice(0, 8)} as "${agent}"${tag}${validated} (status: ${msg.status})`
          );
        }
        case "agent_dm": {
          const { to, content } = args;
          const msg = await call(() => client.dm({ to, content }));
          return reply(
            `DM ${msg.id} sent to "${to}" via channel "${msg.channel}" conv ${msg.conversationId.slice(0, 8)} (status: ${msg.status})`
          );
        }
        case "agent_read": {
          const { channel, conversation, since = 0 } = args;
          const conversationId = await resolveConversationId({ channel, conversation });
          const messages = await call(() =>
            client.readConversationMessages({ conversationId, since })
          );
          if (messages.length === 0) {
            return reply(`no messages in conv ${conversationId.slice(0, 8)} since ${since}`);
          }
          return reply(fmtMessages(messages));
        }
        case "agent_inbox": {
          const ib = await call(() => client.inbox());
          if (ib.total === 0) return reply("inbox empty — no unread messages", { hint: false });
          const lines = ib.channels.map((c) => {
            const m = c.mentioned ? `, ${c.mentioned} for you` : "";
            return `  ${c.channel} / ${c.conversationTitle} (${c.conversationId.slice(0, 8)}): ${c.unread} unread${m} (last from ${c.lastFrom}: ${c.lastPreview})`;
          });
          const header = ib.mentioned
            ? `${ib.total} unread (${ib.mentioned} addressed to you):`
            : `${ib.total} unread:`;
          return reply(`${header}\n${lines.join("\n")}`, { hint: false });
        }
        case "agent_wait": {
          const { channel = null, conversation = null, timeout_ms = 25000 } = args;
          const messages = await call(() =>
            client.wait({ channel, conversation, timeoutMs: timeout_ms })
          );
          if (messages.length === 0) {
            const scope = conversation
              ? ` in conv ${conversation.slice(0, 8)}`
              : channel
              ? ` in "${channel}"`
              : "";
            return reply(
              `no new messages${scope} within ${Math.round(timeout_ms / 1000)}s`
            );
          }
          return reply(fmtMessages(messages, { showConv: !conversation }));
        }
        case "agent_join": {
          const { channel } = args;
          const result = await call(() => client.joinChannel(channel));
          return reply(`joined "${channel}" (members: ${result.members.join(", ")})`);
        }
        case "agent_leave": {
          const { channel } = args;
          const result = await call(() => client.leaveChannel(channel));
          return reply(
            `left "${channel}" (members: ${result.members.join(", ") || "(none)"})`,
            { hint: false }
          );
        }
        case "agent_conversation_start": {
          const { channel, title, purpose, successCriteria } = args;
          const conv = await call(() =>
            client.createConversation(channel, { title, purpose, successCriteria })
          );
          const meta = [purpose ? `purpose: ${purpose}` : null, successCriteria ? `success: ${successCriteria}` : null]
            .filter(Boolean).join(" — ");
          return reply(
            `opened conversation "${title}" (${conv.id}) in "${channel}"${meta ? ` — ${meta}` : ""}`
          );
        }
        case "agent_conversation_list": {
          const { channel, status = "open" } = args;
          const list = await call(() => client.listConversations(channel, status));
          if (list.length === 0) {
            return reply(`no ${status} conversations in "${channel}"`, { hint: false });
          }
          const lines = list.map((c) => {
            const closed = c.status === "closed" && c.closedOutcome ? ` → ${c.closedOutcome}` : "";
            return `  ${c.id.slice(0, 8)}  [${c.status}]  ${c.title}${closed}${c.purpose ? `\n      purpose: ${c.purpose}` : ""}`;
          });
          return reply(`${list.length} ${status} conversation(s) in "${channel}":\n${lines.join("\n")}`, { hint: false });
        }
        case "agent_conversation_close": {
          const { conversation, outcome } = args;
          const conv = await call(() => client.closeConversation(conversation, outcome ?? null));
          return reply(
            `closed conversation "${conv.title}" (${conv.id.slice(0, 8)})${outcome ? ` — outcome: ${outcome}` : ""}`
          );
        }
        case "agent_state_read": {
          const { conversation } = args;
          const state = await call(() => client.readConversationState(conversation));
          if (!state.content) {
            return reply(`(state doc for conv ${conversation.slice(0, 8)} is empty)`, { hint: false });
          }
          const meta = state.updatedAt
            ? `\n\n(last updated ${new Date(state.updatedAt).toISOString()} by ${state.updatedBy})`
            : "";
          return reply(state.content + meta, { hint: false });
        }
        case "agent_state_write": {
          const { conversation, content } = args;
          await call(() => client.writeConversationState(conversation, content));
          return reply(
            `state doc updated for conv ${conversation.slice(0, 8)} (${content.length} bytes)`,
            { hint: false }
          );
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
}
