import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { createStore } from "./store.js";
import { mountRoutes } from "./routes/index.js";
import { createReviewer } from "./reviewer.js";
import { createConfigStore } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATIC_DIR = join(__dirname, "..", "ui", "static");

export async function startRelay({
  port = 8765,
  host = "127.0.0.1",
  reviewPolicy,
  reviewModel,
  configDir,
} = {}) {
  const config = createConfigStore(configDir);
  const store = createStore({ dbPath: join(config.dir, "switchboard.db") });
  // Restore persisted state written by the setup wizard / edit UI.
  const saved = config.readConfig();
  if (saved.mode) {
    try { store.setMode(saved.mode); } catch { /* ignore invalid persisted mode */ }
  }
  // Reviewer provider config persisted via Settings (provider/model/keys/baseUrl).
  // Policy precedence: --review-policy flag > persisted policy.md > built-in default.
  // Model precedence: --review-model flag > persisted reviewer.model > provider default.
  const reviewerCfg = config.readReviewerConfig();
  const reviewer = createReviewer({
    ...reviewerCfg,
    policy: reviewPolicy ?? config.readPolicy() ?? undefined,
    model: reviewModel ?? reviewerCfg.model,
    locale: config.readConfig().locale ?? null,
  });
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

  mountRoutes(app, { store, broadcast, reviewer, config });

  /* In "llm" mode, the reviewer drains the pending queue automatically:
   *  approve/reject deliver or drop the message; escalate leaves it pending
   *  for a human. Reviewer failures escalate (fail safe) — never auto-approve.
   *  Always subscribed (availability is checked per-event) so switching the
   *  provider on from Settings at runtime takes effect without a restart. */
  subscribe(async (event) => {
    if (event.type !== "message.pending") return;
    if (store.getMode() !== "llm") return;
    const msg = event.message;
    // Enrich the reviewer's view with the conversation's active contract,
    // so the policy can judge intent (DSP v1 contract awareness).
    const conv = store.getConversation(msg.conversationId);
    const enriched = { ...msg, contract_name: conv?.contract_name ?? null };
    const { decision, reason } = reviewer.available
      ? await reviewer.review(enriched)
      : { decision: "escalate", reason: "llm mode on but no reviewer available" };
    const review = { decision, reason, at: Date.now(), by: reviewer.backend ?? "reviewer" };
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
        reviewer: {
          available: reviewer.available,
          backend: reviewer.backend,
          provider: reviewer.provider,
          model: reviewer.model,
        },
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
          ? `  LLM reviewer:    available (${reviewer.backend}${reviewer.model ? `, ${reviewer.model}` : ""}) — 'llm' mode enabled\n`
          : `  LLM reviewer:    unavailable — pick a provider in Settings (or set ANTHROPIC_API_KEY / install claude CLI), then 'llm' mode enables\n`
      );
      resolve({ server, store, broadcast, subscribe, reviewer, config });
    });
  });
}
