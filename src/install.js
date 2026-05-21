import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MCP_FILE = ".mcp.json";
const DEFAULT_RELAY = "http://127.0.0.1:8765";

async function readConfig(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return { config: parsed, existed: true };
  } catch (err) {
    if (err.code === "ENOENT") return { config: {}, existed: false };
    if (err instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

function buildEntry({ agent, relay }) {
  return {
    command: "switchboard",
    args: ["mcp", "--agent", agent, "--relay", relay],
  };
}

export async function installMcp({
  agent,
  relay = DEFAULT_RELAY,
  force = false,
  print = false,
  cwd = process.cwd(),
} = {}) {
  if (!agent) throw new Error("--agent NAME is required");

  const path = join(cwd, MCP_FILE);
  const { config, existed } = await readConfig(path);

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  if (config.mcpServers.switchboard && !force) {
    throw new Error(
      `switchboard already configured in ${path}. Pass --force to overwrite.`
    );
  }

  config.mcpServers.switchboard = buildEntry({ agent, relay });
  const next = JSON.stringify(config, null, 2) + "\n";

  if (print) {
    process.stdout.write(next);
    return;
  }

  await writeFile(path, next, "utf8");
  process.stdout.write(
    `${existed ? "updated" : "created"} ${path} (agent: ${agent}, relay: ${relay})\n`
  );
  process.stdout.write(`restart Claude Code in this project to pick up the change.\n`);
}

export async function uninstallMcp({ cwd = process.cwd() } = {}) {
  const path = join(cwd, MCP_FILE);
  const { config, existed } = await readConfig(path);

  if (!existed) {
    process.stdout.write(`no ${MCP_FILE} in ${cwd}; nothing to do.\n`);
    return;
  }
  if (!config.mcpServers?.switchboard) {
    process.stdout.write(`switchboard not configured in ${path}; nothing to do.\n`);
    return;
  }

  delete config.mcpServers.switchboard;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;

  const next = JSON.stringify(config, null, 2) + "\n";
  await writeFile(path, next, "utf8");
  process.stdout.write(`removed switchboard from ${path}.\n`);
}

export async function doctor({ relay = DEFAULT_RELAY, cwd = process.cwd() } = {}) {
  let ok = true;

  try {
    const res = await fetch(`${relay}/api/health`);
    if (res.ok) {
      const body = await res.json();
      process.stdout.write(
        `[ok]   relay at ${relay} reachable (approval mode: ${body.approvalMode ? "on" : "off"})\n`
      );
    } else {
      ok = false;
      process.stdout.write(`[fail] relay at ${relay} responded ${res.status}\n`);
    }
  } catch (err) {
    ok = false;
    process.stdout.write(`[fail] relay at ${relay} unreachable: ${err.message}\n`);
    process.stdout.write(`       start it with: switchboard start\n`);
  }

  const path = join(cwd, MCP_FILE);
  try {
    const { config, existed } = await readConfig(path);
    if (!existed) {
      ok = false;
      process.stdout.write(
        `[fail] no ${MCP_FILE} in ${cwd} — run: switchboard install --agent NAME\n`
      );
    } else {
      const entry = config.mcpServers?.switchboard;
      if (!entry) {
        ok = false;
        process.stdout.write(
          `[fail] ${path} has no 'switchboard' entry — run: switchboard install --agent NAME\n`
        );
      } else {
        const args = Array.isArray(entry.args) ? entry.args : [];
        const agentIdx = args.indexOf("--agent");
        const relayIdx = args.indexOf("--relay");
        const agent = agentIdx >= 0 ? args[agentIdx + 1] : "(missing)";
        const configuredRelay = relayIdx >= 0 ? args[relayIdx + 1] : "(default)";
        process.stdout.write(
          `[ok]   ${path} configures switchboard (agent: ${agent}, relay: ${configuredRelay})\n`
        );
      }
    }
  } catch (err) {
    ok = false;
    process.stdout.write(`[fail] ${err.message}\n`);
  }

  if (!ok) process.exit(1);
}
