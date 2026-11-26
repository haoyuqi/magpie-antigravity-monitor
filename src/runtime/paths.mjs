/*
 * Copyright (C) 2026 haoyuqi and contributors
 * Based on yuhuan-dev/antigravity-usage-monitor (GNU GPL v3.0).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Isolated plugin storage paths, read-only Antigravity discovery directories,
 * and shared runtime state containers.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomicSync } from '../telemetry/fs-atomic.mjs';
import { isPlainObject } from '../telemetry/http-helpers.mjs';
import { normalizeFullSettings } from '../telemetry/settings-schema.mjs';
import { writeTrajectoryCacheFile } from '../telemetry/trajectory-cache-file.mjs';
import {
  CACHE_RUNNING_SAVE_INTERVAL_MS,
  createTrajectoryCacheStore,
} from '../telemetry/trajectory-store.mjs';

export { CACHE_RUNNING_SAVE_INTERVAL_MS, isPlainObject };

export {
  CLI_STATUSLINE_PRESETS,
  CONTEXT_AGENT_MODES,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_SETTINGS_SCHEMA,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  FONT_SCALE_KEYS,
  MAX_CLI_STATUSLINE_SLOTS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  MIN_CLI_STATUSLINE_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  STEP_TABLE_COLUMN_KEYS,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  createDefaultSettingsObject,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
  normalizeFullSettings,
  normalizeHoverModules,
  normalizeLanguageSetting,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
  resolveEffectiveCliStatusLineSlots,
} from '../telemetry/settings-schema.mjs';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(runtimeDir, '..', '..');
export const PLUGIN_ROOT = REPO_ROOT;
export const PLUGIN_MANIFEST_FILE = join(REPO_ROOT, 'package.json');
export const LOCAL_CATALOG_FILE = join(REPO_ROOT, 'data', 'pricing-catalog.json');
export const OFFICIAL_GITHUB_REPO = 'yuhuan-dev/antigravity-usage-monitor';
export const LEGACY_GITHUB_REPOS = Object.freeze([]);
export const DEFAULT_RELEASE_URL = `https://github.com/${OFFICIAL_GITHUB_REPO}/releases/latest`;
export const DEFAULT_DOWNLOAD_URL = '';
export const DEFAULT_ARCHIVE_FALLBACK_URL = '';
export const CLOUD_CATALOG_URLS = [
  `https://raw.githubusercontent.com/${OFFICIAL_GITHUB_REPO}/main/pricing-catalog.json`,
];

export function detectCustomGitForkRepo() {
  return '';
}

export const CLOUD_SYNC_TTL_MS = 6 * 3600 * 1000;
export const CLOUD_SYNC_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
export const CACHE_SCHEMA_VERSION = 'v10-model-identity';

function resolveGeminiBaseDir(explicitGeminiDir = '') {
  const envGemini = String(explicitGeminiDir || process.env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return envGemini || join(homedir(), '.gemini');
}

function dedupeDirCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    const key = process.platform === 'win32' ? clean.toLowerCase() : clean;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Resolves read-only Antigravity product data directories under `~/.gemini`.
 *
 * @param {string} [geminiDir]
 * @returns {string[]}
 */
export function resolveProductDataRoots(geminiDir = '') {
  const geminiBase = resolveGeminiBaseDir(geminiDir);
  const explicitAppDir = String(
    process.env.USAGE_MONITOR_APP_DATA_DIR || process.env.ANTIGRAVITY_APP_DATA_DIR || ''
  ).trim();
  const customRoot = explicitAppDir
    ? /[\\/]|^[a-zA-Z]:/.test(explicitAppDir)
      ? explicitAppDir
      : join(geminiBase, explicitAppDir)
    : '';
  return dedupeDirCandidates([
    customRoot,
    join(geminiBase, 'antigravity'),
    join(geminiBase, 'antigravity-cli'),
    join(geminiBase, 'antigravity-ide'),
    join(geminiBase, 'antigravity-idea'),
  ]);
}

/**
 * Resolves isolated plugin data file paths for a given directory.
 *
 * @param {string} [explicitDataDir]
 */
export function resolveDataPaths(explicitDataDir = '') {
  const baseDir = String(explicitDataDir || process.env.USAGE_MONITOR_DATA_DIR || '').trim()
    || join(REPO_ROOT, '.data');
  return {
    dataDir: baseDir,
    settingsFile: join(baseDir, 'settings.json'),
    cacheFile: join(baseDir, 'trajectory_usage_cache.json'),
    trajectoryDbFile: join(baseDir, 'trajectory_store.sqlite'),
    remoteCatalogCacheFile: join(baseDir, 'remote_pricing_cache.json'),
    quotaReservationStateFile: join(baseDir, 'quota_reservation_state.json'),
    accountQuotaHistoryFile: join(baseDir, 'account_quota_history.json'),
  };
}

const initialPaths = resolveDataPaths();
export const DATA_DIR = initialPaths.dataDir;
export const SETTINGS_FILE = initialPaths.settingsFile;
export const CACHE_FILE = initialPaths.cacheFile;
export const TRAJECTORY_DB_FILE = initialPaths.trajectoryDbFile;
export const REMOTE_CATALOG_CACHE_FILE = initialPaths.remoteCatalogCacheFile;
export const QUOTA_RESERVATION_STATE_FILE = initialPaths.quotaReservationStateFile;
export const ACCOUNT_QUOTA_HISTORY_FILE = initialPaths.accountQuotaHistoryFile;

export const PRODUCT_DATA_ROOTS = resolveProductDataRoots();
export const CONVERSATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'conversations'));
export const BRAIN_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'brain'));
export const ANNOTATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'annotations'));
export const DAEMON_DIRS = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'daemon'),
  ...PRODUCT_DATA_ROOTS.map((root) => join(root, 'daemon')),
]);
export const CONVERSATIONS_DIR = CONVERSATION_DIRS[0];
export const BRAIN_DIR = BRAIN_DIRS[0];
export const DEEP_STATS_CACHE_CANDIDATES = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-ide', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-idea', 'brain', '.deep_stats_cache.json'),
  ...BRAIN_DIRS.map((dir) => join(dir, '.deep_stats_cache.json')),
]);

/**
 * Returns true only for strict loopback HTTP/HTTPS URLs with no embedded credentials.
 *
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isStrictLoopbackUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function parseLoopbackLsAddress(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) {
    return { addr: '', baseUrl: '' };
  }
  if (raw === 'test.invalid') {
    return { addr: 'test.invalid', baseUrl: '' };
  }
  const proto = /^https:\/\//i.test(raw) ? 'https' : 'http';
  const cleanAddr = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const candidateUrl = cleanAddr ? `${proto}://${cleanAddr}` : '';
  if (!candidateUrl || !isStrictLoopbackUrl(candidateUrl)) {
    return { addr: '', baseUrl: '' };
  }
  return { addr: cleanAddr, baseUrl: candidateUrl };
}

const initialLs = parseLoopbackLsAddress(process.env.ANTIGRAVITY_LS_ADDRESS);
export const LS_ADDR = initialLs.addr;
export const LS_BASE_URL = initialLs.baseUrl;
export const CSRF_TOKEN =
  process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN;

export const lsRuntimeEndpoint = {
  addr: LS_ADDR,
  baseUrl: LS_BASE_URL,
  csrfToken: CSRF_TOKEN || '',
  isDynamic: false,
};

export function setLsRuntimeEndpoint(nextAddr, nextCsrfToken, { isDynamic = true } = {}) {
  const parsed = parseLoopbackLsAddress(nextAddr);
  lsRuntimeEndpoint.addr = parsed.addr;
  lsRuntimeEndpoint.baseUrl = parsed.baseUrl;
  lsRuntimeEndpoint.csrfToken = parsed.baseUrl ? String(nextCsrfToken || '').trim() : '';
  lsRuntimeEndpoint.isDynamic = Boolean(parsed.baseUrl && isDynamic);
}

export function loadJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

export function saveJson(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (filePath === CACHE_FILE) {
      writeTrajectoryCacheFile(filePath, data);
    } else {
      writeJsonAtomicSync(filePath, data);
    }
    return true;
  } catch (err) {
    console.error(`Failed writing ${filePath}: ${err.message}`);
    return false;
  }
}

export function loadSettings() {
  return normalizeFullSettings(loadJson(SETTINGS_FILE, {}));
}

export function roundMetric(value) {
  return Number.isFinite(value) ? +value.toFixed(1) : null;
}

export function computeRuntimeCodeVersion() {
  return 'magpie-antigravity-monitor';
}

export const inFlightRequests = new Map();

export const localSummaryMemo = {
  sig: '',
  byId: new Map(),
  available: false,
  summariesObj: {},
  sideQuestionParents: {},
  byRootsKey: new Map(),
};

export const externalDeepStatsMemo = {
  sig: '',
  convos: new Map(),
};

export const pluginUpdateState = {
  checking: false,
  updating: false,
  lastCheckAtMs: 0,
  lastCheckError: null,
  latestVersion: '',
  updateAvailable: false,
  downloadUrl: '',
  releaseUrl: '',
  lastUpdatedAtMs: 0,
  lastUpdateError: null,
};

export const cloudSyncState = {
  lastAttemptMs: 0,
  lastSuccessMs: 0,
  lastError: null,
  inFlight: null,
};

export const trajectoryCacheStore = createTrajectoryCacheStore({
  cacheFilePath: CACHE_FILE,
  sqliteFilePath: TRAJECTORY_DB_FILE,
  loadJsonFn: loadJson,
  writeCacheFn: saveJson,
  shouldBypassThrottleFn: (allowThrottleInTest) =>
    !allowThrottleInTest && lsRuntimeEndpoint.addr === 'test.invalid',
  registerExitHook: true,
});

export function listCachedTrajectoryEntries() {
  return trajectoryCacheStore.listCachedTrajectoryEntries();
}

export function getCachedTrajectoryEntryByLower(cascadeId) {
  return trajectoryCacheStore.getCachedTrajectoryEntryByLower(cascadeId);
}

export function getCachedTrajectory(cascadeId) {
  return trajectoryCacheStore.getCachedTrajectory(cascadeId);
}

export function getHydratedTrajectoryEntryByLower(cascadeId) {
  return trajectoryCacheStore.getHydratedTrajectoryEntryByLower(cascadeId);
}

export function getHydratedTrajectory(cascadeId) {
  return trajectoryCacheStore.getHydratedTrajectory(cascadeId);
}

export function setCachedTrajectory(cascadeId, entry, opts = {}) {
  return trajectoryCacheStore.setCachedTrajectory(cascadeId, entry, opts);
}

export function removeCachedTrajectory(cascadeId, opts = {}) {
  return trajectoryCacheStore.removeCachedTrajectory(cascadeId, opts);
}

export function flushTrajectoryCacheNow() {
  return trajectoryCacheStore.flushTrajectoryCacheNow();
}

export function scheduleTrajectoryCacheSave(hasRunning) {
  return trajectoryCacheStore.scheduleTrajectoryCacheSave(hasRunning);
}

export function hasPendingTrajectoryCacheSave() {
  return trajectoryCacheStore.hasPendingTrajectoryCacheSave();
}

export function persistTrajectoryCacheIfNeeded(options = {}) {
  return trajectoryCacheStore.persistTrajectoryCacheIfNeeded(options);
}

export function clearRuntimeCaches({ liveCascadeIds = null } = {}) {
  return trajectoryCacheStore.clearRuntimeCaches({ liveCascadeIds });
}
