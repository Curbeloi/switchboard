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
      "Post a message into a conversation. A conversation is the room: it has members, its own message stream, and its own state doc. Use `to` to @mention specific agents (everyone in the conversation sees it; tagged agents are flagged it's for them). Open a conversation first with agent_conversation_start (or use agent_dm for a 1:1).",
    inputSchema: {
      type: "object",
      properties: {
        conversation: {
          type: "string",
          description: "Conversation id to post into (from agent_conversation_start / agent_conversation_list / agent_inbox).",
        },
        content: {
          type: "string",
          description: "Plain-text message body. Keep it self-contained.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Optional: agent name(s) this message is addressed to (an @mention). They must be registered agents (or \"master\" to reach the supervisor).",
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
      required: ["conversation", "content"],
    },
  },
  {
    name: "agent_dm",
    description:
      "Send a direct message to another agent by name. Resolves (or creates on first use) the canonical 1:1 conversation between the two of you; it lives forever and both agents are auto-joined.",
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
      "Read messages from a conversation posted after a timestamp. Marks the conversation read for you (read receipt). Returns messages with `{ id, conversationId, from, content, createdAt }`.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: "Conversation id to read." },
        since: {
          type: "number",
          description: "Epoch ms cutoff. Pass the last createdAt you saw to poll; 0 for all history.",
          default: 0,
        },
      },
      required: ["conversation"],
    },
  },
  {
    name: "agent_inbox",
    description:
      "Show your unread messages grouped by **conversation** (the conversations you belong to that have unread). Closed conversations don't appear. Use this to discover what needs a reply.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_wait",
    description:
      "Block until a new message arrives for you (long-poll), then return it. Returns immediately if you already have unread for the named conversation. Times out empty after timeout_ms. Scope: pass `conversation` to watch one thread; omit it to watch every conversation you belong to.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: "Conversation id to watch (you are auto-joined). Omit to watch all your conversations." },
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
      "Join a conversation so its messages appear in your inbox and you can wait on them. Use agent_conversation_list to discover conversations to join.",
    inputSchema: {
      type: "object",
      properties: { conversation: { type: "string", description: "Conversation id to join." } },
      required: ["conversation"],
    },
  },
  {
    name: "agent_leave",
    description:
      "Leave a conversation: stop its messages from appearing in your inbox and from waking your listener. Note: a later DM/@mention auto-joins you again.",
    inputSchema: {
      type: "object",
      properties: { conversation: { type: "string", description: "Conversation id to leave." } },
      required: ["conversation"],
    },
  },
  {
    name: "agent_conversation_start",
    description:
      "Open a new conversation for a focused task. Each loop should live in its own conversation: it gets its own message stream, state doc (PROGRESS.md), members, and unread cursor. Returns `{ id, title, status: 'open', members, contract_name }`. Pass `purpose` and `successCriteria` so the team knows what 'done' means, and `members` to invite specific agents. Optionally pass `contract` (e.g. \"dsp.v1\") to make this a governed conversation — every message posted to it MUST carry `data` matching that contract.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short topic of the conversation (e.g. 'fix flaky-test-a')." },
        purpose: { type: "string", description: "What this conversation is doing, in one sentence." },
        successCriteria: { type: "string", description: "Objective signal that means 'close this loop'. Should be checkable." },
        members: {
          type: "array",
          items: { type: "string" },
          description: "Optional: agent name(s) to invite as members (you are added automatically). They must be registered agents.",
        },
        contract: { type: "string", description: "Optional: name of a named contract (e.g. 'dsp.v1') that ALL messages in this conversation must match. The relay rejects (400) any post without `data` validating against the contract's schema." },
      },
      required: ["title"],
    },
  },
  {
    name: "agent_conversation_set_contract",
    description:
      "Set (or clear) the active named contract on an existing conversation. Pass a contract name (e.g. 'dsp.v1') to govern it from now on, or null to remove the contract. Subsequent messages must carry `data` matching the contract's schema; the reviewer judges the response against the contract's intent.",
    inputSchema: {
      type: "object",
      properties: {
        conversation: { type: "string", description: "Conversation id." },
        contract_name: { type: ["string", "null"], description: "Name of a named contract, or null to clear." },
      },
      required: ["conversation"],
    },
  },
  {
    name: "agent_conversation_list",
    description:
      "List conversations on the relay (with their members and message counts). Filter by status (`open` | `closed` | `all`; default `open`). Returns `[{ id, title, status, purpose, members, messageCount, isDm, createdAt, closedOutcome? }, ...]`. Use this to discover existing conversations before starting a new one, to find one to join, or to browse history.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter (default: open).",
        },
      },
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
          suffix = `\n\n(inbox: ${ib.total} unread across ${ib.conversations.length} conversation(s) — use agent_inbox / agent_read)`;
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

  const server = new Server(
    { name: "@icurbe/switchboard", version: "4.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "agent_send": {
          const { conversation, content, to, data, schema, contract } = args;
          const toList = Array.isArray(to) ? to : to ? [to] : [];
          const msg = await call(() =>
            client.postMessage({ conversation, content, to: toList, data, schema, contract })
          );
          const tag = toList.length ? ` (to: ${toList.join(", ")})` : "";
          const validated = schema || contract
            ? ` [contract validated${contract ? `: ${contract}` : ""}]`
            : "";
          return reply(
            `posted message ${msg.id} to conv ${msg.conversationId.slice(0, 8)} as "${agent}"${tag}${validated} (status: ${msg.status})`
          );
        }
        case "agent_dm": {
          const { to, content } = args;
          const msg = await call(() => client.dm({ to, content }));
          return reply(
            `DM ${msg.id} sent to "${to}" in conv ${msg.conversationId.slice(0, 8)} (status: ${msg.status})`
          );
        }
        case "agent_read": {
          const { conversation, since = 0 } = args;
          if (!conversation) throw new Error("`conversation` is required");
          const messages = await call(() =>
            client.readConversationMessages({ conversationId: conversation, since })
          );
          if (messages.length === 0) {
            return reply(`no messages in conv ${conversation.slice(0, 8)} since ${since}`);
          }
          return reply(fmtMessages(messages));
        }
        case "agent_inbox": {
          const ib = await call(() => client.inbox());
          if (ib.total === 0) return reply("inbox empty — no unread messages", { hint: false });
          const lines = ib.conversations.map((c) => {
            const m = c.mentioned ? `, ${c.mentioned} for you` : "";
            return `  ${c.conversationTitle} (${c.conversationId.slice(0, 8)}): ${c.unread} unread${m} (last from ${c.lastFrom}: ${c.lastPreview})`;
          });
          const header = ib.mentioned
            ? `${ib.total} unread (${ib.mentioned} addressed to you):`
            : `${ib.total} unread:`;
          return reply(`${header}\n${lines.join("\n")}`, { hint: false });
        }
        case "agent_wait": {
          const { conversation = null, timeout_ms = 25000 } = args;
          const messages = await call(() =>
            client.wait({ conversation, timeoutMs: timeout_ms })
          );
          if (messages.length === 0) {
            const scope = conversation ? ` in conv ${conversation.slice(0, 8)}` : "";
            return reply(
              `no new messages${scope} within ${Math.round(timeout_ms / 1000)}s`
            );
          }
          return reply(fmtMessages(messages, { showConv: !conversation }));
        }
        case "agent_join": {
          const { conversation } = args;
          const conv = await call(() => client.joinConversation(conversation));
          return reply(`joined "${conv.title}" (${conv.id.slice(0, 8)}) — members: ${conv.members.join(", ")}`);
        }
        case "agent_leave": {
          const { conversation } = args;
          const conv = await call(() => client.leaveConversation(conversation));
          return reply(
            `left "${conv.title}" (${conv.id.slice(0, 8)}) — members: ${conv.members.join(", ") || "(none)"}`,
            { hint: false }
          );
        }
        case "agent_conversation_start": {
          const { title, purpose, successCriteria, members, contract } = args;
          const memberList = Array.isArray(members) ? members : members ? [members] : [];
          const conv = await call(() =>
            client.createConversation({ title, purpose, successCriteria, members: memberList, contractName: contract })
          );
          const meta = [
            purpose ? `purpose: ${purpose}` : null,
            successCriteria ? `success: ${successCriteria}` : null,
            contract ? `contract: ${contract}` : null,
          ].filter(Boolean).join(" — ");
          return reply(
            `opened conversation "${title}" (${conv.id}) — members: ${conv.members.join(", ")}${meta ? ` — ${meta}` : ""}`
          );
        }
        case "agent_conversation_set_contract": {
          const { conversation, contract_name = null } = args;
          const conv = await call(() => client.setConversationContract(conversation, contract_name));
          return reply(
            contract_name
              ? `conversation "${conv.title}" (${conv.id.slice(0, 8)}) now governed by contract "${contract_name}"`
              : `conversation "${conv.title}" (${conv.id.slice(0, 8)}) contract cleared`,
            { hint: false }
          );
        }
        case "agent_conversation_list": {
          const { status = "open" } = args;
          const list = await call(() => client.listConversations(status));
          if (list.length === 0) {
            return reply(`no ${status} conversations`, { hint: false });
          }
          const lines = list.map((c) => {
            const closed = c.status === "closed" && c.closedOutcome ? ` → ${c.closedOutcome}` : "";
            const dm = c.isDm ? " (dm)" : "";
            const members = c.members?.length ? `  members: ${c.members.join(", ")}` : "";
            return `  ${c.id.slice(0, 8)}  [${c.status}]${dm}  ${c.title}${closed} (${c.messageCount ?? 0} msgs)${members}${c.purpose ? `\n      purpose: ${c.purpose}` : ""}`;
          });
          return reply(`${list.length} ${status} conversation(s):\n${lines.join("\n")}`, { hint: false });
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
