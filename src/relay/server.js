import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { WebSocketServer } from "ws";
import { createStore } from "./store.js";
import { mountRoutes } from "./routes/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATIC_DIR = join(__dirname, "..", "ui", "static");

export async function startRelay({ port = 8765, host = "127.0.0.1" } = {}) {
  const store = createStore();
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

  mountRoutes(app, { store, broadcast });

  /* Static supervision UI */
  app.use("/", express.static(STATIC_DIR));

  /* HTTP + WS on same port */
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/subscribe" });
  wss.on("connection", (ws) => {
    subscribers.add(ws);
    ws.send(JSON.stringify({ type: "hello", approvalMode: store.getApprovalMode() }));
    ws.on("close", () => subscribers.delete(ws));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      process.stdout.write(`switchboard relay listening on http://${host}:${port}\n`);
      process.stdout.write(`  supervision UI:  http://${host}:${port}/\n`);
      process.stdout.write(`  HTTP API:        http://${host}:${port}/api\n`);
      process.stdout.write(`  WebSocket:       ws://${host}:${port}/subscribe\n`);
      resolve({ server, store, broadcast, subscribe });
    });
  });
}
