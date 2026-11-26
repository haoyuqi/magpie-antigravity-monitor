# Notes for coding agents

## Docs sync

- Read [docs/code-map.md](docs/code-map.md) and [docs/code-standards.md](docs/code-standards.md) before changing code.
- **Every code change must synchronously update the corresponding `docs/` files** ([docs/code-map.md](docs/code-map.md), [docs/code-standards.md](docs/code-standards.md), and any other relevant doc under `docs/`) in the same change/PR whenever files, responsibilities, routes, interfaces, contracts, or standards change.
- If a code change requires no documentation update, explicitly state why (`N/A`) in the PR body.

## Engineering guardrails

- **Runtime & dependencies**: Pure ESM, zero external npm dependencies, targeting Magpie's bundled **Bun** plugin host. Because Bun lacks `node:sqlite`, inject a `bun:sqlite` -> `globalThis.DatabaseSync` shim before loading SQLite readers.
- **Read-only invariant**: Strictly local-disk read-only telemetry (zero Antigravity Language Server RPC, zero process/port scanning, zero `hub_*.json` reads, zero official quota polling, zero OAuth/keyring access); never mutate external Antigravity files/processes or write to Magpie's usage ledger.
- **Magpie sandbox & local service**:
  - Launcher (`page/`) runs under `sandbox="allow-scripts"` and `connect-src 'none'`: no inline scripts, no `fetch`/`XHR`/`WebSocket` probes, no `localStorage`/`cookie` access; navigate only via `location.replace(...)` after reading `_magpie/bridge.js`.
  - Bind local service strictly to `127.0.0.1`; enforce `Host`, `Origin` (absent, `null`, or same-origin), `Sec-Fetch-Mode: navigate` (or `Accept: text/html` with no `Origin` and no `Sec-Fetch-Mode` for plain-HTTP `magpie web --lan` navigations) on token-bearing HTML, and persistent header token (`X-Usage-Monitor-Token`, never `Set-Cookie`).
  - Handle `EADDRINUSE` during Magpie rolling host restarts with background retries without blocking plugin load.
  - Keep all frontend asset and API requests relative (`./`) via `window.sidecar.fetch` so `magpie web` subpath proxying works.
  - Isolate plugin state/cache/settings under Magpie's `input.directory`.
- **License**: Preserve GNU GPL v3.0 license headers on derived files alongside [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Verification

- Tests must never reach the live network or touch real `HOME`, `~/.gemini`, or `~/.config/magpie`; always use temporary directories and fixtures.
- Record exact verification commands run and observed results; never claim unverified work.

## Git, branches, commits & PRs

- **Authorization**: Never run `git commit`, `git push`, open PRs, or alter external services without explicit user authorization.
- **Branches**:
  - Never commit directly to `main`.
  - Use short-lived, single-goal branches named `<type>/<short-topic>` (`feat/`, `fix/`, `docs/`, `chore/`).
  - Sync/rebase onto `origin/main` before opening or merging a PR, and clean up merged branches/worktrees afterward.
- **Commit messages**:
  - Keep one logical goal per commit; never bundle unrelated fixes or refactors.
  - Subject line: `<area>: <plain observable behavior>` in imperative English, at most 72 characters (e.g., `server: reject non-navigate requests to index.html`).
  - Body (required for non-trivial changes): explain why and what changed, list exact verification commands run and their results, and (for bug fixes) state which test fails without the change.
  - Inspect `git diff --stat` / `git show --stat` so only intended files are included.
- **Pull request title & body**:
  - Follow [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
  - Title uses the same `<area>: <plain observable behavior>` style.
  - Body must state: summary and linked issue; observable before/after behavior (trigger, interface/security/compatibility impact); exact verification record (commands, results, red-before-fix proof, and any checks explicitly not run); and completed compliance/read-only checklist.
  - Keep PRs focused and reviewable; re-run verification after any new push before merge.
