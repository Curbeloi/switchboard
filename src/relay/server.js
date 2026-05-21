import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { createStore } from "./store.js";
import { mountRoutes } from "./routes/index.js";
import { createReviewer } from "./reviewer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATIC_DIR = join(__dirname, "..", "ui", "static");

export async function startRelay({
  port = 8765,
  host = "127.0.0.1",
  reviewPolicy,
  reviewModel,
} = {}) {
  const store = createStore();
  const reviewer = createReviewer({ policy: reviewPolicy, model: reviewModel });
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  /** Broadcast helper — pushed into routes so they can notify subscribers.
   *  Fan-out is to two audiences: WebSocket clients (the web UI), and
   *  in-process listeners (the console supervisor). */
  const subscribers = new Set();
  const localListeners = new Set();
  function broadcast(event) {
    const payload = JSON.stringify(event);
    for (const ws of subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
    for (const fn of localListeners) {
      try { fn(event); } catch { /* listener errors must not break the relay */ }
    }
  }
  function subscribe(fn) {
    localListeners.add(fn);
    return () => localListeners.delete(fn);
  }

  mountRoutes(app, { store, broadcast, reviewer });

  /* In "llm" mode, the reviewer drains the pending queue automatically:
   *  approve/reject deliver or drop the message; escalate leaves it pending
   *  for a human. Reviewer failures escalate (fail safe) — never auto-approve. */
  if (reviewer.available) {
    subscribe(async (event) => {
      if (event.type !== "message.pending") return;
      if (store.getMode() !== "llm") return;
      const msg = event.message;
      const { decision, reason } = await reviewer.review(msg);
      const review = { decision, reason, at: Date.now(), by: reviewer.backend };
      if (decision === "approve") {
        const delivered = store.approvePending(msg.id, review);
        if (delivered) broadcast({ type: "message.delivered", message: delivered });
      } else if (decision === "reject") {
        const rejected = store.rejectPending(msg.id, review);
        if (rejected) broadcast({ type: "message.rejected", message: rejected });
      } else {
        const escalated = store.markEscalated(msg.id, reason);
        if (escalated) broadcast({ type: "message.escalated", message: escalated });
      }
    });
  }

  /* Static supervision UI */
  app.use("/", express.static(STATIC_DIR));

  /* HTTP + WS on same port */
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/subscribe" });
  wss.on("connection", (ws) => {
    subscribers.add(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        mode: store.getMode(),
        reviewer: { available: reviewer.available, backend: reviewer.backend },
      })
    );
    ws.on("close", () => subscribers.delete(ws));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      process.stdout.write(`switchboard relay listening on http://${host}:${port}\n`);
      process.stdout.write(`  supervision UI:  http://${host}:${port}/\n`);
      process.stdout.write(`  HTTP API:        http://${host}:${port}/api\n`);
      process.stdout.write(`  WebSocket:       ws://${host}:${port}/subscribe\n`);
      process.stdout.write(
        reviewer.available
          ? `  LLM reviewer:    available (${reviewer.backend}) — 'llm' mode enabled\n`
          : `  LLM reviewer:    unavailable (no ANTHROPIC_API_KEY and no claude CLI) — 'llm' mode disabled\n`
      );
      resolve({ server, store, broadcast, subscribe, reviewer });
    });
  });
}
