/**
 * In-memory message + agent store. v1: lost on restart.
 * Future: swap for SQLite-backed implementation with the same interface.
 */
import { randomUUID } from "node:crypto";

export function createStore() {
  /** @type {Map<string, {name: string, token: string, registeredAt: number, lastSeenAt: number}>} */
  const agents = new Map();

  /** @type {Map<string, Channel>} */
  const channels = new Map();

  /** Pending messages awaiting human approval (when approval mode is on). */
  /** @type {Map<string, Message>} */
  const pending = new Map();

  /** Per-agent read cursor per channel: agent -> (channel -> lastReadAt ms). */
  /** @type {Map<string, Map<string, number>>} */
  const readCursors = new Map();

  /** Long-poll waiters for agent_wait. */
  /** @type {Set<{agent: string, channel: string|null, resolve: Function, timer: any}>} */
  const waiters = new Set();

  /** Supervision mode (global): how posted messages are gated.
   *   - "manual": every message is held pending until a human approves it.
   *   - "auto":   every message is delivered immediately (no supervision).
   *   - "llm":    held pending, then an LLM reviewer approves/rejects/escalates;
   *               escalations stay pending for the human.
   *  Default "manual" (supervision-first). manual/auto never invoke the LLM. */
  let mode = "manual";

  function getChannel(name, create = true) {
    if (!channels.has(name) && create) {
      channels.set(name, { name, messages: [], members: new Set(), createdAt: Date.now() });
    }
    return channels.get(name);
  }

  function cursorsFor(agent) {
    if (!readCursors.has(agent)) readCursors.set(agent, new Map());
    return readCursors.get(agent);
  }

  function unreadFor(agent, channelName) {
    const ch = channels.get(channelName);
    if (!ch) return [];
    const cursor = cursorsFor(agent).get(channelName) ?? 0;
    return ch.messages.filter((m) => m.createdAt > cursor && m.from !== agent);
  }

  function computeInbox(agent) {
    const items = [];
    let total = 0;
    let mentioned = 0;
    for (const ch of channels.values()) {
      if (!ch.members.has(agent)) continue;
      const unread = unreadFor(agent, ch.name);
      if (unread.length === 0) continue;
      const mine = unread.filter((m) => Array.isArray(m.to) && m.to.includes(agent)).length;
      const last = unread[unread.length - 1];
      items.push({
        channel: ch.name,
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
      } else {
        const ch = channels.get(msg.channel);
        if (!ch || !ch.members.has(w.agent)) continue;
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
      const existing = agents.get(name);
      if (existing) {
        // Name already claimed — only the holder of its token may re-register.
        if (token && token === existing.token) {
          existing.lastSeenAt = now;
          return existing;
        }
        return null;
      }
      const agent = { name, token: randomUUID(), registeredAt: now, lastSeenAt: now };
      agents.set(name, agent);
      return agent;
    },
    verifyToken(token) {
      if (!token) return null;
      for (const a of agents.values()) {
        if (a.token === token) {
          a.lastSeenAt = Date.now();
          return a;
        }
      }
      return null;
    },
    hasAgent(name) {
      return agents.has(name);
    },
    listAgents() {
      // Never leak tokens over the API.
      return [...agents.values()].map(({ name, registeredAt, lastSeenAt }) => ({
        name,
        registeredAt,
        lastSeenAt,
      }));
    },
    touchAgent(name) {
      const a = agents.get(name);
      if (a) a.lastSeenAt = Date.now();
    },

    /* channels + membership */
    joinChannel(name, agent) {
      const ch = getChannel(name);
      ch.members.add(agent);
      return { name: ch.name, members: [...ch.members], messageCount: ch.messages.length };
    },
    leaveChannel(name, agent) {
      const ch = getChannel(name, false);
      if (!ch) return null;
      ch.members.delete(agent);
      return { name: ch.name, members: [...ch.members], messageCount: ch.messages.length };
    },
    listChannels() {
      return [...channels.values()].map((ch) => ({
        name: ch.name,
        members: [...ch.members],
        messageCount: ch.messages.length,
      }));
    },
    channelMembers(name) {
      const ch = getChannel(name, false);
      return ch ? [...ch.members] : [];
    },
    dmChannelName(a, b) {
      return "dm:" + [a, b].sort().join("+");
    },

    /* messages */
    postMessage({ channel, from, content, to = [], data = null, schema = null, contract = null }) {
      const ch = getChannel(channel);
      ch.members.add(from); // sender is implicitly a member
      for (const m of to) ch.members.add(m); // tagged agents join the channel
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
      if (msg.status === "pending") {
        pending.set(msg.id, msg);
      } else {
        ch.messages.push(msg);
        notifyWaiters(msg);
      }
      return msg;
    },
    readMessages({ channel, since = 0 }) {
      const ch = getChannel(channel, false);
      if (!ch) return [];
      return ch.messages.filter((m) => m.createdAt > since);
    },
    listPending() {
      return [...pending.values()];
    },
    approvePending(id, review = null) {
      const msg = pending.get(id);
      if (!msg) return null;
      msg.status = "delivered";
      msg.approvedAt = Date.now();
      if (review) msg.review = review;
      pending.delete(id);
      getChannel(msg.channel).messages.push(msg);
      notifyWaiters(msg);
      return msg;
    },
    rejectPending(id, review = null) {
      const msg = pending.get(id);
      if (!msg) return null;
      msg.status = "rejected";
      msg.rejectedAt = Date.now();
      if (review) msg.review = review;
      pending.delete(id);
      return msg;
    },
    /** Reviewer escalated to a human: annotate but leave it pending. */
    markEscalated(id, reason) {
      const msg = pending.get(id);
      if (!msg) return null;
      msg.review = { decision: "escalate", reason, at: Date.now() };
      return msg;
    },

    /* read cursors + inbox + wait */
    markRead(agent, channel) {
      const unread = unreadFor(agent, channel);
      cursorsFor(agent).set(channel, Date.now());
      return unread.length;
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
  };
}

/**
 * @typedef {Object} Channel
 * @property {string} name
 * @property {Message[]} messages
 * @property {Set<string>} members
 * @property {number} createdAt
 */

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
