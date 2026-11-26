# Code Map

## Repository structure (implemented)

| Path | Layer | Responsibility | Key Invariants |
| --- | --- | --- | --- |
| [data/pricing-catalog.json](../data/pricing-catalog.json) | Data | Bundled fallback model pricing catalog | Read-only fallback; never mutated at runtime |
| [src/runtime/bun-sqlite-shim.mjs](../src/runtime/bun-sqlite-shim.mjs) | Runtime | Adapts `bun:sqlite` to `globalThis.DatabaseSync` for Bun hosts | Installed before SQLite readers; `{ readOnly: true }` enforced |
| [src/runtime/paths.mjs](../src/runtime/paths.mjs) | Runtime | Resolves isolated `DATA_DIR`, read-only `~/.gemini/antigravity*` roots, and runtime endpoint/cache state | Never writes into `~/.gemini` or `~/.config/magpie` |
| [src/runtime/pricing-sync.mjs](../src/runtime/pricing-sync.mjs) | Runtime | Syncs `pricing-catalog.json` into `REMOTE_CATALOG_CACHE_FILE` with TTL/cooldown | Catalog sync only; zero plugin self-update or restart logic |
| [src/telemetry/index.mjs](../src/telemetry/index.mjs) | Telemetry API | Public entrypoint for the read-only telemetry kernel and allowlist | Single entry module for server adapter & tests |
| [src/telemetry/allowlist.mjs](../src/telemetry/allowlist.mjs) | Security | Fail-closed API route allowlist & settings payload sanitizer | Blocks all host-mutating routes and `__*` sub-actions |
| [src/telemetry/local-endpoint.mjs](../src/telemetry/local-endpoint.mjs) | Telemetry | Local-only endpoint adapter replacing multi-endpoint CDP registry | Loopback/local only; no remote CDP tier |
| [src/telemetry/ls-discovery.mjs](../src/telemetry/ls-discovery.mjs) | Telemetry | Discovers local `hub_*.json` or `agy`/`language_server` ports and `csrfToken` | Read-only process/daemon inspection |
| [src/telemetry/ls-rpc.mjs](../src/telemetry/ls-rpc.mjs) | Telemetry | Local loopback Connect-RPC client (`GetUserStatus`, `RetrieveUserQuotaSummary`, trajectories) | Strict loopback (`127.0.0.1`/`localhost`/`::1`) only |
| [src/telemetry/sqlite-client.mjs](../src/telemetry/sqlite-client.mjs) | Telemetry | Lock-free WAL header readiness check and short-lived read-only SQLite wrapper | Never blocks host WAL checkpoints |
| [src/telemetry/cli-sqlite-reader.mjs](../src/telemetry/cli-sqlite-reader.mjs) | Telemetry | Read-only reader for Antigravity CLI/IDE `conversation_summaries.db` and `conversations/*.db` | Read-only SQLite connections only |
| [src/telemetry/local-scanner.mjs](../src/telemetry/local-scanner.mjs) | Telemetry | Incrementally scans local conversations, annotations, transcripts, and `.deep_stats_cache.json` | Reads local Antigravity dirs; caches only in isolated `DATA_DIR` |
| [src/telemetry/trajectory-metrics.mjs](../src/telemetry/trajectory-metrics.mjs) | Telemetry | Computes TPS, TTFT, cache hit rate, compaction inference, and step metrics | Pure computation |
| [src/telemetry/trajectory-store.mjs](../src/telemetry/trajectory-store.mjs) | Telemetry | SQLite + JSON dual-backend incremental trajectory cache with hot-session LRU | Persists only to isolated `DATA_DIR` |
| [src/telemetry/trajectory-sqlite-ledger.mjs](../src/telemetry/trajectory-sqlite-ledger.mjs) | Telemetry | SQLite incremental ledger backing `trajectory-store.mjs` | Uses `globalThis.DatabaseSync` or `node:sqlite` |
| [src/telemetry/trajectory-cache-file.mjs](../src/telemetry/trajectory-cache-file.mjs) | Telemetry | Atomic JSON fallback writer for trajectory cache | Used when SQLite is unavailable |
| [src/telemetry/quota-pools.mjs](../src/telemetry/quota-pools.mjs) | Telemetry | Maps official quota buckets into Gemini / Argon / Carbon / Claude & GPT pools | Pure computation |
| [src/telemetry/quota-reservation.mjs](../src/telemetry/quota-reservation.mjs) | Telemetry | Estimates in-flight lease reservations and burn rates | Persists only to isolated `DATA_DIR` |
| [src/telemetry/account-quota-history.mjs](../src/telemetry/account-quota-history.mjs) | Telemetry | Tracks historical quota snapshots per account | Persists only to isolated `DATA_DIR` |
| [src/telemetry/usage-aggregator.mjs](../src/telemetry/usage-aggregator.mjs) | Telemetry | Aggregates multi-window trends, heatmaps, and model/project/session rankings | Pure computation |
| [src/telemetry/pricing-catalog.mjs](../src/telemetry/pricing-catalog.mjs) | Telemetry | Merges bundled and cached pricing catalogs | Read-only lookup |
| [src/telemetry/model-pricing.mjs](../src/telemetry/model-pricing.mjs) | Telemetry | Resolves model identity, short labels, and estimated USD step cost | Pure computation |
| [src/telemetry/settings-schema.mjs](../src/telemetry/settings-schema.mjs) | Telemetry | Normalizes display/layout/budget preferences with host-invasive flags disabled | Keeps `enableWindowOverlay: false`, `enableCliStatusLine: false` |
| [src/telemetry/telemetry-builder.mjs](../src/telemetry/telemetry-builder.mjs) | Telemetry | Assembles the `/api/telemetry` JSON payload | Host-invasive fields stubbed as unsupported |
| [src/telemetry/fs-atomic.mjs](../src/telemetry/fs-atomic.mjs) | Telemetry | Atomic temp-file + rename JSON writer | Used only inside `DATA_DIR` |
| [src/telemetry/http-helpers.mjs](../src/telemetry/http-helpers.mjs) | Telemetry | `isPlainObject` and local asset/request helpers | Pure helpers |
| [src/telemetry/proto-wire.mjs](../src/telemetry/proto-wire.mjs) | Telemetry | Lightweight protobuf wire decoder for `.pb`/`.pbtxt` artifacts | Pure computation |
| [src/telemetry/transcript-fallback.mjs](../src/telemetry/transcript-fallback.mjs) | Telemetry | Fallback parser for `transcript.jsonl` | Read-only |
| [src/telemetry/telemetry-display-rules.mjs](../src/telemetry/telemetry-display-rules.mjs) | Telemetry | Shared bucket scaling and display formatting rules | Pure computation |
| [src/telemetry/prompt-clean.mjs](../src/telemetry/prompt-clean.mjs) | Telemetry | Strips internal system wrappers from turn prompt previews | Pure computation |
| [src/telemetry/settings-normalization.mjs](../src/telemetry/settings-normalization.mjs) | Telemetry | Stateless preference normalizers and enum constants | Pure computation |
| [src/telemetry/workspace-uri.mjs](../src/telemetry/workspace-uri.mjs) | Telemetry | Decodes `file://` workspace URIs across POSIX and Windows | Pure computation |
| [test/bun-sqlite-shim.test.mjs](../test/bun-sqlite-shim.test.mjs) | Tests | Verifies `bun:sqlite` -> `DatabaseSync` shim and zero-sidecar read-only WAL queries | Temp dir only |
| [test/allowlist.test.mjs](../test/allowlist.test.mjs) | Tests | Verifies fail-closed API route allowlist and settings sanitizer | Zero network |
| [test/pricing-sync.test.mjs](../test/pricing-sync.test.mjs) | Tests | Verifies `pricing-catalog.json` sync schema validation and TTL caching | Mocked fetch, temp dir |
| [test/telemetry-kernel.test.mjs](../test/telemetry-kernel.test.mjs) | Tests | Verifies offline `buildTelemetryPayload` (zero fetch), strict loopback RPC guard, LS discovery, and pricing lookup | Temp `dataDir`/`geminiDir` only |

## Planned layers (upcoming branches)

- `package.json` & `index.mjs` — Magpie OpenCode v1 plugin entrypoint and manifest (`feat/magpie-page-service`).
- `page/` — Sandboxed iframe launcher (`feat/magpie-page-service`).
- `src/server/` — Loopback HTTP server, token auth, router, and `preload.js` fetch shim (`feat/magpie-page-service`).
- `src/ui/` — Panel frontend assets and Magpie theme integration (`feat/magpie-page-service` & `feat/ui-polish-and-ci`).
