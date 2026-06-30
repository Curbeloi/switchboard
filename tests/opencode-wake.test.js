import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { opencodeWakePluginBody, installOpencode } from "../src/install.js";

const PLUGIN_REL = join(".opencode", "plugins", "switchboard-wake.js");

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

test("opencodeWakePluginBody bakes in agent + relay and is valid ESM", async () => {
  const src = opencodeWakePluginBody({ agent: "Reviewer", relay: "http://127.0.0.1:8765" });
  assert.match(src, /const AGENT = "Reviewer"/);
  assert.match(src, /"http:\/\/127\.0\.0\.1:8765"/);
  // mirrors the listener: SDK injection + skip-own + read-only poll
  assert.ok(src.includes("client.session.promptAsync"), "injects via promptAsync");
  assert.ok(src.includes("m.from === AGENT"), "skips own messages (no loops)");
  assert.ok(src.includes("/api/conversations?status=all"), "polls read-only endpoint");
  // regex escaping survived the template (trailing-slash strip + whitespace squeeze)
  assert.ok(src.includes("replace(/\\/+$/"), "trailing-slash regex intact");
  assert.ok(src.includes("replace(/\\s+/g"), "whitespace regex intact");
  // imports nothing from switchboard (self-contained)
  assert.ok(!/from\s+["']\.\.?\//.test(src), "no relative imports");

  // parses as a real ES module
  const dir = await mkdtemp(join(tmpdir(), "sb-wake-"));
  const f = join(dir, "switchboard-wake.mjs");
  await writeFile(f, src, "utf8");
  execFileSync("node", ["--check", f]); // throws on syntax error
  await rm(dir, { recursive: true, force: true });
});

test("installOpencode writes the wake plugin (idempotent + force)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sb-oc-"));
  try {
    const r1 = await installOpencode({ agent: "Reviewer", relay: "http://127.0.0.1:8765", cwd });
    assert.equal(r1.pluginCreated, true);
    const pluginPath = join(cwd, PLUGIN_REL);
    assert.ok(await exists(pluginPath), "plugin file written");
    assert.equal(await readFile(pluginPath, "utf8"), opencodeWakePluginBody({ agent: "Reviewer", relay: "http://127.0.0.1:8765" }));

    // opencode.json still gets the MCP server + instructions (no regression)
    const cfg = JSON.parse(await readFile(join(cwd, "opencode.json"), "utf8"));
    assert.equal(cfg.mcp.switchboard.type, "local");
    assert.ok(cfg.instructions.includes(join(".switchboard", "switchboard.md")));

    // idempotent: a second call without force leaves a user-edited plugin alone
    await writeFile(pluginPath, "// edited by user\n", "utf8");
    const r2 = await installOpencode({ agent: "Reviewer", relay: "http://127.0.0.1:8765", cwd });
    assert.equal(r2.pluginCreated, false);
    assert.equal(await readFile(pluginPath, "utf8"), "// edited by user\n");

    // force overwrites it back to the generated source
    const r3 = await installOpencode({ agent: "Reviewer", relay: "http://127.0.0.1:8765", cwd, force: true });
    assert.equal(r3.pluginCreated, true);
    assert.ok((await readFile(pluginPath, "utf8")).includes("SwitchboardWake"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
