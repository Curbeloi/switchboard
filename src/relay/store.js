/**
 * SQLite-backed message + agent store (durable across relay restarts).
 *
 * Uses Node's built-in `node:sqlite` (no native build, no extra dependency).
 * Same closure-factory shape — routes/MCP talk to it through the documented
 * methods only.
 *
 * Persisted (schema v3):
 *   - agents (+tokens), channels, channel_members
 *   - conversations (threads within a channel; own state doc + own message
 *     stream; optional `contract_name` for DSP-style governance)
 *   - messages (keyed by conversation_id; channel kept for lookup)
 *   - read_cursors (per-agent, per-conversation)
 *   - conversation_state (the "PROGRESS.md" of each loop)
 *
 * Kept in-memory (transient): live `agent_wait` long-poll waiters, and the
 * supervision `mode` (which itself persists via config.js, restored on boot).
 *
 * Migration: PRAGMA user_version is the schema gate. Migrations are stacked
 * forward; old DBs walk v0/v1 → v2 → v3 in one boot, idempotent on reopen.
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./config.js";

const SCHEMA_VERSION = 3;

export function createStore({ dbPath = join(DEFAULT_CONFIG_DIR, "switchboard.db") } = {}) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  ensureSchema(db);

  /* Prepared statements */
  const q = {
    /* agents */
    insAgent: db.prepare("INSERT INTO agents(name, token, registeredAt, lastSeenAt) VALUES(?, ?, ?, ?)"),
    agentByName: db.prepare("SELECT * FROM agents WHERE name = ?"),
    agentByToken: db.prepare("SELECT * FROM agents WHERE token = ?"),
    touchAgent: db.prepare("UPDATE agents SET lastSeenAt = ? WHERE name = ?"),
    allAgents: db.prepare("SELECT name, registeredAt, lastSeenAt FROM agents"),

    /* channels + membership */
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

    /* conversations */
    insConv: db.prepare(`INSERT INTO conversations
      (id, channel, title, purpose, successCriteria, contract_name, status, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`),
    convById: db.prepare("SELECT * FROM conversations WHERE id = ?"),
    convsByChannel: db.prepare(
      "SELECT * FROM conversations WHERE channel = ? ORDER BY createdAt DESC"
    ),
    convsByChannelStatus: db.prepare(
      "SELECT * FROM conversations WHERE channel = ? AND status = ? ORDER BY createdAt DESC"
    ),
    latestOpenConv: db.prepare(
      "SELECT * FROM conversations WHERE channel = ? AND status = 'open' ORDER BY createdAt DESC LIMIT 1"
    ),
    closeConv: db.prepare(
      "UPDATE conversations SET status = 'closed', closedAt = ?, closedBy = ?, closedOutcome = ? WHERE id = ?"
    ),
    updConvContract: db.prepare("UPDATE conversations SET contract_name = ? WHERE id = ?"),
    delConvsOfChannel: db.prepare("DELETE FROM conversations WHERE channel = ?"),

    /* messages (keyed by conversation_id) */
    insMsg: db.prepare(`INSERT INTO messages
      (id, conversation_id, channel, from_agent, content, to_json, data_json, schema_json, contract, createdAt, status, review_json, approvedAt, rejectedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    msgById: db.prepare("SELECT * FROM messages WHERE id = ?"),
    updApprove: db.prepare("UPDATE messages SET status = 'delivered', approvedAt = ?, review_json = ? WHERE id = ?"),
    updReject: db.prepare("UPDATE messages SET status = 'rejected', rejectedAt = ?, review_json = ? WHERE id = ?"),
    updReview: db.prepare("UPDATE messages SET review_json = ? WHERE id = ?"),
    deliveredSinceConv: db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND status = 'delivered' AND createdAt > ? ORDER BY createdAt"
    ),
    unreadStmt: db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND status = 'delivered' AND createdAt > ? AND from_agent != ? ORDER BY createdAt"
    ),
    countDeliveredConv: db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND status = 'delivered'"
    ),
    countDeliveredChannel: db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE channel = ? AND status = 'delivered'"
    ),
    pending: db.prepare("SELECT * FROM messages WHERE status = 'pending' ORDER BY createdAt"),
    delMsgsOfChannel: db.prepare("DELETE FROM messages WHERE channel = ?"),
    delMsgsOfConv: db.prepare("DELETE FROM messages WHERE conversation_id = ?"),

    /* read cursors (per-agent, per-conversation) */
    getCursor: db.prepare("SELECT lastReadAt FROM read_cursors WHERE agent = ? AND conversation_id = ?"),
    setCursor: db.prepare(`INSERT INTO read_cursors(agent, conversation_id, lastReadAt) VALUES(?, ?, ?)
      ON CONFLICT(agent, conversation_id) DO UPDATE SET lastReadAt = excluded.lastReadAt`),
    delCursorsOfConv: db.prepare("DELETE FROM read_cursors WHERE conversation_id = ?"),
    delCursorsOfChannel: db.prepare(
      "DELETE FROM read_cursors WHERE conversation_id IN (SELECT id FROM conversations WHERE channel = ?)"
    ),

    /* conversation state doc */
    getState: db.prepare(
      "SELECT content, updatedAt, updatedBy FROM conversation_state WHERE conversation_id = ?"
    ),
    setState: db.prepare(`INSERT INTO conversation_state(conversation_id, content, updatedAt, updatedBy)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`),
    delStateOfConv: db.prepare("DELETE FROM conversation_state WHERE conversation_id = ?"),
    delStateOfChannel: db.prepare(
      "DELETE FROM conversation_state WHERE conversation_id IN (SELECT id FROM conversations WHERE channel = ?)"
    ),
  };

  /** Long-poll waiters for agent_wait (in-memory; transient). */
  const waiters = new Set();

  /** Supervision mode (in-memory; persisted via config.js, restored on boot). */
  let mode = "manual";

  function rowToMessage(r) {
    if (!r) return null;
    const msg = {
      id: r.id,
      conversationId: r.conversation_id,
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

  function rowToConversation(r) {
    if (!r) return null;
    const c = {
      id: r.id,
      channel: r.channel,
      title: r.title,
      purpose: r.purpose ?? null,
      successCriteria: r.successCriteria ?? null,
      contract_name: r.contract_name ?? null,
      status: r.status,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
    };
    if (r.closedAt != null) {
      c.closedAt = r.closedAt;
      c.closedBy = r.closedBy;
      c.closedOutcome = r.closedOutcome ?? null;
    }
    return c;
  }

  function publicChannel(name) {
    return {
      name,
      members: q.membersOf.all(name).map((r) => r.agent),
      messageCount: q.countDeliveredChannel.get(name).n,
    };
  }

  function ensureChannel(name) {
    q.insChannel.run(name, Date.now());
  }

  function unreadFor(agent, conversationId) {
    const cursor = q.getCursor.get(agent, conversationId)?.lastReadAt ?? 0;
    return q.unreadStmt.all(conversationId, cursor, agent).map(rowToMessage);
  }

  function computeInbox(agent) {
    const items = [];
    let total = 0;
    let mentioned = 0;
    for (const { channel } of q.memberChannels.all(agent)) {
      const openConvs = q.convsByChannelStatus.all(channel, "open");
      for (const cRow of openConvs) {
        const unread = unreadFor(agent, cRow.id);
        if (unread.length === 0) continue;
        const mine = unread.filter((m) => m.to.includes(agent)).length;
        const last = unread[unread.length - 1];
        items.push({
          channel,
          conversationId: cRow.id,
          conversationTitle: cRow.title,
          unread: unread.length,
          mentioned: mine,
          lastFrom: last.from,
          lastPreview: last.content.length > 80 ? last.content.slice(0, 80) + "…" : last.content,
        });
        total += unread.length;
        mentioned += mine;
      }
    }
    return { total, mentioned, channels: items };
  }

  /** Resolve any waiter that matches a freshly delivered message. */
  function notifyWaiters(msg) {
    for (const w of [...waiters]) {
      if (msg.from === w.agent) continue;
      if (w.conversationId) {
        if (w.conversationId !== msg.conversationId) continue;
      } else if (w.channel) {
        if (w.channel !== msg.channel) continue;
      } else if (!q.isMember.get(msg.channel, w.agent)) {
        continue;
      }
      waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve([msg]);
    }
  }

  function ensureDefaultDmConversation(channel) {
    if (!channel.startsWith("dm:")) return null;
    const open = q.latestOpenConv.get(channel);
    if (open) return rowToConversation(open);
    const id = randomUUID();
    const now = Date.now();
    const parts = channel.slice(3).split("+");
    const purpose = parts.length === 2 ? `1:1 between ${parts[0]} and ${parts[1]}` : null;
    q.insConv.run(id, channel, "direct", purpose, null, null, now, "system");
    return rowToConversation(q.convById.get(id));
  }

  return {
    /* agents + identity */
    registerAgent(name, token) {
      const now = Date.now();
      const existing = q.agentByName.get(name);
      if (existing) {
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
    dmChannelName(a, b) {
      return "dm:" + [a, b].sort().join("+");
    },
    createChannel(name) {
      ensureChannel(name);
      return publicChannel(name);
    },
    /** Delete a whole channel and everything keyed on it: conversations + their
     *  state docs + messages + members + cursors. Channel-bound waiters resolve
     *  empty so their long-polls don't leak. Returns false if it didn't exist. */
    deleteChannel(name) {
      if (!q.hasChannel.get(name)) return false;
      q.delCursorsOfChannel.run(name);
      q.delStateOfChannel.run(name);
      q.delMsgsOfChannel.run(name);
      q.delConvsOfChannel.run(name);
      q.delMembersOfChannel.run(name);
      q.delChannel.run(name);
      for (const w of [...waiters]) {
        if (w.channel !== name) continue;
        clearTimeout(w.timer);
        waiters.delete(w);
        w.resolve([]);
      }
      return true;
    },

    /* conversations (threads inside a channel) */
    createConversation({
      channel,
      title,
      purpose = null,
      successCriteria = null,
      contractName = null,
      createdBy,
    }) {
      ensureChannel(channel);
      const id = randomUUID();
      q.insConv.run(id, channel, title, purpose, successCriteria, contractName, Date.now(), createdBy);
      return rowToConversation(q.convById.get(id));
    },
    getConversation(id) {
      return rowToConversation(q.convById.get(id));
    },
    listConversations(channel, status = null) {
      const rows = status
        ? q.convsByChannelStatus.all(channel, status)
        : q.convsByChannel.all(channel);
      return rows.map(rowToConversation);
    },
    closeConversation(id, { closedBy, outcome = null } = {}) {
      const row = q.convById.get(id);
      if (!row || row.status !== "open") return null;
      q.closeConv.run(Date.now(), closedBy ?? "system", outcome, id);
      return rowToConversation(q.convById.get(id));
    },
    /** Set or clear the active named contract on a conversation. */
    setConversationContract(id, contractName) {
      const row = q.convById.get(id);
      if (!row) return null;
      q.updConvContract.run(contractName ?? null, id);
      return rowToConversation(q.convById.get(id));
    },
    latestOpenConversation(channel) {
      const row = q.latestOpenConv.get(channel);
      return row ? rowToConversation(row) : null;
    },
    /** For DMs: auto-create a single default conversation that lives forever. */
    ensureDmConversation(channel) {
      return ensureDefaultDmConversation(channel);
    },

    /* messages */
    postMessage({ conversationId, from, content, to = [], data = null, schema = null, contract = null }) {
      const conv = q.convById.get(conversationId);
      if (!conv) throw new Error(`unknown conversation: ${conversationId}`);
      if (conv.status !== "open") throw new Error(`conversation is closed: ${conversationId}`);
      ensureChannel(conv.channel);
      q.insMember.run(conv.channel, from);
      for (const m of to) q.insMember.run(conv.channel, m);
      // DSP safety axiom: a message declaring `decision_type: "IRREVERSIBLE"`
      // is forced to `pending` regardless of supervision mode — no level of
      // confidence authorizes autonomous execution of an irreversible action.
      const forceQueue = data != null && data.decision_type === "IRREVERSIBLE";
      const status = forceQueue ? "pending" : (mode === "auto" ? "delivered" : "pending");
      const msg = {
        id: randomUUID(),
        conversationId,
        channel: conv.channel,
        from,
        content,
        to,
        data,
        schema,
        contract,
        createdAt: Date.now(),
        status,
      };
      q.insMsg.run(
        msg.id, conversationId, conv.channel, from, content,
        JSON.stringify(to),
        data != null ? JSON.stringify(data) : null,
        schema != null ? JSON.stringify(schema) : null,
        contract,
        msg.createdAt, msg.status, null, null, null
      );
      if (msg.status === "delivered") notifyWaiters(msg);
      return msg;
    },
    readMessages({ conversationId, since = 0 }) {
      return q.deliveredSinceConv.all(conversationId, since).map(rowToMessage);
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
    markEscalated(id, reason) {
      const row = q.msgById.get(id);
      if (!row || row.status !== "pending") return null;
      q.updReview.run(JSON.stringify({ decision: "escalate", reason, at: Date.now() }), id);
      return rowToMessage(q.msgById.get(id));
    },

    /* read cursors + inbox + wait (per-conversation) */
    markRead(agent, conversationId) {
      const unread = unreadFor(agent, conversationId).length;
      q.setCursor.run(agent, conversationId, Date.now());
      return unread;
    },
    inboxFor(agent) {
      return computeInbox(agent);
    },
    unreadCount(agent) {
      return computeInbox(agent).total;
    },
    waitForMessage({ agent, conversationId = null, channel = null, timeoutMs = 25000 }) {
      // If a specific conversation is named, drain immediately if there is unread.
      const immediate = conversationId ? unreadFor(agent, conversationId) : null;
      if (immediate && immediate.length) return Promise.resolve(immediate);
      return new Promise((resolve) => {
        const w = { agent, conversationId, channel, resolve, timer: null };
        w.timer = setTimeout(() => {
          waiters.delete(w);
          resolve([]);
        }, timeoutMs);
        waiters.add(w);
      });
    },

    /* conversation state doc (the loop's PROGRESS.md) */
    getConversationState(conversationId) {
      const r = q.getState.get(conversationId);
      if (!r) return null;
      return {
        conversationId,
        content: r.content,
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy,
      };
    },
    setConversationState(conversationId, content, agent) {
      const conv = q.convById.get(conversationId);
      if (!conv) throw new Error(`unknown conversation: ${conversationId}`);
      // Real agents become members of the channel; the human "supervisor"
      // sentinel does not (it isn't a registered agent).
      if (q.agentByName.get(agent)) q.insMember.run(conv.channel, agent);
      const updatedAt = Date.now();
      q.setState.run(conversationId, content, updatedAt, agent);
      return { conversationId, content, updatedAt, updatedBy: agent };
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

    /** Schema version (exposed for diagnostics/tests). */
    schemaVersion() {
      return db.prepare("PRAGMA user_version").get().user_version;
    },

    /** Close the underlying database (for tests / graceful shutdown). */
    close() {
      db.close();
    },
  };
}

/* ------------------------------------------------------------------ schema */

function ensureSchema(db) {
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  if (userVersion >= SCHEMA_VERSION) return;

  const hasMessages = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
  ).get();

  if (!hasMessages) {
    // Fresh DB → build the latest schema directly.
    createLatestSchema(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    return;
  }

  // Walk migrations forward. Each is idempotent and only applies if the schema
  // is still at the prior version on disk.
  if (userVersion < 2) migrateV1toV2(db);
  if (userVersion < 3) migrateV2toV3(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

function createLatestSchema(db) {
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
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      purpose TEXT,
      successCriteria TEXT,
      contract_name TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      createdAt INTEGER NOT NULL,
      createdBy TEXT NOT NULL,
      closedAt INTEGER,
      closedBy TEXT,
      closedOutcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations (channel, status, createdAt);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, status, createdAt);
    CREATE TABLE IF NOT EXISTS read_cursors (
      agent TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      lastReadAt INTEGER NOT NULL,
      PRIMARY KEY (agent, conversation_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_state (
      conversation_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      updatedBy TEXT NOT NULL
    );
  `);
}

/** v1 → v2 (introduced in v3.0.0): flat-channel DB gains conversations.
 *  Each existing channel gets a "default" open conversation that absorbs its
 *  messages, read cursors, and (if present) v2.8.0 channel-level state doc. */
function migrateV1toV2(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      purpose TEXT,
      successCriteria TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      createdAt INTEGER NOT NULL,
      createdBy TEXT NOT NULL,
      closedAt INTEGER,
      closedBy TEXT,
      closedOutcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations (channel, status, createdAt);
    CREATE TABLE IF NOT EXISTS conversation_state (
      conversation_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      updatedBy TEXT NOT NULL
    );
  `);

  const channels = db.prepare("SELECT name, createdAt FROM channels").all();
  const insertConv = db.prepare(`INSERT INTO conversations
    (id, channel, title, purpose, successCriteria, status, createdAt, createdBy)
    VALUES (?, ?, 'default', ?, NULL, 'open', ?, 'system')`);
  const channelToConv = new Map();
  for (const ch of channels) {
    const convId = randomUUID();
    const purpose = ch.name.startsWith("dm:")
      ? (() => {
          const parts = ch.name.slice(3).split("+");
          return parts.length === 2 ? `1:1 between ${parts[0]} and ${parts[1]}` : null;
        })()
      : "migrated from a v2.x channel — kept for history";
    insertConv.run(convId, ch.name, purpose, ch.createdAt);
    channelToConv.set(ch.name, convId);
  }

  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  if (!msgCols.includes("conversation_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN conversation_id TEXT");
  }
  const updMsg = db.prepare("UPDATE messages SET conversation_id = ? WHERE channel = ? AND conversation_id IS NULL");
  for (const [channel, convId] of channelToConv) updMsg.run(convId, channel);
  db.exec(`DROP INDEX IF EXISTS idx_messages_channel;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, status, createdAt);`);

  const hasOldCursors = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='read_cursors'"
  ).get();
  if (hasOldCursors) {
    const cursorCols = db.prepare("PRAGMA table_info(read_cursors)").all().map((c) => c.name);
    if (cursorCols.includes("channel") && !cursorCols.includes("conversation_id")) {
      db.exec(`CREATE TABLE read_cursors_new (
        agent TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        lastReadAt INTEGER NOT NULL,
        PRIMARY KEY (agent, conversation_id)
      );`);
      const oldCursors = db.prepare("SELECT agent, channel, lastReadAt FROM read_cursors").all();
      const insCursor = db.prepare(
        "INSERT OR IGNORE INTO read_cursors_new(agent, conversation_id, lastReadAt) VALUES(?, ?, ?)"
      );
      for (const c of oldCursors) {
        const convId = channelToConv.get(c.channel);
        if (convId) insCursor.run(c.agent, convId, c.lastReadAt);
      }
      db.exec(`DROP TABLE read_cursors; ALTER TABLE read_cursors_new RENAME TO read_cursors;`);
    }
  } else {
    db.exec(`CREATE TABLE read_cursors (
      agent TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      lastReadAt INTEGER NOT NULL,
      PRIMARY KEY (agent, conversation_id)
    );`);
  }

  const hasChannelState = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_state'"
  ).get();
  if (hasChannelState) {
    const states = db.prepare(
      "SELECT channel, content, updatedAt, updatedBy FROM channel_state"
    ).all();
    const insState = db.prepare(
      "INSERT INTO conversation_state(conversation_id, content, updatedAt, updatedBy) VALUES(?, ?, ?, ?)"
    );
    for (const s of states) {
      const convId = channelToConv.get(s.channel);
      if (convId) insState.run(convId, s.content, s.updatedAt, s.updatedBy);
    }
    db.exec("DROP TABLE channel_state");
  }
}

/** v2 → v3 (introduced in v3.1.0): conversations gain an optional
 *  `contract_name` for DSP-style per-conversation governance. */
function migrateV2toV3(db) {
  const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
  if (!convCols.includes("contract_name")) {
    db.exec("ALTER TABLE conversations ADD COLUMN contract_name TEXT");
  }
}

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} conversationId
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
