/**
 * SQLite-backed message + agent store (durable across relay restarts).
 *
 * Uses Node's built-in `node:sqlite` (no native build, no extra dependency).
 * Same closure-factory shape — routes/MCP talk to it through the documented
 * methods only.
 *
 * Persisted (schema v4 — conversations-only):
 *   - agents (+tokens)
 *   - conversations (the room itself: own members, own state doc, own message
 *     stream, optional `contract_name` for DSP-style governance, optional
 *     `dm_key` that makes a conversation a canonical 1:1 between two agents)
 *   - conversation_members (who belongs to a conversation)
 *   - messages (keyed by conversation_id)
 *   - read_cursors (per-agent, per-conversation)
 *   - conversation_state (the "PROGRESS.md" of each loop)
 *
 * Kept in-memory (transient): live `agent_wait` long-poll waiters, and the
 * supervision `mode` (which itself persists via config.js, restored on boot).
 *
 * Migration: PRAGMA user_version is the schema gate. Migrations are stacked
 * forward; old DBs walk v0/v1 → v2 → v3 → v4 in one boot, idempotent on reopen.
 * v3 → v4 collapses channels into conversations (each conversation inherits its
 * channel's members; DM channels become a `dm_key` on their conversation).
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./config.js";

const SCHEMA_VERSION = 5;

/* The PROGRESS.md skeleton seeded into every new conversation's state doc so it's
 * never blank: agents update this structure instead of facing an empty doc. */
export function initialStateDoc({ title, purpose, successCriteria } = {}) {
  const crit = (successCriteria || "").trim();
  return [
    "# Purpose",
    (purpose || title || "").trim() || "(describe what this loop is doing, in one sentence)",
    "",
    "# Success criteria",
    crit ? `- ${crit}` : "- (define the objective signal that ends this loop)",
    "",
    "# Done",
    "- (nothing yet)",
    "",
    "# In progress",
    "- (just started)",
    "",
    "# Next",
    "- (first step)",
    "",
    "# Blocked / Decisions",
    "- (none)",
    "",
  ].join("\n");
}

/** The canonical 1:1 key for a pair of agents (order-independent). */
export function dmKeyFor(a, b) {
  return [a, b].sort().join("+");
}

export function createStore({ dbPath = join(DEFAULT_CONFIG_DIR, "switchboard.db") } = {}) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");

  ensureSchema(db);

  // Self-heal: guarantee newer nullable columns exist even if a prior boot bumped
  // user_version without adding them (e.g. a dev migration interrupted mid-edit).
  {
    const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
    if (!convCols.includes("project_id")) {
      db.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id)");
    }
  }

  /* Prepared statements */
  const q = {
    /* agents */
    insAgent: db.prepare("INSERT INTO agents(name, token, registeredAt, lastSeenAt) VALUES(?, ?, ?, ?)"),
    agentByName: db.prepare("SELECT * FROM agents WHERE name = ?"),
    agentByToken: db.prepare("SELECT * FROM agents WHERE token = ?"),
    touchAgent: db.prepare("UPDATE agents SET lastSeenAt = ? WHERE name = ?"),
    allAgents: db.prepare("SELECT name, registeredAt, lastSeenAt FROM agents"),

    /* conversation membership */
    insMember: db.prepare("INSERT OR IGNORE INTO conversation_members(conversation_id, agent) VALUES(?, ?)"),
    delMember: db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND agent = ?"),
    membersOf: db.prepare("SELECT agent FROM conversation_members WHERE conversation_id = ? ORDER BY agent"),
    memberConvs: db.prepare("SELECT conversation_id FROM conversation_members WHERE agent = ?"),
    isMember: db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = ? AND agent = ?"),
    delMembersOfConv: db.prepare("DELETE FROM conversation_members WHERE conversation_id = ?"),

    /* conversations (the room) */
    insConv: db.prepare(`INSERT INTO conversations
      (id, title, purpose, successCriteria, contract_name, dm_key, project_id, status, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`),
    convById: db.prepare("SELECT * FROM conversations WHERE id = ?"),
    allConvs: db.prepare("SELECT * FROM conversations ORDER BY createdAt DESC"),
    allConvsByStatus: db.prepare("SELECT * FROM conversations WHERE status = ? ORDER BY createdAt DESC"),
    convByDmKey: db.prepare("SELECT * FROM conversations WHERE dm_key = ? ORDER BY createdAt DESC LIMIT 1"),
    closeConv: db.prepare(
      "UPDATE conversations SET status = 'closed', closedAt = ?, closedBy = ?, closedOutcome = ? WHERE id = ?"
    ),
    reopenConv: db.prepare(
      "UPDATE conversations SET status = 'open', closedAt = NULL, closedBy = NULL, closedOutcome = NULL WHERE id = ?"
    ),
    updConvContract: db.prepare("UPDATE conversations SET contract_name = ? WHERE id = ?"),
    delConv: db.prepare("DELETE FROM conversations WHERE id = ?"),

    /* messages (keyed by conversation_id) */
    insMsg: db.prepare(`INSERT INTO messages
      (id, conversation_id, from_agent, content, to_json, data_json, schema_json, contract, createdAt, status, review_json, approvedAt, rejectedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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
    pending: db.prepare("SELECT * FROM messages WHERE status = 'pending' ORDER BY createdAt"),
    delMsgsOfConv: db.prepare("DELETE FROM messages WHERE conversation_id = ?"),

    /* read cursors (per-agent, per-conversation) */
    getCursor: db.prepare("SELECT lastReadAt FROM read_cursors WHERE agent = ? AND conversation_id = ?"),
    setCursor: db.prepare(`INSERT INTO read_cursors(agent, conversation_id, lastReadAt) VALUES(?, ?, ?)
      ON CONFLICT(agent, conversation_id) DO UPDATE SET lastReadAt = excluded.lastReadAt`),
    delCursorsOfConv: db.prepare("DELETE FROM read_cursors WHERE conversation_id = ?"),

    /* conversation state doc */
    getState: db.prepare(
      "SELECT content, updatedAt, updatedBy FROM conversation_state WHERE conversation_id = ?"
    ),
    setState: db.prepare(`INSERT INTO conversation_state(conversation_id, content, updatedAt, updatedBy)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET content = excluded.content, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy`),
    delStateOfConv: db.prepare("DELETE FROM conversation_state WHERE conversation_id = ?"),
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
      title: r.title,
      purpose: r.purpose ?? null,
      successCriteria: r.successCriteria ?? null,
      contract_name: r.contract_name ?? null,
      dmKey: r.dm_key ?? null,
      isDm: Boolean(r.dm_key),
      projectId: r.project_id ?? null,
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

  /** A conversation enriched with its members + delivered message count — the
   *  shape every public method returns so the UI/MCP always see members. */
  function publicConversation(row) {
    if (!row) return null;
    const c = rowToConversation(row);
    c.members = q.membersOf.all(row.id).map((r) => r.agent);
    c.messageCount = q.countDeliveredConv.get(row.id).n;
    return c;
  }

  /** Add an agent to a conversation, but never the "master" supervisor sentinel
   *  (no token, not a persistent member) nor unknown names. */
  function addMember(conversationId, agent) {
    if (!agent || agent === "master") return;
    if (!q.agentByName.get(agent)) return;
    q.insMember.run(conversationId, agent);
  }

  function unreadFor(agent, conversationId) {
    const cursor = q.getCursor.get(agent, conversationId)?.lastReadAt ?? 0;
    return q.unreadStmt.all(conversationId, cursor, agent).map(rowToMessage);
  }

  function computeInbox(agent) {
    const items = [];
    let total = 0;
    let mentioned = 0;
    for (const { conversation_id } of q.memberConvs.all(agent)) {
      const row = q.convById.get(conversation_id);
      if (!row || row.status !== "open") continue;
      const unread = unreadFor(agent, conversation_id);
      if (unread.length === 0) continue;
      const mine = unread.filter((m) => m.to.includes(agent)).length;
      const last = unread[unread.length - 1];
      items.push({
        conversationId: row.id,
        conversationTitle: row.title,
        unread: unread.length,
        mentioned: mine,
        lastFrom: last.from,
        lastPreview: last.content.length > 80 ? last.content.slice(0, 80) + "…" : last.content,
      });
      total += unread.length;
      mentioned += mine;
    }
    return { total, mentioned, conversations: items };
  }

  /** Resolve any waiter that matches a freshly delivered message. */
  function notifyWaiters(msg) {
    for (const w of [...waiters]) {
      if (msg.from === w.agent) continue;
      if (w.conversationId) {
        if (w.conversationId !== msg.conversationId) continue;
      } else if (!q.isMember.get(msg.conversationId, w.agent)) {
        continue;
      }
      waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve([msg]);
    }
  }

  function createConversationRow({
    title,
    purpose = null,
    successCriteria = null,
    contractName = null,
    dmKey = null,
    projectId = null,
    createdBy,
    members = [],
  }) {
    const id = randomUUID();
    const now = Date.now();
    q.insConv.run(id, title, purpose, successCriteria, contractName, dmKey, projectId, now, createdBy ?? "system");
    q.setState.run(id, initialStateDoc({ title, purpose, successCriteria }), now, createdBy ?? "system");
    addMember(id, createdBy);
    for (const m of members) addMember(id, m);
    return publicConversation(q.convById.get(id));
  }

  // One-time backfill: older conversations (created before state-doc seeding, or
  // via paths that bypassed it) have no state row — give them the skeleton so the
  // doc is never blank. Idempotent: after the first boot there's nothing missing.
  {
    const missing = db
      .prepare(
        "SELECT c.id, c.title, c.purpose, c.successCriteria FROM conversations c " +
          "LEFT JOIN conversation_state s ON s.conversation_id = c.id WHERE s.conversation_id IS NULL"
      )
      .all();
    const now = Date.now();
    for (const c of missing) {
      q.setState.run(c.id, initialStateDoc(c), now, "system");
    }
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

    /* conversations (the room) + membership */
    createConversation({
      title,
      purpose = null,
      successCriteria = null,
      contractName = null,
      projectId = null,
      createdBy,
      members = [],
    }) {
      return createConversationRow({ title, purpose, successCriteria, contractName, projectId, createdBy, members });
    },
    getConversation(id) {
      return publicConversation(q.convById.get(id));
    },
    listConversations(status = null) {
      const rows = status ? q.allConvsByStatus.all(status) : q.allConvs.all();
      return rows.map(publicConversation);
    },
    closeConversation(id, { closedBy, outcome = null } = {}) {
      const row = q.convById.get(id);
      if (!row || row.status !== "open") return null;
      q.closeConv.run(Date.now(), closedBy ?? "system", outcome, id);
      return publicConversation(q.convById.get(id));
    },
    /** Set or clear the active named contract on a conversation. */
    setConversationContract(id, contractName) {
      const row = q.convById.get(id);
      if (!row) return null;
      q.updConvContract.run(contractName ?? null, id);
      return publicConversation(q.convById.get(id));
    },
    joinConversation(id, agent) {
      const row = q.convById.get(id);
      if (!row) return null;
      addMember(id, agent);
      return publicConversation(q.convById.get(id));
    },
    leaveConversation(id, agent) {
      const row = q.convById.get(id);
      if (!row) return null;
      q.delMember.run(id, agent);
      return publicConversation(q.convById.get(id));
    },
    conversationMembers(id) {
      if (!q.convById.get(id)) return [];
      return q.membersOf.all(id).map((r) => r.agent);
    },
    /** The canonical 1:1 conversation for a pair — created on first DM, kept
     *  forever (reopened if it had been closed), both agents auto-joined. */
    ensureDmConversation(a, b) {
      const key = dmKeyFor(a, b);
      const existing = q.convByDmKey.get(key);
      if (existing) {
        if (existing.status !== "open") q.reopenConv.run(existing.id);
        addMember(existing.id, a);
        addMember(existing.id, b);
        return publicConversation(q.convById.get(existing.id));
      }
      return createConversationRow({
        title: `${a} ↔ ${b}`,
        purpose: `1:1 between ${a} and ${b}`,
        dmKey: key,
        createdBy: a,
        members: [a, b],
      });
    },
    /** Delete a conversation and everything keyed on it: state doc, messages,
     *  members, cursors. Waiters scoped to it resolve empty so long-polls don't
     *  leak. Returns false if it didn't exist. */
    deleteConversation(id) {
      if (!q.convById.get(id)) return false;
      q.delCursorsOfConv.run(id);
      q.delStateOfConv.run(id);
      q.delMsgsOfConv.run(id);
      q.delMembersOfConv.run(id);
      q.delConv.run(id);
      for (const w of [...waiters]) {
        if (w.conversationId !== id) continue;
        clearTimeout(w.timer);
        waiters.delete(w);
        w.resolve([]);
      }
      return true;
    },

    /* messages */
    postMessage({ conversationId, from, content, to = [], data = null, schema = null, contract = null }) {
      const conv = q.convById.get(conversationId);
      if (!conv) throw new Error(`unknown conversation: ${conversationId}`);
      if (conv.status !== "open") throw new Error(`conversation is closed: ${conversationId}`);
      // Posting auto-joins the sender and any addressed agents (never "master").
      addMember(conversationId, from);
      for (const m of to) addMember(conversationId, m);
      // DSP safety axiom: a message declaring `decision_type: "IRREVERSIBLE"`
      // is forced to `pending` regardless of supervision mode — no level of
      // confidence authorizes autonomous execution of an irreversible action.
      const forceQueue = data != null && data.decision_type === "IRREVERSIBLE";
      const status = forceQueue ? "pending" : (mode === "auto" ? "delivered" : "pending");
      const msg = {
        id: randomUUID(),
        conversationId,
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
        msg.id, conversationId, from, content,
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
    waitForMessage({ agent, conversationId = null, timeoutMs = 25000 }) {
      // If a specific conversation is named, drain immediately if there is unread.
      const immediate = conversationId ? unreadFor(agent, conversationId) : null;
      if (immediate && immediate.length) return Promise.resolve(immediate);
      return new Promise((resolve) => {
        const w = { agent, conversationId, resolve, timer: null };
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
      // Real agents writing the doc become members; the human "supervisor"
      // sentinel does not (it isn't a registered agent).
      addMember(conversationId, agent);
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
  if (userVersion < 4) migrateV3toV4(db);
  if (userVersion < 5) migrateV4toV5(db);
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
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      purpose TEXT,
      successCriteria TEXT,
      contract_name TEXT,
      dm_key TEXT,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      createdAt INTEGER NOT NULL,
      createdBy TEXT NOT NULL,
      closedAt INTEGER,
      closedBy TEXT,
      closedOutcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_conversations_dmkey ON conversations (dm_key);
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id);
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      PRIMARY KEY (conversation_id, agent)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_members_agent ON conversation_members (agent);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
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

/** v1 → v2 (introduced in v2.8.0): flat-channel DB gains conversations.
 *  Each existing channel gets a "default" open conversation that absorbs its
 *  messages, read cursors, and (if present) the earlier channel-level state doc. */
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

/** v2 → v3 (introduced in v2.8.0): conversations gain an optional
 *  `contract_name` for DSP-style per-conversation governance. */
function migrateV2toV3(db) {
  const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
  if (!convCols.includes("contract_name")) {
    db.exec("ALTER TABLE conversations ADD COLUMN contract_name TEXT");
  }
}

/** v3 → v4 (conversations-only): channels collapse into conversations. Each
 *  conversation gets its own members (inherited from the channel it lived in)
 *  and an optional `dm_key` (the canonical 1:1 pair, taken from `dm:a+b`
 *  channels). The channels / channel_members tables and the `channel` columns
 *  are dropped. Idempotent on reopen. */
function migrateV3toV4(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    PRIMARY KEY (conversation_id, agent)
  );`);

  // Inherit membership from the owning channel (skip if channel_members is gone
  // because a prior partial run already migrated).
  const hasChannelMembers = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_members'"
  ).get();
  if (hasChannelMembers) {
    db.exec(`INSERT OR IGNORE INTO conversation_members(conversation_id, agent)
      SELECT c.id, m.agent FROM conversations c
      JOIN channel_members m ON m.channel = c.channel;`);
  }

  const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
  if (!convCols.includes("dm_key")) {
    db.exec("ALTER TABLE conversations ADD COLUMN dm_key TEXT");
  }
  if (convCols.includes("channel")) {
    db.exec("UPDATE conversations SET dm_key = substr(channel, 4) WHERE channel LIKE 'dm:%' AND (dm_key IS NULL OR dm_key = '')");
    // Give migrated channel-default conversations a recognizable title.
    db.exec("UPDATE conversations SET title = channel WHERE title = 'default' AND channel NOT LIKE 'dm:%'");
    db.exec("UPDATE conversations SET title = replace(substr(channel, 4), '+', ' <-> ') WHERE title IN ('direct','default') AND channel LIKE 'dm:%'");
    // Drop channel coupling: index + columns (SQLite ≥ 3.35 supports DROP COLUMN).
    db.exec("DROP INDEX IF EXISTS idx_conversations_channel");
    db.exec("ALTER TABLE conversations DROP COLUMN channel");
  }
  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  if (msgCols.includes("channel")) {
    db.exec("ALTER TABLE messages DROP COLUMN channel");
  }

  db.exec("DROP TABLE IF EXISTS channel_members");
  db.exec("DROP TABLE IF EXISTS channels");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conv_members_agent ON conversation_members (agent)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_dmkey ON conversations (dm_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (status, createdAt)");
}

/** v4 → v5 (conversations-only refinement): conversations gain an optional
 *  `project_id` linking them to a project (the new top-level grouping that
 *  replaced channels). Idempotent on reopen. */
function migrateV4toV5(db) {
  const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
  if (!convCols.includes("project_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN project_id TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id)");
}

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} conversationId
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
