#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { startRelay } from "../src/relay/server.js";
import { startConsoleSupervisor } from "../src/relay/supervisor.js";
import { runMcp } from "../src/mcp/server.js";
import { installMcp, uninstallMcp, doctor } from "../src/install.js";

const HELP = `switchboard — supervised inter-agent messaging relay

Usage:
  switchboard start [--port N] [--host HOST] [--auto] [--review-policy FILE] [--review-model ID]
      Start the relay server with HTTP API, WebSocket stream, supervision UI,
      and a console supervisor REPL on the same terminal (when stdin is a TTY).
      Defaults: --port 8765, --host 127.0.0.1. Supervision mode is 'manual' by
      default (every message waits for approval); pass --auto to deliver without
      supervision. The 'llm' mode (set in the REPL/UI) uses an LLM reviewer —
      available when ANTHROPIC_API_KEY is set or the claude CLI is installed.
      --review-policy points at a markdown rubric for the reviewer; --review-model
      overrides the model (default claude-haiku-4-5).

  switchboard mcp --agent NAME [--relay URL]
      Run as an MCP stdio server. Registers as agent NAME against the relay.
      Defaults: --relay http://127.0.0.1:8765

  switchboard install --agent NAME [--relay URL] [--scope SCOPE] [--force]
      Register the switchboard MCP server for this project via the claude CLI
      (default --scope local: per-project, stored in ~/.claude.json, never
      touches the project's .mcp.json) and create the project's switchboard
      skill. --scope is local | user | project. --force replaces an existing
      registration and refreshes the skill.

  switchboard uninstall [--keep-skill]
      Remove the switchboard MCP registration (via claude) and the project
      skill. Pass --keep-skill to leave the skill in place.

  switchboard doctor [--relay URL]
      Check that the relay is reachable, the MCP server is registered for this
      project, and the skill is present.

  switchboard --help
      This help.
`;

function help() {
  process.stdout.write(HELP);
}

const [, , subcommand, ...rest] = process.argv;

if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  help();
  process.exit(0);
}

try {
  if (subcommand === "start") {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: "string", default: "8765" },
        host: { type: "string", default: "127.0.0.1" },
        auto: { type: "boolean", default: false },
        "review-policy": { type: "string" },
        "review-model": { type: "string" },
      },
      strict: true,
    });
    let reviewPolicy;
    if (values["review-policy"]) {
      reviewPolicy = readFileSync(values["review-policy"], "utf8");
    }
    const relay = await startRelay({
      port: Number(values.port),
      host: values.host,
      reviewPolicy,
      reviewModel: values["review-model"],
    });
    if (values.auto) {
      relay.store.setMode("auto");
      relay.broadcast({ type: "approval.mode", mode: "auto" });
    }
    const supervisor = startConsoleSupervisor({
      store: relay.store,
      broadcast: relay.broadcast,
      reviewer: relay.reviewer,
    });
    if (supervisor) relay.subscribe(supervisor.onEvent);
  } else if (subcommand === "mcp") {
    const { values } = parseArgs({
      args: rest,
      options: {
        agent: { type: "string" },
        relay: { type: "string", default: "http://127.0.0.1:8765" },
      },
      strict: true,
    });
    if (!values.agent) {
      process.stderr.write("error: --agent NAME is required\n\n");
      help();
      process.exit(2);
    }
    await runMcp({ agent: values.agent, relayUrl: values.relay });
  } else if (subcommand === "install") {
    const { values } = parseArgs({
      args: rest,
      options: {
        agent: { type: "string" },
        relay: { type: "string", default: "http://127.0.0.1:8765" },
        scope: { type: "string", default: "local" },
        force: { type: "boolean", default: false },
      },
      strict: true,
    });
    if (!values.agent) {
      process.stderr.write("error: --agent NAME is required\n\n");
      help();
      process.exit(2);
    }
    await installMcp({
      agent: values.agent,
      relay: values.relay,
      scope: values.scope,
      force: values.force,
    });
  } else if (subcommand === "uninstall") {
    const { values } = parseArgs({
      args: rest,
      options: { "keep-skill": { type: "boolean", default: false } },
      strict: true,
    });
    await uninstallMcp({ keepSkill: values["keep-skill"] });
  } else if (subcommand === "doctor") {
    const { values } = parseArgs({
      args: rest,
      options: {
        relay: { type: "string", default: "http://127.0.0.1:8765" },
      },
      strict: true,
    });
    await doctor({ relay: values.relay });
  } else {
    process.stderr.write(`unknown subcommand: ${subcommand}\n\n`);
    help();
    process.exit(2);
  }
} catch (err) {
  process.stderr.write(`switchboard: ${err.message}\n`);
  process.exit(1);
}
