## Summary

- What does this PR change and why?
- Related issue: Closes # / Refs #

## Observable Behavior (Before / After)

- **Trigger**:
- **Before**:
- **After**:
- **Interface / Security / Compatibility Impact**:

## Documentation Updates

- [ ] Updated [docs/code-map.md](docs/code-map.md) (new/moved/removed modules, routes, or data flows)
- [ ] Updated [docs/code-standards.md](docs/code-standards.md) (new or revised conventions, security rules, or test standards)
- [ ] Updated other relevant files under `docs/` (list below), or `N/A` (explain why no docs update is needed):

## Verification Record

List exact commands run and observed results (explicitly note any checks not run):
- **Automated tests** (`bun test` / `node --test`):
- **Red-before-fix proof** (which test failed before the fix, if applicable):
- **Manual check** (Magpie Desktop / `magpie web`):
- **Checks not run**:

## Compliance & Safety Checklist

- [ ] Read-only invariant preserved (no writes to `~/.gemini/antigravity*`, `~/.antigravity-ide/*`, or `~/.config/magpie/*`).
- [ ] No live network calls or real `HOME` paths touched in automated tests.
- [ ] Security guards (`127.0.0.1`, `Host`, `Origin`, `Sec-Fetch-Mode`, `X-Usage-Monitor-Token`, CSP) remain intact.
- [ ] Corresponding `docs/` files updated synchronously (or `N/A` justified above).
- [ ] GNU GPL v3.0 license headers and [NOTICE](NOTICE) attribution preserved.
