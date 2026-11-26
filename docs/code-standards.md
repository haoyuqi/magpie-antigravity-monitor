# Code Standards

## Runtime and dependencies

- **Zero external npm dependencies**: Every module in `src/` and `test/` uses pure ESM and Node/Bun built-ins only.
- **Dual-runtime compatibility (Bun + Node)**:
  - All production code targets Magpie's bundled **Bun** host and must also run cleanly under Node 22.5+ for local verification.
  - Because Bun does not ship `node:sqlite`, callers that touch SQLite must run `installBunSqliteShim()` before opening databases via `sqlite-client.mjs`.

## Structural read-only boundary

- **No invasive host modules**: Modules that mutate Antigravity configs, inject CDP overlays, hijack CloudCode proxies, switch accounts, patch host i18n, or self-update plugins are excluded from the repository by design.
- **Fail-closed API allowlisting**: Every HTTP route and `/api/settings` patch must pass `isAllowedApiRoute()`, `!hasBlockedSettingsAction()`, and `sanitizeSettingsPatch()` in [src/telemetry/allowlist.mjs](../src/telemetry/allowlist.mjs).
- **Isolated persistence**: Runtime caches, SQLite ledgers, and preferences are written only inside `DATA_DIR` (resolved via [src/runtime/paths.mjs](../src/runtime/paths.mjs)), never inside `~/.gemini` or `~/.config/magpie`.

## Testing standards

- **Offline and temp-dir isolated**: Tests must set `USAGE_MONITOR_DATA_DIR`, `ANTIGRAVITY_GEMINI_DIR`, and `ANTIGRAVITY_LS_ADDRESS=test.invalid` (or local mock servers) before importing telemetry modules, and clean up all temp directories afterward.
- **Verify under both runtimes**: Run both `node --test test/*.test.mjs` and `bun test test/` before opening or updating a PR.
- **Fail without the fix**: Every new guard or bug fix must include a test that fails when the guard/fix is removed.
