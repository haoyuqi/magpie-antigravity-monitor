# magpie-antigravity-monitor

A **strictly read-only** Google Antigravity (Desktop / IDE / `agy` CLI) token usage, speed, context, and quota monitor page plugin for [Magpie](https://github.com/yetone/magpie).

> [!NOTE]
> **Status**: Repository foundation, attribution, and GitHub templates are ready; plugin implementation is pending.

---

## References & Attribution

- **Ported from / Based on**: [`yuhuan-dev/antigravity-usage-monitor`](https://github.com/yuhuan-dev/antigravity-usage-monitor) (GNU GPL v3.0)
  - Reuses its local Language Server Connect-RPC discovery, SQLite/WAL trajectory parsing, 10-channel context breakdown, official quota pools, and four-tab monitoring UI. Licensed under GNU GPL v3.0 with original copyright notices preserved (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
- **Plugin Architecture & Conventions**:
  - [`yetone/magpie`](https://github.com/yetone/magpie) (MIT): `magpie.page` / `magpie.page.service` sandboxed page and reverse-proxy protocol.
  - [`magpie-community/plugins`](https://github.com/magpie-community/plugins) (MIT): local service, persistent header-token auth, and rolling-restart retry patterns informed by `page-chat` and `amp-usage`.

---

## Scope & Non-Goals

This plugin is a **read-only Antigravity (`agy`) monitoring dashboard**:

- **In Scope (Strictly Local-Disk Read-Only)**:
  - Offline, zero-network read-only scanning of `~/.gemini/antigravity{,-cli,-ide,-idea}/` (`conversations/*.db`, `annotations/*.pbtxt`, `transcript.jsonl`, `.deep_stats_cache.json`).
  - Real-time output speed (TPS), time-to-first-token (TTFT), cache hit rate, and estimated step/session cost.
  - 10-channel context breakdown (with main agent / subagent switching).
  - Main agent, subagent, and Native Swarm step details, historical trends, heatmaps, and model/project/session rankings.
- **Non-Goals**:
  - Never calls Antigravity Language Server RPC, scans host processes/ports/`hub_*.json`, polls official quota APIs, or accesses OAuth/keyring credentials.
  - Never modifies Antigravity configs, desktop shortcuts, `argv.json`, or CLI `statusLine`.
  - Never injects CDP overlays/capsules, host i18n patches, or account-switching process restarts into Antigravity.
  - Never hijacks CloudCode proxy or overrides per-model context window limits.
  - Never writes usage records into Magpie's own ledger.

---

## License

Licensed under the [GNU General Public License v3.0](LICENSE). See [NOTICE](NOTICE) for third-party attribution.
