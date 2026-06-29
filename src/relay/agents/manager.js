import { createRequire } from "node:module";
import { installMcp, installOpencode } from "../../install.js";
import { tokenKey, loadToken, saveToken } from "../../tokens.js";

// node-pty is a native module (CJS) — load it through createRequire so this ESM
// file can use it. Provides a real pseudo-terminal so interactive CLIs (claude)
// render their TUI and accept input, exactly like a local terminal.
const require = createRequire(import.meta.url);
const pty = require("@homebridge/node-pty-prebuilt-multiarch");

const SCROLLBACK_CAP = 200_000; // chars kept per agent so late attachers see context

/**
 * Spawns and supervises engine CLIs (Claude Code for now) as PTY-backed child
 * processes, one per ENVIRONMENT (a project's directory + agent identity). Each
 * running agent streams its terminal to any number of attached WebSocket clients
 * (the web console) and accepts their input. Process state is in-memory by
 * nature; environment definitions live in config.js.
 */
export function createAgentManager({ relay, broadcast, store } = {}) {
  const procs = new Map(); // environmentId -> { env, term, status, buffer, clients:Set, startedAt }

  const emit = (environmentId, status, extra = {}) =>
    broadcast?.({ type: "agent.proc", environmentId, status, ...extra });

  /** Pre-register the agent identity so it appears (and is addable to
   *  conversations) immediately — at environment creation and at start — without
   *  waiting for claude to finish onboarding and connect its MCP. The spawned MCP
   *  wrapper reads the same persisted token and reuses this identity (no name
   *  collision). No-op if the name is already owned by a different identity. */
  function registerIdentity(agentName) {
    if (!store || !agentName) return;
    try {
      const key = tokenKey(relay, agentName);
      const reg = store.registerAgent(agentName, loadToken(key) || undefined);
      if (reg) {
        saveToken(key, reg.token);
        broadcast?.({ type: "agent.registered", agent: { name: reg.name, registeredAt: reg.registeredAt } });
      }
    } catch { /* name owned elsewhere — leave it to the MCP wrapper */ }
  }

  /**
   * Kick a freshly-started agent into its listen loop. A spawned `claude`
   * connects its MCP but, with no user turn, never acts on the SessionStart
   * nudge to start listening — so once its TUI is ready we type the arm command
   * into the PTY ourselves. This is what makes an environment "start listening"
   * the moment it starts. The command text and the Enter are written SEPARATELY:
   * a single chunk ending in CR is taken as a paste (a newline inside the input
   * box), not a submit. We gate on the prompt being ready (the "shortcuts" hint)
   * so we never type into an onboarding/trust screen; give up after a while and
   * leave it to a human (kick it from the console).
   */
  function armListener(rec) {
    // Auto-arm is Claude Code-specific: it gates on Claude's "shortcuts" TUI hint
    // and Claude's PTY submit semantics. Other engines (opencode) are still wired
    // (MCP + instructions) but you arm the listener from their console once.
    if (rec.env.engine !== "claude") return;
    const agent = rec.env.agentName;
    const cmd = `switchboard listen --agent ${agent} --once`;
    const text =
      `You are the switchboard agent "${agent}". Start listening for messages from ` +
      `other agents NOW: run this exact command with run_in_background: ${cmd}  — when it ` +
      `exits, a message has arrived; then call agent_read with the conversation id it ` +
      `printed, reply in that conversation, and relaunch the same command to keep listening.`;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (rec.status !== "running") { clearInterval(timer); return; }
      if (!/shortcuts/.test(rec.buffer)) {
        if (Date.now() - startedAt > 60000) clearInterval(timer); // give up; human can kick via console
        return;
      }
      clearInterval(timer);
      try {
        rec.term.write(text);
        setTimeout(() => { try { rec.term.write("\r"); } catch { /* terminal gone */ } }, 700);
      } catch { /* terminal gone */ }
    }, 700);
  }

  function statusOf(environmentId) {
    return procs.get(environmentId)?.status ?? "stopped";
  }
  function list() {
    return [...procs.values()].map((r) => ({
      environmentId: r.env.id,
      status: r.status,
      startedAt: r.startedAt,
    }));
  }

  /** Wire identity + spawn the engine CLI in a PTY at the environment's directory. */
  async function start(env) {
    const existing = procs.get(env.id);
    if (existing && existing.status === "running") return existing;

    // 0) Make the identity exist up front (visible + addable to conversations now).
    registerIdentity(env.agentName);

    // 1) Identity wiring (idempotent), per engine, so the spawned session
    //    connects to this relay as `agentName`. Claude: `claude mcp add` + skill
    //    + SessionStart hook. OpenCode: write opencode.json (mcp.switchboard) +
    //    an instructions file.
    if (env.engine === "claude") {
      await installMcp({ agent: env.agentName, relay, cwd: env.dir, force: true });
    } else if (env.engine === "opencode") {
      await installOpencode({ agent: env.agentName, relay, cwd: env.dir, force: true });
    } else {
      throw new Error(`unsupported engine: ${env.engine}`);
    }

    // 2) Spawn the CLI in a pseudo-terminal at the environment directory.
    const cmd = env.engine === "claude" ? "claude" : env.engine;
    let term;
    try {
      term = pty.spawn(cmd, [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: env.dir,
        env: process.env,
      });
    } catch (err) {
      throw new Error(`failed to launch "${cmd}" in ${env.dir}: ${err.message}`);
    }

    const rec = {
      env,
      term,
      status: "running",
      buffer: "",
      clients: new Set(),
      startedAt: Date.now(),
    };
    procs.set(env.id, rec);

    term.onData((data) => {
      rec.buffer += data;
      if (rec.buffer.length > SCROLLBACK_CAP) rec.buffer = rec.buffer.slice(-SCROLLBACK_CAP);
      for (const ws of rec.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    });
    term.onExit(({ exitCode }) => {
      rec.status = "exited";
      const note = `\r\n[switchboard] agent exited (code ${exitCode})\r\n`;
      for (const ws of rec.clients) if (ws.readyState === ws.OPEN) ws.send(note);
      emit(env.id, "exited", { exitCode });
    });

    emit(env.id, "running");
    armListener(rec); // auto-start listening once the TUI is ready
    return rec;
  }

  function stop(environmentId) {
    const rec = procs.get(environmentId);
    if (!rec) return false;
    try { rec.term.kill(); } catch { /* already dead */ }
    rec.status = "stopped";
    emit(environmentId, "stopped");
    return true;
  }

  /** Attach a WS client to an environment's terminal: replay scrollback, then live
   *  I/O. Client → PTY is raw keystrokes; a `\x00`-prefixed JSON message is a
   *  control frame (currently just `{resize:{cols,rows}}`). */
  function attach(ws, environmentId) {
    const rec = procs.get(environmentId);
    if (!rec || rec.status !== "running") {
      try { ws.send("\r\n[switchboard] agent is not running\r\n"); ws.close(); } catch { /* noop */ }
      return;
    }
    rec.clients.add(ws);
    if (rec.buffer) { try { ws.send(rec.buffer); } catch { /* noop */ } }
    ws.on("message", (data) => {
      const s = data.toString();
      if (s[0] === "\x00") {
        try {
          const ctrl = JSON.parse(s.slice(1));
          if (ctrl.resize?.cols && ctrl.resize?.rows) rec.term.resize(ctrl.resize.cols, ctrl.resize.rows);
        } catch { /* ignore malformed control */ }
        return;
      }
      try { rec.term.write(s); } catch { /* terminal gone */ }
    });
    ws.on("close", () => rec.clients.delete(ws));
  }

  function shutdown() {
    for (const rec of procs.values()) { try { rec.term.kill(); } catch { /* noop */ } }
    procs.clear();
  }

  return { start, stop, attach, statusOf, list, shutdown, registerIdentity };
}
