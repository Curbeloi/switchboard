/**
 * In-memory message + agent store. v0.1: lost on restart.
 * Future: swap for SQLite-backed implementation with the same interface.
 */
import { randomUUID } from "node:crypto";

export function createStore() {
  /** @type {Map<string, {name: string, registeredAt: number, lastSeenAt: number}>} */
  const agents = new Map();

  /** @type {Map<string, Array<Message>>} */
  const channels = new Map();

  /** Pending messages awaiting human approval (when approval mode is on). */
  /** @type {Map<string, Message>} */
  const pending = new Map();

  /** Approval mode toggle (global; per-channel could be a v0.2 improvement).
   *  Default ON: every message is held until a human approves it via the
   *  console supervisor or the web UI. Pass --auto to the CLI to start with
   *  it off. */
  let approvalMode = true;

  function getChannel(name) {
    if (!channels.has(name)) channels.set(name, []);
    return channels.get(name);
  }

  return {
    /* agents */
    registerAgent(name) {
      const now = Date.now();
      if (agents.has(name)) {
        agents.get(name).lastSeenAt = now;
      } else {
        agents.set(name, { name, registeredAt: now, lastSeenAt: now });
      }
      return agents.get(name);
    },
    listAgents() {
      return [...agents.values()];
    },
    touchAgent(name) {
      if (agents.has(name)) agents.get(name).lastSeenAt = Date.now();
    },

    /* channels */
    listChannels() {
      return [...channels.keys()].map((name) => ({
        name,
        messageCount: channels.get(name).length,
      }));
    },

    /* messages */
    postMessage({ channel, from, content }) {
      const msg = {
        id: randomUUID(),
        channel,
        from,
        content,
        createdAt: Date.now(),
        status: approvalMode ? "pending" : "delivered",
      };
      if (msg.status === "pending") {
        pending.set(msg.id, msg);
      } else {
        getChannel(channel).push(msg);
      }
      return msg;
    },
    readMessages({ channel, since = 0 }) {
      return getChannel(channel).filter((m) => m.createdAt > since);
    },
    listPending() {
      return [...pending.values()];
    },
    approvePending(id) {
      const msg = pending.get(id);
      if (!msg) return null;
      msg.status = "delivered";
      msg.approvedAt = Date.now();
      pending.delete(id);
      getChannel(msg.channel).push(msg);
      return msg;
    },
    rejectPending(id) {
      const msg = pending.get(id);
      if (!msg) return null;
      msg.status = "rejected";
      msg.rejectedAt = Date.now();
      pending.delete(id);
      return msg;
    },

    /* approval-mode toggle */
    setApprovalMode(value) {
      approvalMode = Boolean(value);
      return approvalMode;
    },
    getApprovalMode() {
      return approvalMode;
    },
  };
}

/**
 * @typedef {Object} Message
 * @property {string} id
 * @property {string} channel
 * @property {string} from
 * @property {string} content
 * @property {number} createdAt
 * @property {"delivered" | "pending" | "rejected"} status
 * @property {number} [approvedAt]
 * @property {number} [rejectedAt]
 */
