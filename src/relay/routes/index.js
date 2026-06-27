import { Router } from "express";
import Ajv from "ajv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join, isAbsolute, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_POLICY, REVIEWER_PROVIDERS, listModels, reviewerCliAvailability, complete } from "../reviewer.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const execFileAsync = promisify(execFile);

/* Read-only git inspection for the master's code-review action. Runs in `dir`
 * with execFile (no shell → no injection). Returns the uncommitted diff vs HEAD
 * plus a short status (so new/untracked files show up too). Throws if not a repo. */
const REVIEW_DIFF_CAP = 100_000; // chars fed to the LLM (truncate huge diffs)
async function gitReview(dir) {
  const run = (args) =>
    execFileAsync("git", ["-C", dir, ...args], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  await run(["rev-parse", "--is-inside-work-tree"]); // throws if dir isn't a git repo
  let diff = "";
  try {
    diff = (await run(["diff", "HEAD"])).stdout; // staged + unstaged vs last commit
  } catch {
    diff = (await run(["diff"])).stdout; // empty repo / no HEAD → unstaged only
  }
  const status = (await run(["status", "--short"])).stdout;
  let truncated = false;
  if (diff.length > REVIEW_DIFF_CAP) {
    diff = diff.slice(0, REVIEW_DIFF_CAP);
    truncated = true;
  }
  return { diff, status, truncated };
}
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
 * message stays anchored to THIS channel + conversation (and the recipients here),
 * instead of drifting into "spin up a new channel". */
function masterContext(conv, members = []) {
  return (
    `Channel: ${conv.channel}\n` +
    `Conversation: "${conv.title}" (id ${conv.id})\n` +
    `Purpose: ${conv.purpose || "(none)"}\n` +
    `Agents in this channel: ${members.length ? members.join(", ") : "(none listed)"}`
  );
}
function masterComposePrompt(conv, transcript, instruction, locale = null, members = []) {
  return {
    system:
      'You are "master", the human supervisor and mediator of a multi-agent coding conversation — the highest authority in it. ' +
      "The supervisor gives you an instruction in their own words; turn it into a clear, direct, authoritative message to the " +
      "agent(s) that they are expected to follow, grounded in the conversation so far. " +
      "Your message will be posted INTO THIS SAME channel and conversation and read by the agents already here. " +
      "Keep all work in the current channel and conversation: do NOT tell agents to create, switch to, or open a new " +
      "channel or conversation unless the supervisor's instruction explicitly asks for that. When the instruction says " +
      'to "start something new", it means a new task WITHIN this conversation, not a new channel. ' +
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

export function mountRoutes(app, { store, broadcast, reviewer = null, config = null, agents = null }) {
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

  /* Supervisor-driven membership (human surface, no token) — the web equivalent
   * of the REPL's addto/removefrom: add or remove a registered agent. */
  api.post("/channels/:channel/members", (req, res) => {
    const { agent } = req.body ?? {};
    if (!agent || typeof agent !== "string") {
      return res.status(400).json({ error: "agent required (string)" });
    }
    if (!store.hasAgent(agent)) {
      return res.status(404).json({ error: `unknown agent "${agent}" (not registered)` });
    }
    const channel = store.joinChannel(req.params.channel, agent);
    broadcast({ type: "channel.updated", channel });
    res.json(channel);
  });
  api.delete("/channels/:channel/members/:agent", (req, res) => {
    const channel = store.leaveChannel(req.params.channel, req.params.agent);
    if (!channel) return res.status(404).json({ error: "channel not found" });
    broadcast({ type: "channel.updated", channel });
    res.json(channel);
  });

  /* Conversations (threads inside a channel) — every loop lives in one.
   * Either an agent (Bearer token) or a human supervisor (no token) can open
   * a conversation; the human is recorded as `createdBy: "supervisor"`.
   * Optional `contract_name` makes this a DSP-governed conversation: all
   * messages posted to it must carry `data` matching the named contract. */
  api.post("/channels/:channel/conversations", (req, res) => {
    const agent = optionalAgent(req);
    const { title, purpose = null, successCriteria = null, contract_name = null } = req.body ?? {};
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
    const createdBy = agent?.name ?? "supervisor";
    const conv = store.createConversation({
      channel: req.params.channel,
      title,
      purpose,
      successCriteria,
      contractName: contract_name,
      createdBy,
    });
    if (agent) store.joinChannel(req.params.channel, agent.name);
    // The state doc is seeded inside store.createConversation (so every creation
    // path — route, auto-create, DM — gets the PROGRESS.md skeleton, never blank).
    broadcast({ type: "conversation.created", conversation: conv });
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
    const members = store.channelMembers(conv.channel).filter((n) => n !== "master");
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
      to = store.channelMembers(conv.channel).filter((n) => n !== "master"); // default: everyone
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
    store.leaveChannel(conv.channel, "master"); // master is not a persistent member
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
    // "master" is the human supervisor sentinel, not a registered agent: an agent
    // may address it to reach the supervisor (who reads it in the monitor).
    const unknown = to.filter((n) => n !== "master" && !store.hasAgent(n));
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
    // The conversation may have an active contract (DSP-style governance). If
    // it does and the message didn't name a `contract` explicitly, apply the
    // conv's contract. The relay then enforces presence of `data` and validates
    // it against the contract's schema before queueing.
    const convContract = conv?.contract_name ?? null;
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
      locale: config.readConfig().locale ?? null,
      policy: config.readPolicy() ?? "",
      defaultPolicy: DEFAULT_POLICY,
      contracts: config.listContracts(),
      reviewer: reviewerInfo(),
    });
  });

  api.post("/setup", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { mode, policy, contracts } = req.body ?? {};
    if (mode != null && !["manual", "auto", "llm"].includes(mode)) {
      return res.status(400).json({ error: "mode must be manual | auto | llm" });
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

  /* ---- Projects: a directory + engine + agent identity switchboard can launch.
   * The CLI runs in a PTY (see agents manager); its console streams over the
   * /console WebSocket. Definitions persist in config; process state is live. */
  api.get("/projects", (_req, res) => {
    if (!config) return res.json([]);
    const list = config.readProjects().map((p) => ({ ...p, status: agents?.statusOf(p.id) ?? "stopped" }));
    res.json(list);
  });

  api.post("/projects", async (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    const { mode = "existing", name, dir, parentDir, agentName, engine = "claude" } = req.body ?? {};
    try {
      let projectDir, projectName;
      if (mode === "new") {
        if (!config.validName(name)) return res.status(400).json({ error: "name required (letters, digits, . _ -)" });
        if (typeof parentDir !== "string" || !isAbsolute(parentDir.trim() || "")) {
          return res.status(400).json({ error: "parentDir required (absolute path)" });
        }
        projectDir = join(parentDir.trim(), name);
        if (existsSync(projectDir)) return res.status(400).json({ error: `already exists: ${projectDir}` });
        mkdirSync(projectDir, { recursive: true });
        await execFileAsync("git", ["-C", projectDir, "init"], { timeout: 15000 });
        writeFileSync(join(projectDir, "README.md"), `# ${name}\n`);
        projectName = name;
      } else {
        if (typeof dir !== "string" || !isAbsolute(dir.trim() || "")) {
          return res.status(400).json({ error: "dir required (absolute path)" });
        }
        projectDir = dir.trim();
        let st;
        try { st = statSync(projectDir); } catch { return res.status(400).json({ error: `directory not found: ${projectDir}` }); }
        if (!st.isDirectory()) return res.status(400).json({ error: `not a directory: ${projectDir}` });
        projectName = config.validName(name) ? name : basename(projectDir);
      }
      const finalAgent = config.validName(agentName) ? agentName : projectName;
      const project = config.addProject({ name: projectName, dir: projectDir, engine, agentName: finalAgent });
      broadcast({ type: "project.created", project });
      res.json(project);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete("/projects/:id", (req, res) => {
    if (!config) return res.status(409).json({ error: "no config store" });
    agents?.stop(req.params.id);
    if (!config.removeProject(req.params.id)) return res.status(404).json({ error: "project not found" });
    broadcast({ type: "project.deleted", id: req.params.id });
    res.json({ ok: true });
  });

  api.post("/projects/:id/agent/start", async (req, res) => {
    if (!config || !agents) return res.status(409).json({ error: "projects unavailable" });
    const project = config.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "project not found" });
    try {
      await agents.start(project);
      res.json({ projectId: project.id, status: agents.statusOf(project.id) });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  api.post("/projects/:id/agent/stop", (req, res) => {
    if (!agents) return res.status(409).json({ error: "projects unavailable" });
    const ok = agents.stop(req.params.id);
    res.json({ ok, status: agents.statusOf(req.params.id) });
  });

  app.use("/api", api);
}
