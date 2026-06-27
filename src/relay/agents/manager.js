import { createRequire } from "node:module";
import { installMcp } from "../../install.js";
import { tokenKey, loadToken, saveToken } from "../../tokens.js";

// node-pty is a native module (CJS) — load it through createRequire so this ESM
// file can use it. Provides a real pseudo-terminal so interactive CLIs (claude)
// render their TUI and accept input, exactly like a local terminal.
const require = createRequire(import.meta.url);
const pty = require("@homebridge/node-pty-prebuilt-multiarch");

const SCROLLBACK_CAP = 200_000; // chars kept per agent so late attachers see context

/**
 * Spawns and supervises engine CLIs (Claude Code for now) as PTY-backed child
 * processes, one per project. Each running agent streams its terminal to any
 * number of attached WebSocket clients (the web console) and accepts their input.
 * Process state is in-memory by nature; project definitions live in config.js.
 */
export function createAgentManager({ relay, broadcast, store } = {}) {
  const procs = new Map(); // projectId -> { project, term, status, buffer, clients:Set, startedAt }

  const emit = (projectId, status, extra = {}) =>
    broadcast?.({ type: "agent.proc", projectId, status, ...extra });

  /** Pre-register the agent identity so it appears (and is addable to channels)
   *  immediately — at project creation and at start — without waiting for claude
   *  to finish onboarding and connect its MCP. The spawned MCP wrapper reads the
   *  same persisted token and reuses this identity (no name collision). No-op if
   *  the name is already owned by a different identity. */
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

  function statusOf(projectId) {
    return procs.get(projectId)?.status ?? "stopped";
  }
  function list() {
    return [...procs.values()].map((r) => ({
      projectId: r.project.id,
      status: r.status,
      startedAt: r.startedAt,
    }));
  }

  /** Wire identity + spawn the engine CLI in a PTY at the project's directory. */
  async function start(project) {
    const existing = procs.get(project.id);
    if (existing && existing.status === "running") return existing;

    // 0) Make the identity exist up front (visible + addable to channels now).
    registerIdentity(project.agentName);

    // 1) Identity wiring (idempotent). Claude: `claude mcp add` + skill + hook so
    //    the spawned session connects to this relay as `agentName`.
    if (project.engine === "claude") {
      await installMcp({ agent: project.agentName, relay, cwd: project.dir, force: true });
    } else {
      throw new Error(`unsupported engine: ${project.engine}`);
    }

    // 2) Spawn the CLI in a pseudo-terminal at the project directory.
    const cmd = project.engine === "claude" ? "claude" : project.engine;
    let term;
    try {
      term = pty.spawn(cmd, [], {
        name: "xterm-color",
        cols: 80,
        rows: 24,
        cwd: project.dir,
        env: process.env,
      });
    } catch (err) {
      throw new Error(`failed to launch "${cmd}" in ${project.dir}: ${err.message}`);
    }

    const rec = {
      project,
      term,
      status: "running",
      buffer: "",
      clients: new Set(),
      startedAt: Date.now(),
    };
    procs.set(project.id, rec);

    term.onData((data) => {
      rec.buffer += data;
      if (rec.buffer.length > SCROLLBACK_CAP) rec.buffer = rec.buffer.slice(-SCROLLBACK_CAP);
      for (const ws of rec.clients) if (ws.readyState === ws.OPEN) ws.send(data);
    });
    term.onExit(({ exitCode }) => {
      rec.status = "exited";
      const note = `\r\n[switchboard] agent exited (code ${exitCode})\r\n`;
      for (const ws of rec.clients) if (ws.readyState === ws.OPEN) ws.send(note);
      emit(project.id, "exited", { exitCode });
    });

    emit(project.id, "running");
    return rec;
  }

  function stop(projectId) {
    const rec = procs.get(projectId);
    if (!rec) return false;
    try { rec.term.kill(); } catch { /* already dead */ }
    rec.status = "stopped";
    emit(projectId, "stopped");
    return true;
  }

  /** Attach a WS client to a project's terminal: replay scrollback, then live I/O.
   *  Client → PTY is raw keystrokes; a `\x00`-prefixed JSON message is a control
   *  frame (currently just `{resize:{cols,rows}}`). */
  function attach(ws, projectId) {
    const rec = procs.get(projectId);
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
