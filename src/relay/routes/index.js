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

export function mountRoutes(app, { store, broadcast, reviewer = null, config = null }) {
  const api = Router();
  const reviewerAvailable = Boolean(reviewer?.available);

  /** Resolve the calling agent from its token. Sends 401 and returns null
   *  when missing/invalid. Token may arrive as `Authorization: Bearer <t>`
   *  or `x-switchboard-token: <t>`. */
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
    // The token is returned ONLY here, to the registering caller.
    res.json({ name: agent.name, token: agent.token, registeredAt: agent.registeredAt });
  });
  api.get("/agents", (_req, res) => res.json(store.listAgents()));

  /* Channels */
  api.get("/channels", (_req, res) => res.json(store.listChannels()));

  /* Create / delete a whole channel (human supervisor — no agent token). */
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
    // Verifiable contract (opt-in). Two ways to attach one:
    //  - `contract: "<name>"` — reference a named schema saved in the config dir.
    //  - `schema: {...}` — an inline JSON Schema (one-off).
    // Either way `data` must satisfy it; a malformed contract is rejected here,
    // before it can queue.
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
      channel: req.params.channel,
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

  /* Setup wizard + config editing (human surfaces — no agent token required).
   * The config dir is the durable source of truth; these read/write it. */

  // First-run status + current config. `needed` drives the web wizard.
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

  // Complete (or re-run) setup: write mode + policy + contracts in one shot.
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

  // Contracts CRUD (named JSON Schemas).
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

  // Reviewer policy (read/edit) — live-applied to the reviewer.
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
