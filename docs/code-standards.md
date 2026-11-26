# Code Standards

## Runtime and dependencies

- **Zero external npm dependencies**: Every module in `src/` and `test/` uses pure ESM and Node/Bun built-ins only.
- **English-only repository**: All source code, comments, JSDoc, string literals, tests, and documentation must be written in English with zero CJK characters.
- **Dual-runtime compatibility (Bun + Node)**:
  - All production code targets Magpie's bundled **Bun** host and must also run cleanly under Node 22.5+ for local verification.
  - Because Bun does not ship `node:sqlite`, callers that touch SQLite must run `installBunSqliteShim()` before opening databases via `sqlite-client.mjs`.

## Structural read-only boundary

- **No invasive host modules**: Modules that mutate Antigravity configs, inject CDP overlays, hijack CloudCode proxies, switch accounts, patch host i18n, or self-update plugins are excluded from the repository by design.
- **Zero-sidecar SQLite reads**: Read-only queries must never open host WAL databases in-place or create `-wal`/`-shm` sidecars in Antigravity directories. Every `withReadOnlySqliteDb()` read (including when `-wal` is initially empty or absent) uses a double-fenced in-memory snapshot with bounded retries (returning `null` to skip the round if concurrent checkpoints persist) before opening a private temp copy.
- **Strictly local-disk telemetry (no Language Server RPC or quota polling)**: All telemetry is built exclusively from local Antigravity disk artifacts (`conversations/*.db`, `annotations/*.pbtxt`, `transcript.jsonl`, `.deep_stats_cache.json`). Zero Language Server Connect-RPC calls, zero process/port/daemon (`hub_*.json`) scanning, zero official quota API calls, and zero OAuth/keyring access. On macOS Bun where `{ readOnly: true }` can throw `SQLITE_CANTOPEN` (`errcode: 14`) against closed WAL files, `trajectory-sqlite-ledger.mjs` falls back to `PRAGMA query_only = ON` on the plugin-owned `trajectory_store.sqlite`.
- **Shared catalog validation**: `syncCloudCatalog()` must validate payloads through `sanitizeCatalogPayload()` so sync and load agree on the `pricing` schema, and must check `saveJson()`'s boolean return value before updating sync success state.
- **Fail-closed API allowlisting**: Every HTTP route and `/api/settings` patch must pass `isAllowedApiRoute()`, `!hasBlockedSettingsAction()`, and `sanitizeSettingsPatch()` in [src/telemetry/allowlist.mjs](../src/telemetry/allowlist.mjs).
- **Local HTTP service & Magpie sandbox**:
  - `page/index.html` and `page/boot.js` run under `sandbox="allow-scripts"` and `connect-src 'none'`: zero inline scripts, zero `fetch`/`XHR`/`WebSocket`/`localStorage`/`cookie` usage, navigating only via `location.replace`.
  - [src/server/http-server.mjs](../src/server/http-server.mjs) binds strictly to `127.0.0.1`, enforces loopback client address, `Host`, and `Origin` checks, requires `Sec-Fetch-Mode: navigate` (or `Accept: text/html` with no `Origin` and no `Sec-Fetch-Mode` for plain-HTTP `magpie web --lan` navigations) on token-bearing `GET /` / `GET /index.html` (never returning `Set-Cookie` or `Access-Control-Allow-Origin`), authenticates `/api/*` via per-process `X-Usage-Monitor-Token`, and immediately falls back to background `EADDRINUSE` retry (`bindTries = 1`) during Magpie rolling restarts.
  - All frontend asset and API calls in `src/ui/` must use relative `./` paths via `window.sidecar.fetch` and safe DOM construction (`textContent`, never injecting untrusted telemetry strings into `innerHTML`).
- **Isolated persistence**: Runtime caches, SQLite ledgers, and preferences are written only inside `DATA_DIR` (resolved via [src/runtime/paths.mjs](../src/runtime/paths.mjs)), never inside `~/.gemini` or `~/.config/magpie`.

## Testing standards

- **Offline and temp-dir isolated**: Tests must set `USAGE_MONITOR_DATA_DIR`, `ANTIGRAVITY_GEMINI_DIR`, and clear `ANTIGRAVITY_APP_DATA_DIR`/`USAGE_MONITOR_APP_DATA_DIR` before importing `paths.mjs` or telemetry modules, stub `globalThis.fetch` to fail on unexpected calls, and clean up all temp directories afterward.
- **Verify under both runtimes**: Run both `node --test test/*.test.mjs` and `bun test test/` before opening or updating a PR.
- **Fail without the fix**: Every new guard or bug fix must include a test that fails when the guard/fix is removed.
