import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRelayClient } from "./client.js";

const TOOLS = [
  {
    name: "agent_send",
    description:
      "Send a message to a named channel on the switchboard relay. Other agents subscribed to the same channel can read it. The human supervisor sees it in the supervision UI in real time; if approval mode is on, the message stays pending until approved.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Channel name (e.g. 'hector-team', 'bug-43'). Created on first use.",
        },
        content: {
          type: "string",
          description: "Plain-text message body. Keep it self-contained; the other agent may not have your prior context.",
        },
      },
      required: ["channel", "content"],
    },
  },
  {
    name: "agent_read",
    description:
      "Read messages from a channel posted after a given timestamp (epoch ms). Use 0 to fetch all history. Returns an array of messages with { id, from, content, createdAt }.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel name to read from." },
        since: {
          type: "number",
          description: "Epoch ms cutoff. Pass the `createdAt` of the last message you saw to poll for new ones; pass 0 to fetch all history.",
          default: 0,
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "agent_list_channels",
    description:
      "List every channel that currently has at least one message, with its message count. Useful for discovery when you don't know what channels exist.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function runMcp({ agent, relayUrl }) {
  const client = createRelayClient(relayUrl);

  /* Pre-flight: register and fail fast if the relay is unreachable. */
  try {
    await client.health();
    await client.registerAgent(agent);
  } catch (err) {
    process.stderr.write(`switchboard mcp: cannot reach relay at ${relayUrl} (${err.message})\n`);
    process.exit(1);
  }

  const server = new Server(
    { name: "@icurbe/switchboard", version: "1.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "agent_send": {
          const { channel, content } = args;
          const msg = await client.postMessage({ channel, from: agent, content });
          return {
            content: [
              {
                type: "text",
                text: `posted message ${msg.id} to channel "${channel}" as "${agent}" (status: ${msg.status})`,
              },
            ],
          };
        }
        case "agent_read": {
          const { channel, since = 0 } = args;
          const messages = await client.readMessages({ channel, since });
          if (messages.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `no messages in "${channel}" since ${since}`,
                },
              ],
            };
          }
          const lines = messages.map(
            (m) => `[${new Date(m.createdAt).toISOString()}] ${m.from}: ${m.content}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        case "agent_list_channels": {
          const channels = await client.listChannels();
          if (channels.length === 0) {
            return { content: [{ type: "text", text: "no channels yet" }] };
          }
          const lines = channels.map((c) => `  ${c.name} (${c.messageCount} messages)`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        default:
          return {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true,
          };
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
