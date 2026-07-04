import { Router } from "express";
import Ajv from "ajv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join, isAbsolute, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_POLICY, REVIEWER_PROVIDERS, listModels, reviewerCliAvailability, complete } from "../reviewer.js";
import { VALID_ENGINES } from "../config.js";
import { gitReview, isTaskDone, runEnvironmentReview } from "../review-run.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const execFileAsync = promisify(execFile);

function masterReviewPrompt(conv, dir, { diff, status, truncated }, locale = null) {
  return {
    system:
      'You are "master"\'s code supervisor: a senior reviewer inspecting the code an agent produced. ' +
      "Review the git diff for correctness bugs, security issues, missing error handling, and whether it matches the " +
      "conversation's purpose. Be concise and structured: list concrete issues (file + what + why) and a short verdict. " +
      "If the diff is empty, say there are no uncommitted changes to review." +
      masterLangLine(locale),
    user:
      `${masterContext(conv)}\nReviewing directory: ${dir}\n\n` +
      `git status --short:\n${status || "(clean)"}\n\n` +
      `git diff HEAD${truncated ? " (TRUNCATED — large diff)" : ""}:\n${diff || "(no uncommitted changes)"}`,
  };
}

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

/* ---- "master" mediator prompts (pure helpers) ---- */
const MASTER_TRANSCRIPT_MAX = 40;
const MASTER_LANGS = { es: "neutral Spanish (Latin-American, no voseo)", en: "English" };
function masterLangLine(locale) {
  const lang = MASTER_LANGS[locale];
  return lang ? ` Write your output in ${lang}.` : "";
}
function masterTranscript(messages) {
  const recent = messages.slice(-MASTER_TRANSCRIPT_MAX);
  if (!recent.length) return "(no messages yet)";
  return recent.map((m) => `${m.from}: ${String(m.content || "").replace(/\s+/g, " ")}`).join("\n");
}
/* Where the master is acting — pinned at the top of every prompt so the composed
 * message stays anchored to THIS conversation (and the recipients here), instead
 * of drifting into "spin up a new conversation". */
function masterContext(conv, members = []) {
  return (
    `Conversation: "${conv.title}" (id ${conv.id})\n` +
    `Purpose: ${conv.purpose || "(none)"}\n` +
    `Agents in this conversation: ${members.length ? members.join(", ") : "(none listed)"}`
  );
}
function masterComposePrompt(conv, transcript, instruction, locale = null, members = []) {
  return {
    system:
      'You are "master", the human supervisor and mediator of a multi-agent coding conversation — the highest authority in it. ' +
      "The supervisor gives you an instruction in their own words; turn it into a clear, direct, authoritative message to the " +
      "agent(s) that they are expected to follow, grounded in the conversation so far. " +
      "Your message will be posted INTO THIS SAME conversation and read by the agents already here. " +
      "Keep all work in the current conversation: do NOT tell agents to create, switch to, or open a new " +
      "conversation unless the supervisor's instruction explicitly asks for that. When the instruction says " +
      'to "start something new", it means a new task WITHIN this conversation. ' +
      "Output ONLY the message to send — no preamble, no quotes, no markdown fences." +
      masterLangLine(locale),
    user:
      `${masterContext(conv, members)}\n\n` +
      `Conversation so far (most recent last):\n${transcript}\n\n` +
      `Supervisor instruction:\n${instruction}\n\nWrite the message to send:`,
  };
}
function masterAnalyzePrompt(conv, transcript, instruction, locale = null, members = []) {
  return {
    system:
      'You are "master", an analyst for the human supervisor of a multi-agent coding conversation. ' +
      "Read the conversation and answer the supervisor's question about it (e.g. whether the communication is " +
      "effective, what is going wrong, what criteria to apply). Be concise and structured. This is FOR THE " +
      "SUPERVISOR ONLY and is NOT sent to the agents." +
      masterLangLine(locale),
    user:
      `${masterContext(conv, members)}\n\n` +
      `Conversation so far (most recent last):\n${transcript}\n\n` +
      `Supervisor question:\n${instruction}\n\nYour analysis:`,
  };
}

export function mountRoutes(app, { store, broadcast, subscribe = null, reviewer = null, config = null, agents = null }) {
  const api = Router();
  /* Dynamic: the reviewer can be reconfigured at runtime (provider switched from
   *  Settings), so availability/backend must be read per request, not captured. */
  const reviewerInfo = () => ({
    available: Boolean(reviewer?.available),
    backend: reviewer?.backend ?? null,
    provider: reviewer?.provider ?? null,
    model: reviewer?.model ?? null,
  });

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
    res.json({ ok: true, mode: store.getMode(), reviewer: reviewerInfo() });
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

  /* Conversations — the room itself (members, message stream, state doc, optional
   * DSP contract). Either an agent (Bearer token) or a human supervisor (no
   * token) can open one; the human is recorded as `createdBy: "supervisor"`. */
  api.get("/conversations", (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const filter = status && status !== "all" ? status : null;
    res.json(store.listConversations(filter));
  });

  api.post("/conversations", (req, res) => {
    const agent = optionalAgent(req);
    const { title, purpose = null, successCriteria = null, contract_name = null, members, project_id = null } = req.body ?? {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title required (string)" });
    }
    if (purpose != null && typeof purpose !== "string") {
      return res.status(400).json({ error: "purpose must be string when provided" });
    }
    if (successCriteria != null && typeof successCriteria !== "string") {
      return res.status(400).json({ error: "successCriteria must be string when provided" });
    }
    if (contract_name != null) {
      if (typeof contract_name !== "string" || !config) {
        return res.status(400).json({ error: "contract_name must be a known contract name" });
      }
      if (!config.getContract(contract_name)) {
        return res.status(400).json({ error: `unknown contract: ${contract_name}` });
      }
    }
    // Optional invite list — must be registered agents.
    const invite = (Array.isArray(members) ? members : []).filter((n) => typeof n === "string" && n.length);
    const unknown = invite.filter((n) => !store.hasAgent(n));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown agent(s): ${unknown.join(", ")}` });
    }
    // Optional project link — the conversation belongs to a known project, and
    // that project's environment agents are auto-invited so it's wired up.
    let projectId = null;
    if (project_id != null && project_id !== "") {
      if (typeof project_id !== "string" || !config) {
        return res.status(400).json({ error: "project_id must be a known project" });
      }
      const proj = config.getProject(project_id);
      if (!proj) return res.status(400).json({ error: `unknown project: ${project_id}` });
      projectId = project_id;
      for (const env of config.environmentsOfProject(project_id)) {
        if (env.agentName && store.hasAgent(env.agentName) && !invite.includes(env.agentName)) {
          invite.push(env.agentName);
        }
      }
    }
    const createdBy = agent?.name ?? "supervisor";
    // The state doc is seeded inside store.createConversation (every creation
    // path gets the PROGRESS.md skeleton, never blank); the creator + invited
    // agents are auto-joined as members.
    const conv = store.createConversation({
      title,
      purpose,
      successCriteria,
      contractName: contract_name,
      projectId,
      createdBy,
      members: invite,
    });
    broadcast({ type: "conversation.created", conversation: conv });
    res.json(conv);
  });

  api.get("/conversations/:id", (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    res.json(conv);
  });

  /* Delete a conversation and everything keyed on it (the web/REPL equivalent of
   * the old delchan). */
  api.delete("/conversations/:id", (req, res) => {
    if (!store.deleteConversation(req.params.id)) {
      return res.status(404).json({ error: "conversation not found" });
    }
    broadcast({ type: "conversation.deleted", id: req.params.id });
    res.json({ ok: true });
  });

  /* Membership: an agent joins/leaves itself (token); the supervisor adds or
   * removes any registered agent (no token — the human surface). */
  api.post("/conversations/:id/join", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const conv = store.joinConversation(req.params.id, agent.name);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    broadcast({ type: "conversation.updated", conversation: conv });
    res.json(conv);
  });
  api.post("/conversations/:id/leave", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const conv = store.leaveConversation(req.params.id, agent.name);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    broadcast({ type: "conversation.updated", conversation: conv });
    res.json(conv);
  });
  api.post("/conversations/:id/members", (req, res) => {
    const { agent } = req.body ?? {};
    if (!agent || typeof agent !== "string") {
      return res.status(400).json({ error: "agent required (string)" });
    }
    if (!store.hasAgent(agent)) {
      return res.status(404).json({ error: `unknown agent "${agent}" (not registered)` });
    }
    const conv = store.joinConversation(req.params.id, agent);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    broadcast({ type: "conversation.updated", conversation: conv });
    res.json(conv);
  });
  api.delete("/conversations/:id/members/:agent", (req, res) => {
    const conv = store.leaveConversation(req.params.id, req.params.agent);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    broadcast({ type: "conversation.updated", conversation: conv });
    res.json(conv);
  });

  /* Set or clear the active contract on an existing conversation. */
  api.put("/conversations/:id/contract", (req, res) => {
    optionalAgent(req); // accepts agent token OR supervisor (no token)
    const { contract_name = null } = req.body ?? {};
    if (contract_name != null) {
      if (typeof contract_name !== "string" || !config) {
        return res.status(400).json({ error: "contract_name must be a known contract name" });
      }
      if (!config.getContract(contract_name)) {
        return res.status(400).json({ error: `unknown contract: ${contract_name}` });
      }
    }
    const conv = store.setConversationContract(req.params.id, contract_name);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    broadcast({ type: "conversation.updated", conversation: conv });
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

  /* "master" — an LLM-mediated supervisor presence (human surface, no token).
   * POST /master  → compose (draft a message to agents) or analyze (for the human
   *                 only); both use the configured reviewer LLM. Nothing is posted.
   * POST /master/send → post the confirmed text into the conversation as "master",
   *                 delivered immediately and addressed so the listener wakes agents. */
  async function reviewerComplete({ system, user }) {
    const provider = reviewer.provider;
    return complete(provider, {
      key: resolveProviderKey(provider),
      baseUrl: config?.readReviewerConfig().baseUrl,
      model: reviewer.model,
      system,
      user,
    });
  }

  api.post("/conversations/:id/master", async (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    const { mode = "compose", instruction, verbatim = false } = req.body ?? {};
    if (typeof instruction !== "string" || !instruction.trim()) {
      return res.status(400).json({ error: "instruction required (string)" });
    }
    if (!["compose", "analyze"].includes(mode)) {
      return res.status(400).json({ error: "mode must be compose | analyze" });
    }
    if (mode === "compose" && verbatim) return res.json({ text: instruction }); // skip the LLM
    if (!reviewer?.available) {
      return res.status(409).json({ error: "no reviewer LLM configured (Settings → LLM provider)" });
    }
    const transcript = masterTranscript(store.readMessages({ conversationId: conv.id, since: 0 }));
    const locale = config?.readConfig().locale ?? null;
    const members = store.conversationMembers(conv.id).filter((n) => n !== "master");
    const prompt =
      mode === "analyze"
        ? masterAnalyzePrompt(conv, transcript, instruction, locale, members)
        : masterComposePrompt(conv, transcript, instruction, locale, members);
    try {
      const text = await reviewerComplete(prompt);
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: `master (${reviewer.backend}) error: ${err.message}` });
    }
  });

  /* master code review — ONLY on explicit supervisor request. The relay runs
   * read-only git (diff vs HEAD + status) in `dir` and the configured LLM reviews
   * it. Returns the review text for the supervisor (who can then send it as master). */
  api.post("/conversations/:id/master/review", async (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    const dir = req.body?.dir;
    if (typeof dir !== "string" || !dir.trim()) {
      return res.status(400).json({ error: "dir required (string): the repo directory to review" });
    }
    if (!reviewer?.available) {
      return res.status(409).json({ error: "no reviewer LLM configured (Settings → LLM provider)" });
    }
    let git;
    try {
      git = await gitReview(dir.trim());
    } catch (err) {
      return res.status(400).json({ error: `git review failed (is "${dir}" a git repo?): ${err.message}` });
    }
    const locale = config?.readConfig().locale ?? null;
    try {
      const review = await reviewerComplete(masterReviewPrompt(conv, dir.trim(), git, locale));
      res.json({ review, dir: dir.trim(), hasChanges: Boolean(git.diff || git.status), truncated: git.truncated });
    } catch (err) {
      res.status(502).json({ error: `master review (${reviewer.backend}) error: ${err.message}` });
    }
  });

  api.post("/conversations/:id/master/send", (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    if (conv.status !== "open") return res.status(400).json({ error: "conversation is closed" });
    const { content } = req.body ?? {};
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content required (string)" });
    }
    const rawTo = req.body?.to;
    let to = (Array.isArray(rawTo) ? rawTo : rawTo ? [rawTo] : [])
      .filter((n) => typeof n === "string" && n.length);
    if (to.length) {
      const unknown = to.filter((n) => !store.hasAgent(n));
      if (unknown.length) return res.status(400).json({ error: `unknown agent(s): ${unknown.join(", ")}` });
    } else {
      to = store.conversationMembers(conv.id).filter((n) => n !== "master"); // default: everyone
    }
    let msg = store.postMessage({ conversationId: conv.id, from: "master", content, to });
    if (msg.status === "pending") {
      msg = store.approvePending(msg.id, {
        decision: "approve",
        reason: "master (supervisor)",
        at: Date.now(),
        by: "master",
      }) || msg;
    }
    // master is never a persistent member (the store skips it on post), so there
    // is nothing to leave.
    masterDrafts.delete(conv.id); // a sent reply consumes any pending auto-draft
    broadcast({ type: "message.delivered", message: msg });
    res.json(msg);
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

  /* Direct message: resolve (or create) the canonical 1:1 conversation between
   * the two agents and post into it. The 1:1 lives forever (reopened if closed). */
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
    if (!store.hasAgent(to)) {
      return res.status(400).json({ error: `unknown agent: ${to}` });
    }
    const conv = store.ensureDmConversation(agent.name, to);
    broadcast({ type: "conversation.updated", conversation: conv });
    const msg = store.postMessage({
      conversationId: conv.id,
      from: agent.name,
      content,
      to: [to],
    });
    broadcast({
      type: msg.status === "pending" ? "message.pending" : "message.delivered",
      message: msg,
    });
    res.json(msg);
  });

  /* Post a message into a conversation. `to` @mentions specific members (everyone
   * in the conversation still sees it; tagged agents are flagged it's for them).
   * A conversation may carry a DSP contract: `data` is then required and validated
   * against the contract's schema before the message is ever queued. */
  api.post("/conversations/:id/messages", (req, res) => {
    const agent = requireAgent(req, res);
    if (!agent) return;
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    if (conv.status !== "open") return res.status(400).json({ error: "conversation is closed" });
    const { content } = req.body ?? {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content required (string)" });
    }
    const rawTo = req.body?.to;
    const to = (Array.isArray(rawTo) ? rawTo : rawTo ? [rawTo] : [])
      .filter((n) => typeof n === "string" && n.length);
    // "master" is the human supervisor sentinel, not a registered agent: an agent
    // may address it to reach the supervisor (who reads it in the monitor).
    const unknown = to.filter((n) => n !== "master" && !store.hasAgent(n));
    if (unknown.length) {
      return res.status(400).json({ error: `unknown agent(s) in 'to': ${unknown.join(", ")}` });
    }

    const data = req.body?.data ?? null;
    // If the conversation has an active contract and the message didn't name one
    // explicitly, apply the conv's contract — then enforce `data` + validate it.
    const convContract = conv.contract_name ?? null;
    let contractName = req.body?.contract ?? convContract;
    let schema = req.body?.schema ?? null;
    if (convContract && !data) {
      return res.status(400).json({
        error: `conversation requires data matching contract "${convContract}"`,
      });
    }
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
      conversationId: conv.id,
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
    let timeoutMs = Number(req.query.timeout_ms ?? 25000);
    if (!Number.isFinite(timeoutMs)) timeoutMs = 25000;
    timeoutMs = Math.min(Math.max(timeoutMs, 1000), 60000);
    // Watching a specific conversation auto-joins it (so it stays in your inbox).
    if (conversationId) store.joinConversation(conversationId, agent.name);
    const messages = await store.waitForMessage({
      agent: agent.name,
      conversationId,
      timeoutMs,
    });
    if (messages.length) {
      const m = messages[0];
      store.markRead(agent.name, m.conversationId);
      broadcast({
        type: "message.read",
        conversationId: m.conversationId,
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
      reviewer: reviewerInfo(),
      pending: store.listPending(),
    });
  });
  api.post("/approval/mode", (req, res) => {
    const next = req.body?.mode;
    if (!["manual", "auto", "llm"].includes(next)) {
      return res.status(400).json({ error: "mode must be manual | auto | llm" });
    }
    if (next === "llm" && !reviewer?.available) {
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
      engine: config.getEngine(),
      locale: config.readConfig().locale ?? null,
      policy: config.readPolicy() ?? "",
      defaultPolicy: DEFAULT_POLICY,
      contracts: config.listContracts(),
      reviewer: reviewerInfo(),
    });
  });

  api.post("/setup", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { mode, policy, contracts, engine } = req.body ?? {};
    if (mode != null && !["manual", "auto", "llm"].includes(mode)) {
      return res.status(400).json({ error: "mode must be manual | auto | llm" });
    }
    if (engine != null && !VALID_ENGINES.has(engine)) {
      return res.status(400).json({ error: `engine must be one of: ${[...VALID_ENGINES].join(", ")}` });
    }
    if (mode === "llm" && !reviewer?.available) {
      return res.status(409).json({
        error: "llm mode unavailable: no reviewer (pick a provider in Settings, or set ANTHROPIC_API_KEY / install the claude CLI)",
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
    const appliedEngine = engine ?? config.getEngine();
    store.setMode(appliedMode);
    config.saveConfig({ mode: appliedMode, engine: appliedEngine, setupComplete: true });
    reviewer?.setPolicy?.(config.readPolicy());
    broadcast({ type: "approval.mode", mode: appliedMode });
    broadcast({ type: "engine.updated", engine: appliedEngine });
    broadcast({ type: "setup.updated", needed: false });
    res.json({
      needed: false,
      mode: appliedMode,
      engine: appliedEngine,
      policy: config.readPolicy() ?? "",
      contracts: config.listContracts(),
    });
  });

  /* Engine = which agent CLI new environments launch (claude | opencode). The
   * Settings UI edits it live; existing environments keep the engine they were
   * created with. */
  api.put("/engine", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const engine = req.body?.engine;
    if (!VALID_ENGINES.has(engine)) {
      return res.status(400).json({ error: `engine must be one of: ${[...VALID_ENGINES].join(", ")}` });
    }
    config.saveConfig({ engine });
    broadcast({ type: "engine.updated", engine });
    res.json({ engine });
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

  /* Reviewer provider config (LLM supervision backend). The human Settings UI
   * picks provider/model/key here; it takes effect live (no restart). Secrets
   * are write-only over the API — GET reports only which keys are SET. */
  function keyStatus() {
    const stored = config?.readReviewerConfig().keys ?? {};
    const out = {};
    for (const [p, meta] of Object.entries(REVIEWER_PROVIDERS)) {
      if (!meta.needsKey) continue;
      out[p] =
        Boolean(stored[p]) ||
        Boolean(meta.keyEnv && process.env[meta.keyEnv]) ||
        (p === "gemini" && Boolean(process.env.GOOGLE_API_KEY));
    }
    return out;
  }
  function resolveProviderKey(provider) {
    const stored = config?.readReviewerConfig().keys ?? {};
    if (stored[provider]) return stored[provider];
    const meta = REVIEWER_PROVIDERS[provider];
    if (meta?.keyEnv && process.env[meta.keyEnv]) return process.env[meta.keyEnv];
    if (provider === "gemini" && process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
    return null;
  }
  function reviewerConfigView() {
    const cfg = config?.readReviewerConfig() ?? {};
    return {
      ...reviewerInfo(),
      providers: REVIEWER_PROVIDERS,
      selected: {
        provider: cfg.provider ?? "auto",
        model: cfg.model ?? "",
        baseUrl: cfg.baseUrl ?? "",
      },
      keysSet: keyStatus(),
      cliAvailable: reviewerCliAvailability(),
    };
  }

  api.get("/reviewer", (_req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    res.json(reviewerConfigView());
  });
  /* List the models a provider exposes (for the Settings dropdown). The relay
   * holds the key; it is resolved server-side and never accepted via query. */
  api.get("/reviewer/models", async (req, res) => {
    const provider = String(req.query.provider || "");
    if (!REVIEWER_PROVIDERS[provider]) {
      return res.status(400).json({ error: "unknown provider", models: [] });
    }
    try {
      const models = await listModels(provider, {
        key: resolveProviderKey(provider),
        baseUrl: config?.readReviewerConfig().baseUrl,
      });
      res.json({ provider, models });
    } catch (err) {
      res.status(502).json({ error: err.message, models: [] });
    }
  });
  api.put("/reviewer", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { provider, model, baseUrl, keys } = req.body ?? {};
    const allowed = ["auto", ...Object.keys(REVIEWER_PROVIDERS)];
    if (provider != null && !allowed.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${allowed.join(", ")}` });
    }
    if (model != null && typeof model !== "string") {
      return res.status(400).json({ error: "model must be a string" });
    }
    if (baseUrl != null && typeof baseUrl !== "string") {
      return res.status(400).json({ error: "baseUrl must be a string" });
    }
    const patch = {};
    if (provider != null) patch.provider = provider;
    if (model != null) patch.model = model;
    if (baseUrl != null) patch.baseUrl = baseUrl;
    if (keys != null) {
      if (typeof keys !== "object" || Array.isArray(keys)) {
        return res.status(400).json({ error: "keys must be an object of provider→key" });
      }
      const clean = {};
      for (const [p, v] of Object.entries(keys)) {
        if (!REVIEWER_PROVIDERS[p]?.needsKey) continue; // ignore unknown / keyless providers
        if (typeof v !== "string") continue;
        clean[p] = v; // "" clears it (falls back to env)
      }
      if (Object.keys(clean).length) patch.keys = clean;
    }
    const merged = config.saveReviewerConfig(patch);
    reviewer?.reconfigure?.(merged);
    broadcast({ type: "reviewer.updated", reviewer: reviewerInfo() });
    res.json(reviewerConfigView());
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

  /* The system language (e.g. "es" | "en"): drives the LLM reviewer's reason
   * language so it matches the UI. Persisted in config.json; applied live to the
   * reviewer without rebuilding the backend. */
  api.put("/locale", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const locale = req.body?.locale;
    if (locale != null && (typeof locale !== "string" || !/^[a-z]{2}$/.test(locale))) {
      return res.status(400).json({ error: "locale must be a 2-letter code (e.g. \"es\") or null" });
    }
    config.saveConfig({ locale: locale ?? null });
    reviewer?.setLocale?.(locale ?? null);
    broadcast({ type: "locale.updated", locale: locale ?? null });
    res.json({ locale: locale ?? null });
  });

  /* Local filesystem folder browser for the project picker. Lists subdirectories
   * of `path` (default: home) so the UI can navigate to a repo without typing the
   * absolute path. Local-only relay → browsing the user's own machine is fine;
   * returns directory names only, never file contents. */
  api.get("/fs", (req, res) => {
    const reqPath = typeof req.query.path === "string" && req.query.path.trim() ? req.query.path.trim() : homedir();
    let abs;
    try { abs = resolve(reqPath); } catch { return res.status(400).json({ error: "invalid path" }); }
    let st;
    try { st = statSync(abs); } catch { return res.status(400).json({ error: `not found: ${abs}` }); }
    if (!st.isDirectory()) return res.status(400).json({ error: `not a directory: ${abs}` });
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => ({ name: d.name, path: join(abs, d.name), isRepo: existsSync(join(abs, d.name, ".git")) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const parent = dirname(abs);
    res.json({ path: abs, parent: parent === abs ? null : parent, isRepo: existsSync(join(abs, ".git")), entries });
  });

  /* ---- Projects (top-level): group one or more ENVIRONMENTS and own
   * conversations. A project itself is just a name; its environments are the
   * launchable agents. */
  api.get("/projects", (_req, res) => {
    if (!config) return res.json([]);
    const list = config.readProjects().map((p) => ({
      ...p,
      environments: config.environmentsOfProject(p.id).map((e) => ({ ...e, status: agents?.statusOf(e.id) ?? "stopped" })),
    }));
    res.json(list);
  });

  api.post("/projects", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { name } = req.body ?? {};
    try {
      const project = config.addProject({ name });
      broadcast({ type: "project.created", project });
      res.json(project);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete("/projects/:id", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    // Stop any running agents of this project's environments before removing.
    for (const e of config.environmentsOfProject(req.params.id)) agents?.stop(e.id);
    if (!config.removeProject(req.params.id)) return res.status(404).json({ error: "project not found" });
    broadcast({ type: "project.deleted", id: req.params.id });
    res.json({ ok: true });
  });

  /* ---- Environments: a directory + engine + agent identity switchboard can
   * launch, belonging to a project. The CLI runs in a PTY (see agents manager);
   * its console streams over the /console WebSocket. */
  api.get("/environments", (req, res) => {
    if (!config) return res.json([]);
    const projectId = req.query.project ? String(req.query.project) : null;
    let list = config.readEnvironments();
    if (projectId) list = list.filter((e) => e.projectId === projectId);
    res.json(list.map((e) => ({ ...e, status: agents?.statusOf(e.id) ?? "stopped" })));
  });

  api.post("/environments", async (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { mode = "existing", name, dir, parentDir, agentName, projectId } = req.body ?? {};
    const engine = req.body?.engine ?? config.getEngine();
    if (!VALID_ENGINES.has(engine)) {
      return res.status(400).json({ error: `engine must be one of: ${[...VALID_ENGINES].join(", ")}` });
    }
    if (!projectId || !config.getProject(projectId)) {
      return res.status(400).json({ error: "a valid projectId is required" });
    }
    try {
      let envDir, envName;
      if (mode === "new") {
        if (!config.validName(name)) return res.status(400).json({ error: "name required (letters, digits, . _ -)" });
        if (typeof parentDir !== "string" || !isAbsolute(parentDir.trim() || "")) {
          return res.status(400).json({ error: "parentDir required (absolute path)" });
        }
        envDir = join(parentDir.trim(), name);
        if (existsSync(envDir)) return res.status(400).json({ error: `already exists: ${envDir}` });
        mkdirSync(envDir, { recursive: true });
        await execFileAsync("git", ["-C", envDir, "init"], { timeout: 15000 });
        writeFileSync(join(envDir, "README.md"), `# ${name}\n`);
        envName = name;
      } else {
        if (typeof dir !== "string" || !isAbsolute(dir.trim() || "")) {
          return res.status(400).json({ error: "dir required (absolute path)" });
        }
        envDir = dir.trim();
        let st;
        try { st = statSync(envDir); } catch { return res.status(400).json({ error: `directory not found: ${envDir}` }); }
        if (!st.isDirectory()) return res.status(400).json({ error: `not a directory: ${envDir}` });
        envName = config.validName(name) ? name : basename(envDir);
      }
      const finalAgent = config.validName(agentName) ? agentName : envName;
      const env = config.addEnvironment({ name: envName, dir: envDir, engine, agentName: finalAgent, projectId });
      agents?.registerIdentity?.(env.agentName); // appears + addable to conversations right away
      broadcast({ type: "environment.created", environment: env });
      res.json(env);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete("/environments/:id", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    agents?.stop(req.params.id);
    if (!config.removeEnvironment(req.params.id)) return res.status(404).json({ error: "environment not found" });
    broadcast({ type: "environment.deleted", id: req.params.id });
    res.json({ ok: true });
  });

  api.post("/environments/:id/agent/start", async (req, res) => {
    if (!config || !agents) return res.status(409).json({ error: "environments unavailable" });
    const env = config.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: "environment not found" });
    try {
      await agents.start(env);
      res.json({ environmentId: env.id, status: agents.statusOf(env.id) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  api.post("/environments/:id/agent/stop", (req, res) => {
    if (!agents) return res.status(409).json({ error: "environments unavailable" });
    const ok = agents.stop(req.params.id);
    res.json({ ok, status: agents.statusOf(req.params.id) });
  });

  /* ---- Subagents: per-environment review nodes orchestrated with LangGraph.
   * Human/master surface (no agent token), mirroring projects/environments. ---- */
  api.get("/environments/:id/subagents", (req, res) => {
    if (!config) return res.json([]);
    if (!config.getEnvironment(req.params.id)) return res.status(404).json({ error: "environment not found" });
    res.json(config.subagentsOfEnvironment(req.params.id));
  });
  api.post("/environments/:id/subagents", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    if (!config.getEnvironment(req.params.id)) return res.status(404).json({ error: "environment not found" });
    try {
      const { name, role, provider, model, dependsOn } = req.body ?? {};
      const sub = config.addSubagent({ environmentId: req.params.id, name, role, provider, model, dependsOn });
      broadcast({ type: "subagent.created", subagent: sub });
      res.json(sub);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  api.put("/subagents/:id", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    try {
      const sub = config.updateSubagent(req.params.id, req.body ?? {});
      if (!sub) return res.status(404).json({ error: "subagent not found" });
      broadcast({ type: "subagent.updated", subagent: sub });
      res.json(sub);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  api.delete("/subagents/:id", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    if (!config.removeSubagent(req.params.id)) return res.status(404).json({ error: "subagent not found" });
    broadcast({ type: "subagent.deleted", id: req.params.id });
    res.json({ ok: true });
  });

  /* The whole node graph for the canvas (one bootstrap call). */
  api.get("/graph", (_req, res) => {
    if (!config) return res.json({ projects: [], environments: [], subagents: [] });
    res.json({
      projects: config.readProjects(),
      environments: config.readEnvironments().map((e) => ({ ...e, status: agents?.statusOf(e.id) ?? "stopped" })),
      subagents: config.readSubagents(),
    });
  });

  /* Master-triggered review run: compile the environment's subagents into a
   * LangGraph graph and run it over the work (git diff of the env dir + optional
   * conversation transcript). Returns one verdict per subagent. */
  api.post("/environments/:id/review", async (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const env = config.getEnvironment(req.params.id);
    if (!env) return res.status(404).json({ error: "environment not found" });
    if (!config.subagentsOfEnvironment(env.id).length) {
      return res.status(400).json({ error: "this environment has no subagents to run" });
    }
    try {
      const { verdicts, truncated } = await runEnvironmentReview({
        env,
        conversationId: req.body?.conversation ?? null,
        dir: req.body?.dir ?? null,
        store, config, reviewer,
        resolveKey: resolveProviderKey,
      });
      broadcast({ type: "subagent.review", environmentId: env.id, verdicts, truncated });
      res.json({ environmentId: env.id, verdicts, truncated });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /* ---- Conversation ↔ subagents: run reviews from a conversation and post the
   * verdicts INTO it (the supervision loop). Shared by the manual endpoint below
   * and the task-done automation listener. ---- */

  /** Environments of the conversation's project that actually have subagents. */
  function reviewableEnvironments(conv) {
    if (!config || !conv?.projectId) return [];
    return config.environmentsOfProject(conv.projectId)
      .filter((e) => config.subagentsOfEnvironment(e.id).length > 0);
  }

  /** Post an environment's verdicts into the conversation as "master" (delivered
   *  directly, like /master/send): markdown summary + structured data so the UI
   *  renders badges. `to` wakes the addressed agent's listener. */
  function postVerdicts(conv, env, verdicts, to = []) {
    const lines = verdicts.map((v) => `- **${v.subagent}**: ${v.decision} — ${v.reason || ""}`);
    const content = `Revisión de subagentes — \`${env.name}\`\n${lines.join("\n")}`;
    let msg = store.postMessage({
      conversationId: conv.id,
      from: "master",
      content,
      to: to.filter((n) => store.hasAgent(n)),
      data: { kind: "review-verdicts", environmentId: env.id, verdicts },
    });
    if (msg.status === "pending") {
      msg = store.approvePending(msg.id, {
        decision: "approve", reason: "master (subagent review)", at: Date.now(), by: "master",
      }) || msg;
    }
    broadcast({ type: "message.delivered", message: msg });
    broadcast({ type: "subagent.review", environmentId: env.id, verdicts, conversationId: conv.id });
    return msg;
  }

  api.post("/conversations/:id/review-subagents", async (req, res) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "conversation not found" });
    if (!config) return res.status(409).json({ error: "no config store" });
    let envs = reviewableEnvironments(conv);
    const wanted = req.body?.environmentId;
    if (wanted) envs = envs.filter((e) => e.id === wanted);
    if (!envs.length) {
      return res.status(409).json({
        error: "no environments with subagents for this conversation (link it to a project and add subagents in the Agent graph)",
      });
    }
    try {
      const runs = [];
      for (const env of envs) {
        const { verdicts } = await runEnvironmentReview({
          env, conversationId: conv.id, store, config, reviewer, resolveKey: resolveProviderKey,
        });
        postVerdicts(conv, env, verdicts, env.agentName ? [env.agentName] : []);
        runs.push({ environmentId: env.id, verdicts });
      }
      res.json({ runs });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /* ---- Automation settings (persisted in config.json) ---- */
  api.get("/automation", (_req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    res.json(config.getAutomation());
  });
  api.put("/automation", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const cur = config.getAutomation();
    const next = {
      masterDraftOnMention: typeof req.body?.masterDraftOnMention === "boolean"
        ? req.body.masterDraftOnMention : cur.masterDraftOnMention,
      reviewOnTaskDone: typeof req.body?.reviewOnTaskDone === "boolean"
        ? req.body.reviewOnTaskDone : cur.reviewOnTaskDone,
    };
    config.saveConfig({ automation: next });
    broadcast({ type: "automation.updated", automation: next });
    res.json(next);
  });

  /* ---- Master auto-drafts (in-memory: transient by nature; the UI fetches the
   * pending draft when a conversation is selected). ---- */
  const masterDrafts = new Map(); // conversationId → { text, replyTo, from, at }
  api.get("/conversations/:id/master/draft", (req, res) => {
    res.json({ draft: masterDrafts.get(req.params.id) ?? null });
  });

  /* ---- Automation listener: reacts to DELIVERED messages only (supervision
   * stays the gate). Guards make loops impossible: master's own messages and
   * verdict messages never re-trigger, and each environment runs one review at
   * a time. Fail-safe: any error is logged and swallowed — automation must
   * never affect message delivery. ---- */
  const reviewsInFlight = new Set(); // environment ids
  if (subscribe && config) {
    subscribe(async (event) => {
      if (event.type !== "message.delivered") return;
      const m = event.message;
      if (!m || m.from === "master") return; // never react to ourselves (drafts + verdicts)
      if (m.data?.kind === "review-verdicts") return;
      const conv = store.getConversation(m.conversationId);
      if (!conv || conv.status !== "open") return;
      const auto = config.getAutomation();

      // 1) @master mention → compose a reply DRAFT for the human (never posted).
      if (auto.masterDraftOnMention && Array.isArray(m.to) && m.to.includes("master") && reviewer?.available) {
        try {
          const transcript = masterTranscript(store.readMessages({ conversationId: conv.id, since: 0 }));
          const locale = config.readConfig().locale ?? null;
          const members = store.conversationMembers(conv.id).filter((n) => n !== "master");
          const instruction =
            `Agent "${m.from}" addressed you directly with this message:\n"${String(m.content || "").slice(0, 2000)}"\n` +
            "Draft the master's reply to it.";
          const text = await reviewerComplete(masterComposePrompt(conv, transcript, instruction, locale, members));
          const draft = { text, replyTo: m.id, from: m.from, at: Date.now() };
          masterDrafts.set(conv.id, draft);
          broadcast({ type: "master.draft", conversationId: conv.id, ...draft });
        } catch (err) {
          process.stderr.write(`automation: master draft failed: ${err.message}\n`);
        }
      }

      // 2) task-done → run the SENDER's environment review, post verdicts back.
      if (auto.reviewOnTaskDone && isTaskDone(m)) {
        const env = config.readEnvironments().find((e) => e.agentName === m.from);
        if (!env || !config.subagentsOfEnvironment(env.id).length) return;
        if (reviewsInFlight.has(env.id)) return; // one review per env at a time
        reviewsInFlight.add(env.id);
        try {
          const { verdicts } = await runEnvironmentReview({
            env, conversationId: conv.id, store, config, reviewer, resolveKey: resolveProviderKey,
          });
          postVerdicts(conv, env, verdicts, [m.from]);
        } catch (err) {
          process.stderr.write(`automation: task-done review failed (${env.name}): ${err.message}\n`);
        } finally {
          reviewsInFlight.delete(env.id);
        }
      }
    });
  }

  app.use("/api", api);
}
