import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/** Per-(relay, agent) tokens persist here so a session restart re-claims its own
 *  name instead of colliding with the still-registered identity on a live relay.
 *  Always under ~/.switchboard — independent of the relay's --config-dir. */
export const TOKEN_DIR = join(homedir(), ".switchboard");
export const TOKEN_FILE = join(TOKEN_DIR, "tokens.json");

/** The key under which a token is stored: one per (relay URL, agent name). */
export const tokenKey = (relayUrl, agent) => `${relayUrl}::${agent}`;

export function loadToken(key) {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8"))[key] ?? null;
  } catch {
    return null;
  }
}

export function saveToken(key, token) {
  let data = {};
  try {
    data = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    /* fresh file */
  }
  data[key] = token;
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  } catch {
    /* best-effort */
  }
}
