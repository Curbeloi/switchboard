import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const DEFAULT_RELAY = "http://127.0.0.1:8765";
const STATE_DIR = join(homedir(), ".switchboard");

/** Per-agent watermark file (used by --once so relaunches resume gaplessly). */
function watermarkPath(agent) {
  const safe = agent.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(STATE_DIR, `listen-${safe}.json`);
}
function loadWatermark(agent, relay) {
  try {
    const d = JSON.parse(readFileSync(watermarkPath(agent), "utf8"));
    if (d.relay === relay && typeof d.since === "number") return d.since;
  } catch {
    /* missing or unreadable — fall through */
  }
  return null;
}
function saveWatermark(agent, relay, since) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(watermarkPath(agent), JSON.stringify({ relay, since }));
  } catch {
    /* best-effort: a missed watermark only means we may re-notify, never crash */
  }
}

/**
 * Background listener for an agent. Polls the relay's READ-ONLY HTTP endpoints
 * (no agent token), so it never collides with the agent's MCP wrapper identity
 * and never advances the agent's read cursor — detection is decoupled from
 * consumption (the agent still reads with agent_read). Each new message
 * addressed to the agent is printed as ONE stdout line.
 *
 * Two modes:
 *   - default: run forever, printing each new message (a log/monitor).
 *   - once:    block until the next message addressed to the agent, print it,
 *              then EXIT. A Claude Code agent runs this as a background task; its
 *              exit wakes the agent, which reads + replies, then relaunches it —
 *              event-driven auto-detection with no empty-turn polling. Uses a
 *              persisted watermark so a message arriving between exit and the
 *              relaunch isn't missed.
 */
export async function runListen({
  agent,
  relayUrl = DEFAULT_RELAY,
  intervalMs = 10000,
  all = false,
  once = false,
} = {}) {
  if (!agent) throw new Error("--agent NAME is required");
  const base = relayUrl.replace(/\/+$/, "");

  // once: resume from the persisted watermark (gapless). Otherwise seed to now.
  let since = once ? loadWatermark(agent, base) ?? Date.now() : Date.now();
  if (once) saveWatermark(agent, base, since);

  process.stderr.write(
    `switchboard listen: agent="${agent}" relay=${base}, every ${Math.round(intervalMs / 1000)}s` +
      `${once ? " (--once: exit on first message)" : ""} — ` +
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
    return hits;
  }

  for (;;) {
    let hits = [];
    try {
      hits = await poll();
    } catch (err) {
      process.stderr.write(`switchboard listen: poll failed (${err.message}); retrying\n`);
    }
    if (once && hits.length) {
      saveWatermark(agent, base, since); // resume here on the next relaunch
      return; // exit 0 → the harness wakes the agent
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
