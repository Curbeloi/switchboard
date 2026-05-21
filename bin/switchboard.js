#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startRelay } from "../src/relay/server.js";
import { startConsoleSupervisor } from "../src/relay/supervisor.js";
import { runMcp } from "../src/mcp/server.js";
import { installMcp, uninstallMcp, doctor } from "../src/install.js";

const HELP = `switchboard — supervised inter-agent messaging relay

Usage:
  switchboard start [--port N] [--host HOST] [--auto]
      Start the relay server with HTTP API, WebSocket stream, supervision UI,
      and a console supervisor REPL on the same terminal (when stdin is a TTY).
      Defaults: --port 8765, --host 127.0.0.1. Approval mode is ON by default;
      pass --auto to start without supervision (deliver everything).

  switchboard mcp --agent NAME [--relay URL]
      Run as an MCP stdio server. Registers as agent NAME against the relay.
      Defaults: --relay http://127.0.0.1:8765

  switchboard install --agent NAME [--relay URL] [--force] [--print]
      Add the switchboard MCP block to .mcp.json in the current directory.
      Merges with existing mcpServers; pass --force to overwrite an existing
      switchboard entry. --print outputs the result without writing.

  switchboard uninstall
      Remove the switchboard MCP block from .mcp.json in the current directory.

  switchboard doctor [--relay URL]
      Check that the relay is reachable and that .mcp.json in the current
      directory is correctly configured.

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
      },
      strict: true,
    });
    const relay = await startRelay({ port: Number(values.port), host: values.host });
    if (values.auto) {
      relay.store.setApprovalMode(false);
      relay.broadcast({ type: "approval.mode", mode: false });
    }
    const supervisor = startConsoleSupervisor({
      store: relay.store,
      broadcast: relay.broadcast,
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
        force: { type: "boolean", default: false },
        print: { type: "boolean", default: false },
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
      force: values.force,
      print: values.print,
    });
  } else if (subcommand === "uninstall") {
    parseArgs({ args: rest, options: {}, strict: true });
    await uninstallMcp();
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
