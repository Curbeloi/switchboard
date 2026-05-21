const DEFAULT_RELAY = "http://127.0.0.1:8765";

/**
 * Background listener for an agent. Polls the relay's READ-ONLY HTTP endpoints
 * (no agent token), so it never collides with the agent's MCP wrapper identity
 * and never advances the agent's read cursor — detection is decoupled from
 * consumption (the agent still reads with agent_read).
 *
 * Each new message addressed to the agent is printed as ONE line on stdout, so
 * a session harness that turns stdout into notifications (e.g. Claude Code's
 * Monitor / background tasks) wakes the agent without blocking its turn.
 *
 * Watermark is in-memory, seeded to "now" on start, so history isn't replayed.
 */
export async function runListen({
  agent,
  relayUrl = DEFAULT_RELAY,
  intervalMs = 10000,
  all = false,
} = {}) {
  if (!agent) throw new Error("--agent NAME is required");
  const base = relayUrl.replace(/\/+$/, "");
  let since = Date.now(); // seed to now: don't notify about history

  // Banner on stderr so it isn't treated as a message (only stdout = notifications).
  process.stderr.write(
    `switchboard listen: agent="${agent}" relay=${base}, every ${Math.round(intervalMs / 1000)}s — ` +
      `${all ? "all messages in your channels" : "messages addressed to you (mentions + DMs)"}\n`
  );

  async function getJson(path) {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  async function poll() {
    const channels = await getJson("/api/channels");
    let maxSeen = since;
    const hits = [];
    for (const ch of channels) {
      const members = Array.isArray(ch.members) ? ch.members : [];
      if (!members.includes(agent)) continue; // only channels we belong to
      const isMyDm = ch.name.startsWith("dm:");
      const msgs = await getJson(
        `/api/channels/${encodeURIComponent(ch.name)}/messages?since=${since}`
      );
      for (const m of msgs) {
        if (m.createdAt > maxSeen) maxSeen = m.createdAt;
        if (m.from === agent) continue; // ignore our own posts
        const addressed = (Array.isArray(m.to) && m.to.includes(agent)) || isMyDm;
        if (all || addressed) hits.push(m);
      }
    }
    hits.sort((a, b) => a.createdAt - b.createdAt);
    for (const m of hits) {
      const preview = String(m.content || "").replace(/\s+/g, " ").slice(0, 200);
      process.stdout.write(`[switchboard] ${m.from} → ${m.channel}: ${preview}\n`);
    }
    if (maxSeen > since) since = maxSeen;
  }

  // Loop forever; transient failures are logged to stderr and retried.
  for (;;) {
    try {
      await poll();
    } catch (err) {
      process.stderr.write(`switchboard listen: poll failed (${err.message}); retrying\n`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
