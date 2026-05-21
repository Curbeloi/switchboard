import { Router } from "express";

const publicAgent = (a) => ({
  name: a.name,
  registeredAt: a.registeredAt,
  lastSeenAt: a.lastSeenAt,
});

export function mountRoutes(app, { store, broadcast }) {
  const api = Router();

  /** Resolve the calling agent from its token. Sends 401 and returns null
   *  when missing/invalid. Token may arrive as `Authorization: Bearer <t>`
   *  or `x-switchboard-token: <t>`. */
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

  /** Like requireAgent but optional — returns the agent or null without erroring.
   *  Used by read-only routes that local human surfaces (web UI) may call. */
  function optionalAgent(req) {
    const auth = req.get("authorization");
    const token =
      req.get("x-switchboard-token") ||
      (auth?.startsWith("Bearer ") ? auth.slice(7) : null);
    return store.verifyToken(token);
  }

  /* Health */
  api.get("/health", (_req, res) => {
    res.json({ ok: true, approvalMode: store.getApprovalMode() });
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
    // The token is returned ONLY here, to the registering caller.
    res.json({ name: agent.name, token: agent.token, registeredAt: agent.registeredAt });
  });
  api.get("/agents", (_req, res) => res.json(store.listAgents()));

  /* Channels */
  api.get("/channels", (_req, res) => res.json(store.listChannels()));

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

  /* Direct message: canonical 2-member channel, both sides auto-joined. */
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
    const msg = store.postMessage({ channel, from: agent.name, content });
    broadcast({
      type: msg.status === "pending" ? "message.pending" : "message.delivered",
      message: msg,
    });
    res.json(msg);
  });

  /* Messages */
  api.post("/channels/:channel/messages", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content required (string)" });
    }
    // `to` tags specific members (like an @mention). Normalize to a name array.
    const rawTo = req.body?.to;
    const to = (Array.isArray(rawTo) ? rawTo : rawTo ? [rawTo] : [])
      .filter((n) => typeof n === "string" && n.length);
    const unknown = to.filter((n) => !store.hasAgent(n));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown agent(s) in 'to': ${unknown.join(", ")}` });
    }
    const msg = store.postMessage({ channel: req.params.channel, from: agent.name, content, to });
    broadcast({
      type: msg.status === "pending" ? "message.pending" : "message.delivered",
      message: msg,
    });
    res.json(msg);
  });

  api.get("/channels/:channel/messages", (req, res) => {
    const { channel } = req.params;
    const since = Number(req.query.since ?? 0);
    const messages = store.readMessages({ channel, since });
    // Advancing the read cursor is an identity-bearing act: only when a valid
    // token is present (an agent reading), not for the token-less human UI.
    const agent = optionalAgent(req);
    if (agent) {
      store.markRead(agent.name, channel);
      broadcast({ type: "message.read", channel, agent: agent.name, at: Date.now() });
    }
    res.json(messages);
  });

  /* Inbox + wait (agent-only) */
  api.get("/inbox", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    res.json(store.inboxFor(agent.name));
  });

  api.get("/wait", async (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const channel = req.query.channel ? String(req.query.channel) : null;
    let timeoutMs = Number(req.query.timeout_ms ?? 25000);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 25000;
    timeoutMs = Math.min(Math.max(timeoutMs, 1000), 60000);
    if (channel) store.joinChannel(channel, agent.name);
    const messages = await store.waitForMessage({ agent: agent.name, channel, timeoutMs });
    if (messages.length) {
      const ch = messages[0].channel;
      store.markRead(agent.name, ch);
      broadcast({ type: "message.read", channel: ch, agent: agent.name, at: Date.now() });
    }
    res.json(messages);
  });

  /* Approval mode (human supervision surfaces — no agent token required) */
  api.get("/approval", (_req, res) => {
    res.json({
      mode: store.getApprovalMode(),
      pending: store.listPending(),
    });
  });
  api.post("/approval/mode", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    const mode = store.setApprovalMode(enabled);
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

  app.use("/api", api);
}
