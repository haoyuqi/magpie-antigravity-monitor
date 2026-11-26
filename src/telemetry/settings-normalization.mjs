/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Shared preference enum constants, defaults, and stateless pure-function normalization rules for frontend, backend, and CLI.
 */

export const SUPPORTED_LANGUAGES = Object.freeze(['auto', 'zh-CN', 'en-US']);

export const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

export const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export const TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_5h',
  'gemini_weekly',
  'argon_weekly',
  'claude_5h',
  'claude_weekly',
]);

export const DEFAULT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);
export const MIN_TOPBAR_SLOTS = 1;
export const MAX_TOPBAR_SLOTS = 5;

export const DEFAULT_CLI_STATUSLINE_SLOTS = Object.freeze([
  'tps',
  'ttft',
  'session_cost',
  'quota_auto',
  'context',
]);
export const MIN_CLI_STATUSLINE_SLOTS = 1;
export const MAX_CLI_STATUSLINE_SLOTS = 6;
export const CLI_STATUSLINE_PRESETS = Object.freeze({
  compact: Object.freeze(['tps', 'ttft', 'context']),
  balanced: DEFAULT_CLI_STATUSLINE_SLOTS,
  full: Object.freeze(['tps', 'ttft', 'cache_hit', 'session_cost', 'quota_auto', 'context']),
});

export const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_HOVER_MODULES = Object.freeze(['metrics', 'context', 'quotas']);

export const OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

export const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

export const STEP_TABLE_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

export const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  out: 'out',
  output: 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  think: 'think',
  thinking: 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
});

export const POPOVER_WIDTH_MODES = Object.freeze(['auto', 'custom']);
export const MIN_POPOVER_WIDTH = 440;
export const MAX_POPOVER_WIDTH = 1080;
export const DEFAULT_POPOVER_WIDTH = 580;

/**
 * Normalizes the UI language enum (default `'auto'`, supporting `'zh-CN'` and `'en-US'`).
 *
 * @param {unknown} lang
 * @returns {'auto'|'zh-CN'|'en-US'}
 */
export function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'auto';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'system') return 'auto';
  if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-')) return 'en-US';
  if (lower === 'zh' || lower === 'zh-cn' || lower.startsWith('zh')) return 'zh-CN';
  return 'auto';
}

/**
 * Normalizes the theme accent color preset key (default `'host'` to follow the host native theme).
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
export function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * Normalizes the panel font size tier (default `'md'`, standard 100%).
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
export function normalizeFontScale(scale) {
  const clean = String(scale ?? '').trim().toLowerCase();
  return FONT_SCALE_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'md';
}

/**
 * Normalizes the model name display mode (`'short'` | `'upstream_compact'` | `'upstream'`), compatible with legacy `showUpstreamModel`.
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowUpstream]
 * @returns {'short'|'upstream_compact'|'upstream'}
 */
export function normalizeModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

/**
 * Normalizes the Orchestrator series model ID display style (`'compact'` vs `'full'`, default `'compact'`).
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
export function normalizeOrchestratorIdMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * Normalizes the floating main panel width mode (`'auto'` | `'custom'`, default `'auto'`).
 *
 * @param {unknown} mode
 * @returns {'auto'|'custom'}
 */
export function normalizePopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

/**
 * Normalizes the floating main panel custom width in pixels (range `440..1080`, default `580`).
 *
 * @param {unknown} width
 * @returns {number}
 */
export function normalizePopoverWidth(width) {
  const num = Number(width);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POPOVER_WIDTH;
  return Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(num)));
}

/**
 * Parses a step-table custom token combo expression, supporting `:`, `/`, `,`, `|` separators and aliases (1 to 4 unique items).
 *
 * @param {unknown} raw
 * @returns {Array<'context'|'in'|'out'|'cache'|'think'|'reply'|'total'>}
 */
export function parseStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(STEP_TOKEN_SEGMENT_ALIASES, key)
        ? STEP_TOKEN_SEGMENT_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(/** @type {any} */ (mapped));
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

/**
 * Normalizes a step-table custom token combo format string (e.g. `'context:new:cache'` -> `'context:in:cache'`).
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * Normalizes the plugin update policy enum (compatible with legacy `autoUpdatePlugin` boolean flag, default `'manual'`).
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'|'auto'}
 */
export function normalizePluginUpdateMode(mode, legacyAutoUpdate) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'manual' || m === 'auto') return m;
  if (legacyAutoUpdate === true) return 'auto';
  return 'manual';
}

/**
 * Normalizes the panel mount mode enum (`'dual'` | `'composer'` | `'sidebar'`), compatible with legacy `enableWindowOverlay`.
 *
 * @param {unknown} mode
 * @param {unknown} [legacyEnableOverlay]
 * @returns {'dual'|'composer'|'sidebar'}
 */
export function normalizeWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'sidebar_only' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'dual';
}

/**
 * Normalizes the weekly quota statistics mode enum (`'official'` | `'custom_tokens'` | `'custom_cost'`).
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
export function normalizeWeeklyLimitMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'custom_tokens' || m === 'tokens') return 'custom_tokens';
  if (m === 'custom_cost' || m === 'cost') return 'custom_cost';
  return 'official';
}

/**
 * Normalizes the topbar/composer capsule slots array (1 to 5 dynamically added items, default 3 items; automatically strips legacy `'none'` and duplicates).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeTopbarCapsuleSlots(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_TOPBAR_SLOTS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_TOPBAR_SLOTS) break;
  }
  if (out.length < MIN_TOPBAR_SLOTS) {
    return ['context'];
  }
  return out;
}

/**
 * Normalizes the standalone CLI bottom status line slots config (`null` means auto-follow widescreen default or custom topbar slots;
 * supports preset names `compact` / `balanced` / `full`, comma-separated lists, or arrays, keeping 1 to 6 deduplicated valid slots).
 *
 * @param {unknown} raw
 * @returns {string[]|null}
 */
export function normalizeCliStatusLineSlots(raw) {
  if (raw === undefined || raw === null) return null;
  let items = null;
  if (typeof raw === 'string') {
    const clean = raw.trim();
    const lower = clean.toLowerCase();
    if (!clean || lower === 'auto' || lower === 'default') {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(CLI_STATUSLINE_PRESETS, lower)) {
      return [...CLI_STATUSLINE_PRESETS[lower]];
    }
    items = clean.split(/[\s,|:]+/);
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_CLI_STATUSLINE_SLOTS) break;
  }
  return out.length >= MIN_CLI_STATUSLINE_SLOTS ? out : null;
}

/**
 * Resolves the active CLI bottom status line slots list:
 * 1. If the user explicitly set `cliStatusLineSlots`, use it first;
 * 2. If the user customized a non-default `topbarCapsuleSlots`, preserve that custom order for compatibility;
 * 3. Otherwise use the 5-slot widescreen default combination (speed / TTFT / cost / quota / context).
 *
 * @param {object|null|undefined} settings
 * @returns {string[]}
 */
export function resolveEffectiveCliStatusLineSlots(settings) {
  const customCli = normalizeCliStatusLineSlots(settings?.cliStatusLineSlots);
  if (customCli && customCli.length > 0) {
    return customCli;
  }
  const topbar = normalizeTopbarCapsuleSlots(settings?.topbarCapsuleSlots);
  const isDefaultTopbar =
    topbar.length === DEFAULT_TOPBAR_SLOTS.length &&
    topbar.every((k, i) => k === DEFAULT_TOPBAR_SLOTS[i]);
  if (!isDefaultTopbar) {
    return topbar;
  }
  return [...DEFAULT_CLI_STATUSLINE_SLOTS];
}

/**
 * Normalizes the slot selection and order for the first row of the live monitor metric matrix (1 to 4 items, default 4 items).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewMetrics(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_METRICS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const rawVal = String(item ?? '').trim();
    const val = rawVal === 'cost' ? 'step_cost' : rawVal;
    if (!OVERVIEW_METRIC_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * Normalizes the displayed modules and vertical order for the live monitor view (1 to 4 items, default all 4 enabled).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out.length > 0 ? out : ['metrics'];
}

/**
 * Normalizes the displayed modules and vertical order for the hover quick-peek popup (0 to 4 items, default 3 items; an explicit empty array `[]` disables the hover popup).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeHoverModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_HOVER_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out;
}

/**
 * Normalizes the column configuration and left-to-right order for the call-detail "By Step" table (2 to 14 columns, default 7 columns).
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStepTableColumns(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STEP_TABLE_COLUMNS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!STEP_TABLE_COLUMN_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= STEP_TABLE_COLUMN_KEYS.length) break;
  }
  if (out.length < 2) {
    for (const fallbackCol of ['step', 'model', 'tps']) {
      if (!seen.has(fallbackCol)) {
        seen.add(fallbackCol);
        out.push(fallbackCol);
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

/**
 * Normalizes the standalone web server auto-managed port (`0` disables auto-start; valid listening port range `1024..65535`).
 *
 * @param {unknown} port
 * @returns {number}
 */
export function normalizeStandalonePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num <= 0) return 0;
  if (num >= 1024 && num <= 65535) return num;
  return 0;
}

/**
 * Normalizes the modern UI toggle (default `true`).
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeModernUi(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

export const CONTEXT_AGENT_MODES = Object.freeze(['main', 'auto']);
export const DEFAULT_CONTEXT_AGENT_MODE = 'main';

export const ACCOUNT_QUOTA_REFRESH_MINUTES = Object.freeze([10, 30, 60, 180, 360, 720, 1440]);
export const DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES = 60;

/**
 * Normalizes the background quota refresh interval for non-current accounts (in minutes, default `60`, i.e. 1 hour).
 *
 * @param {unknown} raw
 * @returns {10|30|60|180|360|720|1440}
 */
export function normalizeAccountQuotaRefreshMinutes(raw) {
  const num = Number(raw);
  return ACCOUNT_QUOTA_REFRESH_MINUTES.includes(num)
    ? /** @type {any} */ (num)
    : DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES;
}

/**
 * Normalizes the context agent source for the topbar capsule and hover quick-peek popup (default `'main'` locks to main agent; `'auto'` follows active agent).
 *
 * @param {unknown} raw
 * @returns {'main'|'auto'}
 */
export function normalizeContextAgentMode(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return val === 'auto' ? 'auto' : 'main';
}

/**
 * Normalizes the quota reservation estimation toggle (default `true`).
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalQuotaReservation(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

/**
 * Normalizes the legacy experimental new UI field (retained for compatibility, defaults to `false`).
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalModernUi(val) {
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(val);
}
