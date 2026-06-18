import { Router } from "express";
import Ajv from "ajv";
import { DEFAULT_POLICY } from "../reviewer.js";

const ajv = new Ajv({ allErrors: true, strict: false });

/** Compile a JSON Schema, returning an error string or null if it's valid. */
function schemaError(schema) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return "schema must be a JSON Schema object";
  }
  try {
    ajv.compile(schema);
    return null;
  } catch (e) {
    return `invalid schema: ${e.message}`;
  }
}

const publicAgent = (a) => ({
  name: a.name,
  registeredAt: a.registeredAt,
  lastSeenAt: a.lastSeenAt,
});

const STATE_MAX_BYTES = 64 * 1024;

export function mountRoutes(app, { store, broadcast, reviewer = null, config = null }) {
  const api = Router();
  const reviewerAvailable = Boolean(reviewer?.available);
  const reviewerInfo = { available: reviewerAvailable, backend: reviewer?.backend ?? null };

  function requireAgent(req, res) {
    const auth = req.get("authorization");
    const token =
      req.get("x-switchboard-token") ||
      (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
    const agent = store.verifyToken(token);
    if (!agent) {
      res.status(401).json({ error: "valid agent token required" });
      return null;
    }
    return agent;
  }

  function optionalAgent(req) {
    const auth = req.get("authorization");
    const token =
      req.get("x-switchboard-token") ||
      (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
    return store.verifyToken(token);
  }

  /* Health */
  api.get("/health", (_req, res) => {
    res.json({ ok: true, mode: store.getMode(), reviewer: reviewerInfo });
  });

  /* Agents */
  api.post("/agents/register", (req, res) => {
    const { name, token } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name required (string)" });
    }
    const agent = store.registerAgent(name, token);
    if (!agent) {
      return res
        .status(409)
        .json({ error: `agent "${name}" already registered; provide its token to re-register` });
    }
    broadcast({ type: "agent.registered", agent: publicAgent(agent) });
    res.json({ name: agent.name, token: agent.token, registeredAt: agent.registeredAt });
  });
  api.get("/agents", (_req, res) => res.json(store.listAgents()));

  /* Channels */
  api.get("/channels", (_req, res) => res.json(store.listChannels()));

  api.post("/channels", (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name required (string)" });
    }
    const channel = store.createChannel(name);
    broadcast({ type: "channel.updated", channel });
    res.json(channel);
  });

  api.delete("/channels/:channel", (req, res) => {
    const name = req.params.channel;
    if (!store.deleteChannel(name)) {
      return res.status(404).json({ error: "channel not found" });
    }
    broadcast({ type: "channel.deleted", name });
    res.json({ ok: true });
  });

  api.post("/channels/:channel/join", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const result = store.joinChannel(req.params.channel, agent.name);
    broadcast({ type: "channel.updated", channel: result });
    res.json(result);
  });

  api.post("/channels/:channel/leave", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const result = store.leaveChannel(req.params.channel, agent.name);
    if (!result) return res.status(404).json({ error: "channel not found" });
    broadcast({ type: "channel.updated", channel: result });
    res.json(result);
  });

  /* Conversations (threads inside a channel) — every loop lives in one.
   * Either an agent (Bearer token) or a human supervisor (no token) can open
   * a conversation; the human is recorded as `createdBy: "supervisor"`. */
  api.post("/channels/:channel/conversations", (req, res) => {
    const agent = optionalAgent(req);
    const { title, purpose = null, successCriteria = null } = req.body ?? {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title required (string)" });
    }
    if (purpose != null && typeof purpose !== "string") {
      return res.status(400).json({ error: "purpose must be string when provided" });
    }
    if (successCriteria != null && typeof successCriteria !== "string") {
      return res.status(400).json({ error: "successCriteria must be string when provided" });
    }
    const createdBy = agent?.name ?? "supervisor";
    const conv = store.createConversation({
      channel: req.params.channel,
      title,
      purpose,
      successCriteria,
      createdBy,
    });
    if (agent) store.joinChannel(req.params.channel, agent.name);
    broadcast({ type: "conversation.created", conversation: conv });
    res.json(conv);
  });

  api.get("/channels/:channel/conversations", (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const filter = status && status !== "all" ? status : null;
    res.json(store.listConversations(req.params.channel, filter));
  });

  api.get("/conversations/:id", (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    res.json(conv);
  });

  api.post("/conversations/:id/close", (req, res) => {
    const agent = optionalAgent(req);
    const { outcome = null } = req.body ?? {};
    if (outcome != null && typeof outcome !== "string") {
      return res.status(400).json({ error: "outcome must be string when provided" });
    }
    const closedBy = agent?.name ?? "supervisor";
    const conv = store.closeConversation(req.params.id, { closedBy, outcome });
    if (!conv) return res.status(404).json({ error: "conversation not found or already closed" });
    broadcast({ type: "conversation.closed", conversation: conv });
    res.json(conv);
  });

  api.get("/conversations/:id/messages", (req, res) => {
    const conversationId = req.params.id;
    const conv = store.getConversation(conversationId);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    const since = Number(req.query.since ?? 0);
    const messages = store.readMessages({ conversationId, since });
    // Advance the read cursor only when a valid token is presented (an agent reading).
    const agent = optionalAgent(req);
    if (agent) {
      store.markRead(agent.name, conversationId);
      broadcast({
        type: "message.read",
        conversationId,
        channel: conv.channel,
        agent: agent.name,
        at: Date.now(),
      });
    }
    res.json(messages);
  });

  api.get("/conversations/:id/state", (req, res) => {
    const conversationId = req.params.id;
    if (!store.getConversation(conversationId)) {
      return res.status(404).json({ error: "conversation not found" });
    }
    const state = store.getConversationState(conversationId);
    res.json(state ?? { conversationId, content: "", updatedAt: null, updatedBy: null });
  });

  api.put("/conversations/:id/state", (req, res) => {
    const agent = optionalAgent(req);
    const conversationId = req.params.id;
    if (!store.getConversation(conversationId)) {
      return res.status(404).json({ error: "conversation not found" });
    }
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content required (string)" });
    }
    if (content.length > STATE_MAX_BYTES) {
      return res.status(413).json({ error: "state doc exceeds 64KB cap" });
    }
    const writer = agent?.name ?? "supervisor";
    const state = store.setConversationState(conversationId, content, writer);
    broadcast({
      type: "conversation.state.updated",
      conversationId: state.conversationId,
      updatedAt: state.updatedAt,
      updatedBy: state.updatedBy,
    });
    res.json(state);
  });

  /* Direct message: canonical 2-member channel; DMs use a perpetual default
   * conversation auto-created on first DM (so the 1:1 ergonomics are preserved). */
  api.post("/dm", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const { to, content } = req.body ?? {};
    if (!to || typeof to !== "string") {
      return res.status(400).json({ error: "to required (string)" });
    }
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content required (string)" });
    }
    const channel = store.dmChannelName(agent.name, to);
    store.joinChannel(channel, agent.name);
    const membership = store.joinChannel(channel, to);
    broadcast({ type: "channel.updated", channel: membership });
    const dmConv = store.ensureDmConversation(channel);
    const msg = store.postMessage({
      conversationId: dmConv.id,
      from: agent.name,
      content,
    });
    broadcast({
      type: msg.status === "pending" ? "message.pending" : "message.delivered",
      message: msg,
    });
    res.json(msg);
  });

  /* Messages — always inside a conversation. If `conversation` is omitted on a
   * regular channel post, the latest open conversation is used (409 if none). */
  api.post("/channels/:channel/messages", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const channel = req.params.channel;
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content required (string)" });
    }
    const rawTo = req.body?.to;
    const to = (Array.isArray(rawTo) ? rawTo : rawTo ? [rawTo] : [])
      .filter((n) => typeof n === "string" && n.length);
    const unknown = to.filter((n) => !store.hasAgent(n));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown agent(s) in 'to': ${unknown.join(", ")}` });
    }

    // Resolve the conversation: explicit > latest open > DM auto-create > 409.
    let conversationId = req.body?.conversation ?? null;
    let conv = null;
    if (conversationId) {
      conv = store.getConversation(conversationId);
      if (!conv || conv.channel !== channel) {
        return res.status(404).json({ error: "conversation not found in this channel" });
      }
      if (conv.status !== "open") {
        return res.status(400).json({ error: "conversation is closed" });
      }
    } else if (channel.startsWith("dm:")) {
      conv = store.ensureDmConversation(channel);
      conversationId = conv.id;
    } else {
      conv = store.latestOpenConversation(channel);
      if (!conv) {
        // Ergonomics: if the channel has never had a conversation, auto-create
        // a "default" so the first message doesn't fail. After that the agent
        // is expected to open conversations explicitly per task.
        const existing = store.listConversations(channel);
        if (existing.length === 0) {
          conv = store.createConversation({
            channel,
            title: "default",
            purpose: null,
            successCriteria: null,
            createdBy: agent.name,
          });
          broadcast({ type: "conversation.created", conversation: conv });
        } else {
          return res.status(409).json({
            error: "no open conversation in this channel — POST /api/channels/:c/conversations first",
          });
        }
      }
      conversationId = conv.id;
    }

    const data = req.body?.data ?? null;
    const contractName = req.body?.contract ?? null;
    let schema = req.body?.schema ?? null;
    if (contractName != null) {
      if (typeof contractName !== "string" || !config) {
        return res.status(400).json({ error: "contract must be a known contract name" });
      }
      const stored = config.getContract(contractName);
      if (!stored) {
        return res.status(400).json({ error: `unknown contract: ${contractName}` });
      }
      schema = stored;
    }
    if (schema != null) {
      const err = schemaError(schema);
      if (err) return res.status(400).json({ error: err });
      const validate = ajv.compile(schema);
      if (!validate(data)) {
        return res.status(400).json({
          error: "contract validation failed",
          details: validate.errors,
        });
      }
    }

    const msg = store.postMessage({
      conversationId,
      from: agent.name,
      content,
      to,
      data,
      schema,
      contract: contractName,
    });
    broadcast({
      type: msg.status === "pending" ? "message.pending" : "message.delivered",
      message: msg,
    });
    res.json(msg);
  });

  /* Deprecated routes (pre-v3 — messages and state doc lived on channels). */
  api.get("/channels/:channel/messages", (_req, res) => {
    res.status(410).json({
      error: "deprecated: use GET /api/channels/:c/conversations then GET /api/conversations/:id/messages",
    });
  });
  api.get("/channels/:channel/state", (_req, res) => {
    res.status(410).json({
      error: "deprecated: state docs moved to conversations. Use GET /api/conversations/:id/state",
    });
  });
  api.put("/channels/:channel/state", (_req, res) => {
    res.status(410).json({
      error: "deprecated: state docs moved to conversations. Use PUT /api/conversations/:id/state",
    });
  });

  /* Inbox + wait (agent-only) — per-conversation. */
  api.get("/inbox", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    res.json(store.inboxFor(agent.name));
  });

  api.get("/wait", async (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const conversationId = req.query.conversation ? String(req.query.conversation) : null;
    const channel = req.query.channel ? String(req.query.channel) : null;
    let timeoutMs = Number(req.query.timeout_ms ?? 25000);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 25000;
    timeoutMs = Math.min(Math.max(timeoutMs, 1000), 60000);
    if (channel) store.joinChannel(channel, agent.name);
    const messages = await store.waitForMessage({
      agent: agent.name,
      conversationId,
      channel,
      timeoutMs,
    });
    if (messages.length) {
      const m = messages[0];
      store.markRead(agent.name, m.conversationId);
      broadcast({
        type: "message.read",
        conversationId: m.conversationId,
        channel: m.channel,
        agent: agent.name,
        at: Date.now(),
      });
    }
    res.json(messages);
  });

  /* Supervision mode + approval queue (human surfaces — no agent token required) */
  api.get("/approval", (_req, res) => {
    res.json({
      mode: store.getMode(),
      reviewer: reviewerInfo,
      pending: store.listPending(),
    });
  });
  api.post("/approval/mode", (req, res) => {
    const next = req.body?.mode;
    if (!["manual", "auto", "llm"].includes(next)) {
      return res.status(400).json({ error: "mode must be manual | auto | llm" });
    }
    if (next === "llm" && !reviewerAvailable) {
      return res.status(409).json({
        error: "llm mode unavailable: no reviewer (set ANTHROPIC_API_KEY and restart the relay)",
      });
    }
    const mode = store.setMode(next);
    config?.saveConfig({ mode });
    broadcast({ type: "approval.mode", mode });
    res.json({ mode });
  });
  api.post("/approval/:id/approve", (req, res) => {
    const msg = store.approvePending(req.params.id);
    if (!msg) return res.status(404).json({ error: "not found" });
    broadcast({ type: "message.delivered", message: msg });
    res.json(msg);
  });
  api.post("/approval/:id/reject", (req, res) => {
    const msg = store.rejectPending(req.params.id);
    if (!msg) return res.status(404).json({ error: "not found" });
    broadcast({ type: "message.rejected", message: msg });
    res.json(msg);
  });

  /* Setup wizard + config editing (human surfaces — no agent token required). */
  api.get("/setup", (_req, res) => {
    if (!config) return res.json({ needed: false, configured: false });
    res.json({
      needed: !config.isSetupComplete(),
      configDir: config.dir,
      mode: store.getMode(),
      policy: config.readPolicy() ?? "",
      defaultPolicy: DEFAULT_POLICY,
      contracts: config.listContracts(),
      reviewer: reviewerInfo,
    });
  });

  api.post("/setup", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { mode, policy, contracts } = req.body ?? {};
    if (mode != null && !["manual", "auto", "llm"].includes(mode)) {
      return res.status(400).json({ error: "mode must be manual | auto | llm" });
    }
    if (mode === "llm" && !reviewerAvailable) {
      return res.status(409).json({
        error: "llm mode unavailable: no reviewer (set ANTHROPIC_API_KEY or install the claude CLI, then restart)",
      });
    }
    const list = Array.isArray(contracts) ? contracts : [];
    for (const c of list) {
      if (!config.validName(c?.name)) {
        return res.status(400).json({ error: `invalid contract name: ${c?.name}` });
      }
      const err = schemaError(c?.schema);
      if (err) return res.status(400).json({ error: `contract "${c.name}": ${err}` });
    }
    if (typeof policy === "string") config.savePolicy(policy);
    for (const c of list) config.saveContract(c.name, c.schema);
    const appliedMode = mode ?? store.getMode();
    store.setMode(appliedMode);
    config.saveConfig({ mode: appliedMode, setupComplete: true });
    reviewer?.setPolicy?.(config.readPolicy());
    broadcast({ type: "approval.mode", mode: appliedMode });
    broadcast({ type: "setup.updated", needed: false });
    res.json({
      needed: false,
      mode: appliedMode,
      policy: config.readPolicy() ?? "",
      contracts: config.listContracts(),
    });
  });

  api.get("/contracts", (_req, res) => {
    res.json(config ? config.listContracts() : []);
  });
  api.put("/contracts/:name", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { name } = req.params;
    if (!config.validName(name)) {
      return res.status(400).json({ error: "invalid contract name (use A-Z a-z 0-9 . _ -, max 64)" });
    }
    const schema = req.body?.schema ?? req.body;
    const err = schemaError(schema);
    if (err) return res.status(400).json({ error: err });
    config.saveContract(name, schema);
    broadcast({ type: "contracts.updated" });
    res.json({ name, schema });
  });
  api.delete("/contracts/:name", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    if (!config.deleteContract(req.params.name)) {
      return res.status(404).json({ error: "contract not found" });
    }
    broadcast({ type: "contracts.updated" });
    res.json({ ok: true });
  });

  api.get("/policy", (_req, res) => {
    res.json({ policy: config?.readPolicy() ?? "", defaultPolicy: DEFAULT_POLICY });
  });
  api.put("/policy", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const text = req.body?.policy;
    if (typeof text !== "string") {
      return res.status(400).json({ error: "policy required (string)" });
    }
    config.savePolicy(text);
    reviewer?.setPolicy?.(text);
    broadcast({ type: "policy.updated" });
    res.json({ policy: text });
  });

  app.use("/api", api);
}
