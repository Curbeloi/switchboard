import { readFileSync } from "node:fs";
import { createRelayClient } from "./mcp/client.js";
import { loadToken, saveToken, tokenKey } from "./tokens.js";

const DEFAULT_RELAY = "http://127.0.0.1:8765";

/**
 * Send ONE message to the relay without the MCP server — a fallback for when an
 * agent's MCP tools become unavailable mid-session (the stdio server dropped).
 * Reads the agent's persisted token from ~/.switchboard/tokens.json (the same
 * file the MCP wrapper writes), so it acts as the agent over plain HTTP.
 *
 * Mirrors the wrapper's register/401-retry: if the relay restarted and the token
 * is stale, re-register once (re-claiming the name) and retry.
 */
export async function runSend({
  agent,
  relayUrl = DEFAULT_RELAY,
  conversation = null,
  dm = null,
  to = [],
  content,
  data = null,
  contract = null,
  schema = null,
} = {}) {
  if (!agent) throw new Error("--agent NAME is required");
  if (dm && conversation) throw new Error("--conversation and --dm are mutually exclusive");
  if (!dm && !conversation) throw new Error("provide --conversation ID or --dm AGENT");

  // Content: positional arg, or piped on stdin (handy for long, multi-line bodies).
  if (content == null) {
    if (process.stdin.isTTY) {
      throw new Error("message content required (pass it as an argument or pipe it on stdin)");
    }
    content = readFileSync(0, "utf8").replace(/\n$/, "");
  }
  if (!content) throw new Error("message content is empty");

  const base = relayUrl.replace(/\/+$/, "");
  const key = tokenKey(base, agent);
  let token = loadToken(key);
  const client = createRelayClient(base, token);

  async function ensureRegistered() {
    const res = await client.registerAgent(agent, token);
    token = res.token;
    client.setToken(token);
    saveToken(key, token);
  }

  // No persisted token yet (first use or cleared file): claim the name first.
  if (!token) await ensureRegistered();

  const attempt = () =>
    dm
      ? client.dm({ to: dm, content })
      : client.postMessage({ conversation, content, to, data, schema, contract });

  let msg;
  try {
    msg = await attempt();
  } catch (err) {
    // Token rejected (relay restarted → identity gone): re-register once and retry.
    if (err.status === 401) {
      await ensureRegistered();
      msg = await attempt();
    } else {
      throw err;
    }
  }

  const tag = to.length ? ` (to: ${to.join(", ")})` : "";
  process.stdout.write(
    `[switchboard] sent id=${msg.id} status=${msg.status} → conv ${msg.conversationId.slice(0, 8)}${tag}\n`
  );
  if (msg.status === "pending") {
    process.stderr.write(
      `note: held for supervisor approval (relay is in manual/llm mode)\n`
    );
  }
  return msg;
}
