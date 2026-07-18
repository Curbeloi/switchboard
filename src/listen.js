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
  conversations = [],
  exclude = [],
} = {}) {
  if (!agent) throw new Error("--agent NAME is required");
  const base = relayUrl.replace(/\/+$/, "");

  // Conversation scoping: an allowlist (only these wake you) and/or a denylist
  // (never these), by conversation id. Applied in poll() after the membership
  // check, so it narrows the wakeup WITHOUT touching membership/inbox — and
  // survives the auto-join that re-adds you when someone DMs/@mentions you.
  const allow = new Set(conversations);
  const deny = new Set(exclude);

  // once: resume from the persisted watermark (gapless). Otherwise seed to now.
  let since = once ? loadWatermark(agent, base) ?? Date.now() : Date.now();
  if (once) saveWatermark(agent, base, since);

  const scope = all
    ? "all messages in your conversations"
    : "messages addressed to you (mentions + DMs)";
  const filt = allow.size ? ` only in {${[...allow].join(", ")}}` : "";
  const excl = deny.size ? ` excluding {${[...deny].join(", ")}}` : "";
  process.stderr.write(
    `switchboard listen: agent="${agent}" relay=${base}, every ${Math.round(intervalMs / 1000)}s` +
      `${once ? " (--once: exit on first message)" : ""} — ` +
      `${scope}${filt}${excl}\n`
  );

  async function getJson(path) {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  /** projectId → project name, to label wakeups by project (best-effort). */
  async function projectNames() {
    try {
      const projects = await getJson("/api/projects");
      return new Map((projects || []).map((p) => [p.id, p.name]));
    } catch {
      return new Map();
    }
  }

  async function poll() {
    // Conversations carry their members (no token needed); poll each one we
    // belong to for delivered messages since the watermark.
    const convs = await getJson("/api/conversations?status=all");
    let maxSeen = since;
    const hits = [];
    for (const conv of convs) {
      const members = Array.isArray(conv.members) ? conv.members : [];
      if (!members.includes(agent)) continue; // only conversations we belong to
      if (allow.size && !allow.has(conv.id)) continue; // allowlist: only these
      if (deny.has(conv.id)) continue; // denylist: never these
      const msgs = await getJson(
        `/api/conversations/${encodeURIComponent(conv.id)}/messages?since=${since}`
      );
      for (const m of msgs) {
        if (m.createdAt > maxSeen) maxSeen = m.createdAt;
        if (m.from === agent) continue; // ignore our own posts
        const addressed = (Array.isArray(m.to) && m.to.includes(agent)) || conv.isDm;
        if (all || addressed) hits.push({ m, conv });
      }
    }
    hits.sort((a, b) => a.m.createdAt - b.m.createdAt);
    // Tell the agent EXACTLY where to look: project + conversation title + id, so
    // on wake it can agent_read(id) and reply without first hunting for the thread.
    const projById = hits.length ? await projectNames() : new Map();
    for (const { m, conv } of hits) {
      const preview = String(m.content || "").replace(/\s+/g, " ").slice(0, 200);
      const proj = conv.projectId ? projById.get(conv.projectId) : null;
      const where = `"${conv.title}"${proj ? ` · project ${proj}` : ""}`;
      process.stdout.write(
        `[switchboard] new message from ${m.from} in ${where} — read & reply with agent_read("${conv.id}"): ${preview}\n`
      );
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
