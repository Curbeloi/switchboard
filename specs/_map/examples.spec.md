---
source_hash: 0cbd69a39c3787f14efe4a9bdf3cbfc90c8f4b18
generated_at: 2026-06-29T20:43:08.526Z
---
# examples

## Purpose
A reference directory containing a single example configuration file that demonstrates how to wire the switchboard MCP server into a Claude Code project. It serves as onboarding documentation-as-config: copy or merge this file to get a Claude Code session connected to a running relay.

## Key Components
- mcp-config.example.json — annotated MCP server config showing the minimal `switchboard mcp` invocation with `--agent` and `--relay` flags

## Exports / Public Interface
Not a code module; the file is a drop-in template for `.mcp.json` in any Claude Code project.

## Dependencies
Depends on the `switchboard` CLI being available in PATH (installed globally via `npm`/`pnpm`) and a relay already running at the specified URL.

## Notes
The comment key `"//"` is a JSON convention for inline documentation. Each project consuming switchboard should give its agent a distinct `--agent` name to avoid 409 name-collision errors on the relay. The `--relay` URL defaults to `http://127.0.0.1:8765`, which matches the relay's default bind address — production deployments would override this.