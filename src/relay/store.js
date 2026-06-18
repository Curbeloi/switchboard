/**
 * SQLite-backed message + agent store (durable across relay restarts).
 *
 * Uses Node's built-in `node:sqlite` (no native build, no extra dependency).
 * Same closure-factory shape and method contract as the former in-memory store
 * — this is the documented "SQLite-swap seam": routes/MCP are unchanged.
 *
 * Persisted: agents (+tokens), channels, membership, messages (incl. pending),
 * and per-agent read cursors. Kept in-memory (transient by nature): live
 * `agent_wait` long-poll waiters, and the supervision `mode` (which is itself
 * persisted separately via config.js and restored on boot).
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./config.js";

export function createStore({ dbPath = join(DEFAULT_CONFIG_DIR, "switchboard.db") } = {}) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      registeredAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      name TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_members (
      channel TEXT NOT NULL,
      agent TEXT NOT NULL,
      PRIMARY KEY (channel, agent)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      to_json TEXT,
      data_json TEXT,
      schema_json TEXT,
      contract TEXT,
      createdAt INTEGER NOT NULL,
      status TEXT NOT NULL,
      review_json TEXT,
      approvedAt INTEGER,
      rejectedAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel, status, createdAt);
    CREATE TABLE IF NOT EXISTS read_cursors (
      agent TEXT NOT NULL,
      channel TEXT NOT NULL,
      lastReadAt INTEGER NOT NULL,
      PRIMARY KEY (agent, channel)
    );
    CREATE TABLE IF NOT EXISTS channel_state (
      channel TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      updatedBy TEXT NOT NULL
    );
  `);

  /* Prepared statements */
  const q = {
    insAgent: db.prepare("INSERT INTO agents(name, token, registeredAt, lastSeenAt) VALUES(?, ?, ?, ?)"),
    agentByName: db.prepare("SELECT * FROM agents WHERE name = ?"),
    agentByToken: db.prepare("SELECT * FROM agents WHERE token = ?"),
    touchAgent: db.prepare("UPDATE agents SET lastSeenAt = ? WHERE name = ?"),
    allAgents: db.prepare("SELECT name, registeredAt, lastSeenAt FROM agents"),

    insChannel: db.prepare("INSERT OR IGNORE INTO channels(name, createdAt) VALUES(?, ?)"),
    hasChannel: db.prepare("SELECT 1 FROM channels WHERE name = ?"),
    delChannel: db.prepare("DELETE FROM channels WHERE name = ?"),
    allChannels: db.prepare("SELECT name FROM channels"),

    insMember: db.prepare("INSERT OR IGNORE INTO channel_members(channel, agent) VALUES(?, ?)"),
    delMember: db.prepare("DELETE FROM channel_members WHERE channel = ? AND agent = ?"),
    membersOf: db.prepare("SELECT agent FROM channel_members WHERE channel = ? ORDER BY agent"),
    memberChannels: db.prepare("SELECT channel FROM channel_members WHERE agent = ?"),
    isMember: db.prepare("SELECT 1 FROM channel_members WHERE channel = ? AND agent = ?"),
    delMembersOfChannel: db.prepare("DELETE FROM channel_members WHERE channel = ?"),

    insMsg: db.prepare(`INSERT INTO messages
      (id, channel, from_agent, content, to_json, data_json, schema_json, contract, createdAt, status, review_json, approvedAt, rejectedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    msgById: db.prepare("SELECT * FROM messages WHERE id = ?"),
    updApprove: db.prepare("UPDATE messages SET status = 'delivered', approvedAt = ?, review_json = ? WHERE id = ?"),
    updReject: db.prepare("UPDATE messages SET status = 'rejected', rejectedAt = ?, review_json = ? WHERE id = ?"),
    updReview: db.prepare("UPDATE messages SET review_json = ? WHERE id = ?"),
    deliveredSince: db.prepare("SELECT * FROM messages WHERE channel = ? AND status = 'delivered' AND createdAt > ? ORDER BY createdAt"),
    unreadStmt: db.prepare("SELECT * FROM messages WHERE channel = ? AND status = 'delivered' AND createdAt > ? AND from_agent != ? ORDER BY createdAt"),
    countDelivered: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND status = 'delivered'"),
    pending: db.prepare("SELECT * FROM messages WHERE status = 'pending' ORDER BY createdAt"),
    delMsgsOfChannel: db.prepare("DELETE FROM messages WHERE channel = ?"),

    getCursor: db.prepare("SELECT lastReadAt FROM read_cursors WHERE agent = ? AND channel = ?"),
    setCursor: db.prepare(`INSERT INTO read_cursors(agent, channel, lastReadAt) VALUES(?, ?, ?)
      ON CONFLICT(agent, channel) DO UPDATE SET lastReadAt = excluded.lastReadAt`),
    delCursorsOfChannel: db.prepare("DELETE FROM read_cursors WHERE channel = ?"),

    getState: db.prepare("SELECT content, updatedAt, updatedBy FROM channel_state WHERE channel = ?"),
    setState: db.prepare(`INSERT INTO channel_state(channel, content, updatedAt, updatedBy) VALUES(?, ?, ?, ?)
      ON CONFLICT(channel) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`),
    delStateOfChannel: db.prepare("DELETE FROM channel_state WHERE channel = ?"),
  };

  /** Long-poll waiters for agent_wait (in-memory; transient). */
  const waiters = new Set();

  /** Supervision mode (in-memory; persisted via config.js, restored on boot). */
  let mode = "manual";

  function rowToMessage(r) {
    if (!r) return null;
    const msg = {
      id: r.id,
      channel: r.channel,
      from: r.from_agent,
      content: r.content,
      to: r.to_json ? JSON.parse(r.to_json) : [],
      data: r.data_json ? JSON.parse(r.data_json) : null,
      schema: r.schema_json ? JSON.parse(r.schema_json) : null,
      contract: r.contract ?? null,
      createdAt: r.createdAt,
      status: r.status,
    };
    if (r.review_json) msg.review = JSON.parse(r.review_json);
    if (r.approvedAt != null) msg.approvedAt = r.approvedAt;
    if (r.rejectedAt != null) msg.rejectedAt = r.rejectedAt;
    return msg;
  }

  function publicChannel(name) {
    return {
      name,
      members: q.membersOf.all(name).map((r) => r.agent),
      messageCount: q.countDelivered.get(name).n,
    };
  }

  function ensureChannel(name) {
    q.insChannel.run(name, Date.now());
  }

  function unreadFor(agent, channelName) {
    const cursor = q.getCursor.get(agent, channelName)?.lastReadAt ?? 0;
    return q.unreadStmt.all(channelName, cursor, agent).map(rowToMessage);
  }

  function computeInbox(agent) {
    const items = [];
    let total = 0;
    let mentioned = 0;
    for (const { channel } of q.memberChannels.all(agent)) {
      const unread = unreadFor(agent, channel);
      if (unread.length === 0) continue;
      const mine = unread.filter((m) => m.to.includes(agent)).length;
      const last = unread[unread.length - 1];
      items.push({
        channel,
        unread: unread.length,
        mentioned: mine,
        lastFrom: last.from,
        lastPreview: last.content.length > 80 ? last.content.slice(0, 80) + "…" : last.content,
      });
      total += unread.length;
      mentioned += mine;
    }
    return { total, mentioned, channels: items };
  }

  /** Resolve any waiter that matches a freshly delivered message. */
  function notifyWaiters(msg) {
    for (const w of [...waiters]) {
      if (msg.from === w.agent) continue;
      if (w.channel) {
        if (w.channel !== msg.channel) continue;
      } else if (!q.isMember.get(msg.channel, w.agent)) {
        continue;
      }
      waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve([msg]);
    }
  }

  return {
    /* agents + identity */
    registerAgent(name, token) {
      const now = Date.now();
      const existing = q.agentByName.get(name);
      if (existing) {
        // Name already claimed — only the holder of its token may re-register.
        if (token && token === existing.token) {
          q.touchAgent.run(now, name);
          return { name, token: existing.token, registeredAt: existing.registeredAt, lastSeenAt: now };
        }
        return null;
      }
      const tok = randomUUID();
      q.insAgent.run(name, tok, now, now);
      return { name, token: tok, registeredAt: now, lastSeenAt: now };
    },
    verifyToken(token) {
      if (!token) return null;
      const a = q.agentByToken.get(token);
      if (!a) return null;
      const now = Date.now();
      q.touchAgent.run(now, a.name);
      return { name: a.name, token: a.token, registeredAt: a.registeredAt, lastSeenAt: now };
    },
    hasAgent(name) {
      return Boolean(q.agentByName.get(name));
    },
    listAgents() {
      // Never leak tokens over the API.
      return q.allAgents.all();
    },
    touchAgent(name) {
      q.touchAgent.run(Date.now(), name);
    },

    /* channels + membership */
    joinChannel(name, agent) {
      ensureChannel(name);
      q.insMember.run(name, agent);
      return publicChannel(name);
    },
    leaveChannel(name, agent) {
      if (!q.hasChannel.get(name)) return null;
      q.delMember.run(name, agent);
      return publicChannel(name);
    },
    listChannels() {
      return q.allChannels.all().map((r) => publicChannel(r.name));
    },
    channelMembers(name) {
      if (!q.hasChannel.get(name)) return [];
      return q.membersOf.all(name).map((r) => r.agent);
    },

    /* channel state doc (shared memory; the "PROGRESS.md" pattern). One mutable
     * text blob per channel. Read by anyone, written by an agent (which auto-
     * joins them, mirroring postMessage). Persisted; survives restarts. */
    getChannelState(name) {
      const r = q.getState.get(name);
      if (!r) return null;
      return { channel: name, content: r.content, updatedAt: r.updatedAt, updatedBy: r.updatedBy };
    },
    setChannelState(name, content, agent) {
      ensureChannel(name);
      q.insMember.run(name, agent);
      const updatedAt = Date.now();
      q.setState.run(name, content, updatedAt, agent);
      return { channel: name, content, updatedAt, updatedBy: agent };
    },

    dmChannelName(a, b) {
      return "dm:" + [a, b].sort().join("+");
    },
    /** Explicitly create an empty channel (idempotent — an existing channel is
     *  returned untouched). Human-supervisor action; agents create implicitly. */
    createChannel(name) {
      ensureChannel(name);
      return publicChannel(name);
    },
    /** Delete a whole channel and everything keyed on it: its messages (incl.
     *  pending), members, and read cursors; channel-bound waiters are resolved
     *  empty so their long-polls don't leak. Returns false if it didn't exist. */
    deleteChannel(name) {
      if (!q.hasChannel.get(name)) return false;
      q.delMsgsOfChannel.run(name);
      q.delMembersOfChannel.run(name);
      q.delCursorsOfChannel.run(name);
      q.delStateOfChannel.run(name);
      q.delChannel.run(name);
      for (const w of [...waiters]) {
        if (w.channel !== name) continue;
        clearTimeout(w.timer);
        waiters.delete(w);
        w.resolve([]);
      }
      return true;
    },

    /* messages */
    postMessage({ channel, from, content, to = [], data = null, schema = null, contract = null }) {
      ensureChannel(channel);
      q.insMember.run(channel, from); // sender is implicitly a member
      for (const m of to) q.insMember.run(channel, m); // tagged agents join
      const msg = {
        id: randomUUID(),
        channel,
        from,
        content,
        to,
        data,
        schema,
        contract,
        createdAt: Date.now(),
        status: mode === "auto" ? "delivered" : "pending",
      };
      q.insMsg.run(
        msg.id, channel, from, content,
        JSON.stringify(to),
        data != null ? JSON.stringify(data) : null,
        schema != null ? JSON.stringify(schema) : null,
        contract,
        msg.createdAt, msg.status, null, null, null
      );
      if (msg.status === "delivered") notifyWaiters(msg);
      return msg;
    },
    readMessages({ channel, since = 0 }) {
      return q.deliveredSince.all(channel, since).map(rowToMessage);
    },
    listPending() {
      return q.pending.all().map(rowToMessage);
    },
    approvePending(id, review = null) {
      const row = q.msgById.get(id);
      if (!row || row.status !== "pending") return null;
      const reviewJson = review ? JSON.stringify(review) : row.review_json;
      q.updApprove.run(Date.now(), reviewJson, id);
      const msg = rowToMessage(q.msgById.get(id));
      notifyWaiters(msg);
      return msg;
    },
    rejectPending(id, review = null) {
      const row = q.msgById.get(id);
      if (!row || row.status !== "pending") return null;
      const reviewJson = review ? JSON.stringify(review) : row.review_json;
      q.updReject.run(Date.now(), reviewJson, id);
      return rowToMessage(q.msgById.get(id));
    },
    /** Reviewer escalated to a human: annotate but leave it pending. */
    markEscalated(id, reason) {
      const row = q.msgById.get(id);
      if (!row || row.status !== "pending") return null;
      q.updReview.run(JSON.stringify({ decision: "escalate", reason, at: Date.now() }), id);
      return rowToMessage(q.msgById.get(id));
    },

    /* read cursors + inbox + wait */
    markRead(agent, channel) {
      const unread = unreadFor(agent, channel).length;
      q.setCursor.run(agent, channel, Date.now());
      return unread;
    },
    inboxFor(agent) {
      return computeInbox(agent);
    },
    unreadCount(agent) {
      return computeInbox(agent).total;
    },
    waitForMessage({ agent, channel = null, timeoutMs = 25000 }) {
      const immediate = channel ? unreadFor(agent, channel) : null;
      if (immediate && immediate.length) return Promise.resolve(immediate);
      return new Promise((resolve) => {
        const w = { agent, channel, resolve, timer: null };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          resolve([]);
        }, timeoutMs);
        waiters.add(w);
      });
    },

    /* supervision mode */
    setMode(value) {
      if (!["manual", "auto", "llm"].includes(value)) {
        throw new Error(`invalid mode: ${value} (expected manual | auto | llm)`);
      }
      mode = value;
      return mode;
    },
    getMode() {
      return mode;
    },

    /** Close the underlying database (for tests / graceful shutdown). */
    close() {
      db.close();
    },
  };
}

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} channel
 * @property {string} from
 * @property {string} content
 * @property {string[]} to
 * @property {object|null} data
 * @property {object|null} schema
 * @property {string|null} contract
 * @property {number} createdAt
 * @property {"delivered" | "pending" | "rejected"} status
 * @property {{decision: string, reason: string, at: number}} [review]
 * @property {number} [approvedAt]
 * @property {number} [rejectedAt]
 */
