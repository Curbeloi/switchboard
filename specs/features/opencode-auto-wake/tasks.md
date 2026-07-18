# Tasks: opencode-auto-wake

> Created: 2026-06-29 | Author: Hector Curbelo Barrios <hcurbelo@gmail.com>
> Scope: `src/install.js` only. Relay/store/manager/console unchanged.

## 1. Plugin source generator (install.js)
- [x] Add `opencodeWakePluginBody({ agent, relay })` returning the plugin source text,
      embedding `agent`/`relay` safely (`JSON.stringify`). Mirrors `src/listen.js`
      `poll()`: `GET /api/conversations?status=all` → for joined convs
      `GET /api/conversations/:id/messages?since=<ts>`; "for me" = `to.includes(agent) || conv.isDm`; skip `from === agent`; watermark seeded to load time (in-memory).
- [x] Plugin injects via SDK: resolve session id from the `event` hook, fallback
      `client.session.list()` (most recent); inject with
      `client.session.promptAsync({ path:{id}, body:{ parts:[{type:"text", text}] } })`.
      Wake text mirrors the listener's line (read & reply with `agent_read("<id>")`).
- [x] Robustness: poll every ~5s on `setInterval` (unref'd); `busy` guard against
      overlap; swallow all fetch/inject errors; no-op when no session id yet (retry
      next tick). Imports nothing from switchboard.

## 2. Wire into installOpencode (install.js)
- [x] After writing `opencode.json` + instruction file, write
      `<cwd>/.opencode/plugins/switchboard-wake.js` via `opencodeWakePluginBody`
      (idempotent: skip if present unless `force`; `mkdir -p` the plugins dir).
- [x] Extend the return value (`pluginPath`, `pluginCreated`) + stdout log.

## 3. Uninstall cleanup (install.js)
- [x] In `uninstallMcp`, remove `<cwd>/.opencode/plugins/switchboard-wake.js` if present
      (best-effort; leave other plugins/files intact).

## 4. Verify
- [x] `node --check src/install.js`; generated plugin written to a temp `.mjs` and
      `node --check`ed (valid standalone ESM); regex escaping (`/\/+$/`, `/\s+/g`)
      asserted intact.
- [x] Test (`tests/opencode-wake.test.js`, `node:test`): `opencodeWakePluginBody`
      embeds agent+relay, is parseable ESM, has no relative imports; `installOpencode`
      writes the plugin (idempotent + `force` overwrites) in a temp cwd, opencode.json
      unaffected. (Uninstall plugin-removal verified by inspection — `uninstallMcp`
      shells `claude mcp remove`, a global side effect not run in automated tests.)
- [x] `pnpm test` green (34/34); `sdd spec refresh`.
- [ ] (Supervisor E2E, manual) documented in requirements — needs `opencode auth`.
