import { Router } from "express";

export function mountRoutes(app, { store, broadcast }) {
  const api = Router();

  /* Health */
  api.get("/health", (_req, res) => {
    res.json({ ok: true, approvalMode: store.getApprovalMode() });
  });

  /* Agents */
  api.post("/agents/register", (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name required (string)" });
    }
    const agent = store.registerAgent(name);
    broadcast({ type: "agent.registered", agent });
    res.json(agent);
  });
  api.get("/agents", (_req, res) => res.json(store.listAgents()));

  /* Channels */
  api.get("/channels", (_req, res) => res.json(store.listChannels()));

  /* Messages */
  api.post("/channels/:channel/messages", (req, res) => {
    const { channel } = req.params;
    const { from, content } = req.body ?? {};
    if (!from || typeof from !== "string") {
      return res.status(400).json({ error: "from required (string)" });
    }
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content required (string)" });
    }
    store.touchAgent(from);
    const msg = store.postMessage({ channel, from, content });
    broadcast({ type: msg.status === "pending" ? "message.pending" : "message.delivered", message: msg });
    res.json(msg);
  });

  api.get("/channels/:channel/messages", (req, res) => {
    const { channel } = req.params;
    const since = Number(req.query.since ?? 0);
    res.json(store.readMessages({ channel, since }));
  });

  /* Approval mode */
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
