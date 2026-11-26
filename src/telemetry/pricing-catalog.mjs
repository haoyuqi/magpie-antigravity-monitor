/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Model pricing and placeholder catalog loading, schema sanitization, and local/cloud catalog merging.
 *
 * Pricing conventions and safety principles:
 * - All unit prices are in USD per 1M tokens (`input`: uncached input, `cache`: cache read, `output`: output & thinking);
 * - Prices are only used for local API-equivalent cost estimation and do not represent subscription quota deduction ratios;
 * - Offline baselines are read uniformly from the bundled `pricing-catalog.json` to avoid maintaining duplicate hardcoded dictionaries in JS source;
 * - Unlisted or unidentified models strictly remain unpriced (`null`), never borrowing prices from other models or allowing `null`/`0` pseudo-prices;
 * - Version numbers (following SemVer 2.0) and update package URLs undergo strict format and trusted GitHub domain allowlist validation.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseIsoMs } from './trajectory-metrics.mjs';
import {
  DEFAULT_ARCHIVE_FALLBACK_URL,
  DEFAULT_DOWNLOAD_URL,
  DEFAULT_RELEASE_URL,
  LEGACY_GITHUB_REPOS,
  LOCAL_CATALOG_FILE,
  OFFICIAL_GITHUB_REPO,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_ROOT,
  REMOTE_CATALOG_CACHE_FILE,
  cloudSyncState,
  detectCustomGitForkRepo,
  loadJson,
  pluginUpdateState,
} from '../runtime/paths.mjs';

/**
 * Active model pricing table and placeholder map (updated in place to keep cross-module references consistent).
 */
export const MODEL_PRICING = {};
export const PLACEHOLDER_MAP = {};
export let pricingCatalogRevision = 0;
let pricingPhaseBoundariesMs = [];

/**
 * Returns the count of global pricing phase boundaries crossed by the given timestamp, allowing telemetry and aggregate snapshots to invalidate and recompute automatically when a promotional cutoff is crossed.
 *
 * @param {number} [atMs=Date.now()]
 * @returns {number}
 */
export function getPricingPhaseEpoch(atMs = Date.now()) {
  const t = Number(atMs);
  if (!Number.isFinite(t) || t <= 0 || pricingPhaseBoundariesMs.length === 0) return 0;
  let epoch = 0;
  for (let i = 0; i < pricingPhaseBoundariesMs.length; i++) {
    if (t >= pricingPhaseBoundariesMs[i]) epoch = i + 1;
    else break;
  }
  return epoch;
}

/**
 * Validates whether a string is a valid SemVer 2.0 semantic version format (supports `-prerelease` and `+build` metadata).
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isValidSemver(v) {
  return (
    typeof v === 'string' &&
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v.trim())
  );
}

const OFFICIAL_REPO_PATH_PREFIX = `/${OFFICIAL_GITHUB_REPO.toLowerCase()}`;
const LEGACY_REPO_PATH_PREFIXES = LEGACY_GITHUB_REPOS.map((repo) => `/${repo.toLowerCase()}`);

/**
 * Checks whether a source URL belongs to a migrated legacy official GitHub repository address.
 *
 * @param {*} rawUrl
 * @returns {boolean}
 */
function isLegacyGithubRepoUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (
      host !== 'github.com' &&
      host !== 'raw.githubusercontent.com' &&
      host !== 'codeload.github.com'
    ) {
      return false;
    }
    return LEGACY_REPO_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  } catch {
    return false;
  }
}

/**
 * Validates whether an update/download URL belongs to a trusted official GitHub repository and HTTPS domain allowlist.
 *
 * @param {*} rawUrl
 * @param {string} fallbackUrl
 * @returns {string}
 */
function sanitizeTrustedGithubUrl(rawUrl, fallbackUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fallbackUrl;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return fallbackUrl;
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (
      host === 'github.com' ||
      host === 'raw.githubusercontent.com' ||
      host === 'codeload.github.com'
    ) {
      const hasRepoPrefix =
        pathname === OFFICIAL_REPO_PATH_PREFIX ||
        pathname.startsWith(`${OFFICIAL_REPO_PATH_PREFIX}/`);
      return hasRepoPrefix ? parsed.toString() : fallbackUrl;
    }
    return fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

/**
 * Compares two version numbers per SemVer 2.0 (section 10 ignores `+build` metadata; section 11.4 compares pre-release identifiers by ASCII order and numeric-only precedence).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} `1` if `a > b`, `-1` if `a < b`, `0` if equal
 */
export function compareSemver(a, b) {
  if (!isValidSemver(a) || !isValidSemver(b)) return 0;
  const parse = (v) => {
    const cleaned = String(v || '')
      .trim()
      .replace(/^v/i, '')
      .replace(/\+.*$/, '');
    const dashIdx = cleaned.indexOf('-');
    const coreStr = dashIdx >= 0 ? cleaned.slice(0, dashIdx) : cleaned;
    const preStr = dashIdx >= 0 ? cleaned.slice(dashIdx + 1) : '';
    const core = coreStr.split('.').map((n) => {
      const parsed = parseInt(n, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    });
    return { core, pre: preStr };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.core.length, pb.core.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa.core[i] || 0;
    const vb = pb.core[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;

  const idsA = pa.pre.split('.');
  const idsB = pb.pre.split('.');
  const minLen = Math.min(idsA.length, idsB.length);
  for (let i = 0; i < minLen; i++) {
    const idA = idsA[i];
    const idB = idsB[i];
    if (idA === idB) continue;
    const numA = /^\d+$/.test(idA);
    const numB = /^\d+$/.test(idB);
    if (numA && numB) {
      const bigA = BigInt(idA);
      const bigB = BigInt(idB);
      if (bigA !== bigB) return bigA > bigB ? 1 : -1;
      continue;
    }
    // SemVer 2.0 §11.4.1: numeric identifiers always have lower precedence than alphanumeric identifiers
    if (numA && !numB) return -1;
    if (!numA && numB) return 1;
    // SemVer 2.0 §11.4.2: alphanumeric identifiers are compared in ASCII lexical order
    return idA < idB ? -1 : 1;
  }
  if (idsA.length === idsB.length) return 0;
  return idsA.length > idsB.length ? 1 : -1;
}

/**
 * Reads the `plugin.json` version of the currently installed plugin.
 *
 * @returns {string}
 */
export function readInstalledPluginVersion() {
  const manifest = loadJson(PLUGIN_MANIFEST_FILE, null);
  const ver = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
  return isValidSemver(ver) ? ver.replace(/^v/i, '') : '1.4.4';
}

function normalizeModelFamily(rawFamily) {
  const f = String(rawFamily || '').trim();
  const lower = f.toLowerCase();
  if (lower === 'gemini' || lower === 'google') return 'Gemini';
  if (lower === 'claude' || lower === 'anthropic') return 'Claude';
  if (lower === 'gpt' || lower === 'openai') return 'GPT';
  if (lower === 'other') return 'Other';
  return f;
}

function isValidPricingRateTriplet(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (
    typeof entry.input !== 'number' ||
    typeof entry.cache !== 'number' ||
    typeof entry.output !== 'number'
  ) {
    return false;
  }
  const { input, cache, output } = entry;
  if (!Number.isFinite(input) || input < 0 || input > 10000) return false;
  if (!Number.isFinite(cache) || cache < 0 || cache > 10000) return false;
  if (!Number.isFinite(output) || output < 0 || output > 10000) return false;
  if (input === 0 && output === 0) return false;
  return true;
}

/**
 * Validates and normalizes a single time-phased pricing entry (half-open interval `[fromMs, untilMs)`).
 * At least one valid `from` or `until` ISO timestamp must be declared, and if both are declared, `fromMs < untilMs` must hold.
 */
function sanitizeOptionalImageOutputRate(val) {
  return typeof val === 'number' && Number.isFinite(val) && val > 0 && val <= 10000 ? val : null;
}

function sanitizePricingPhase(rawPhase) {
  if (!isValidPricingRateTriplet(rawPhase)) return null;
  let from = null;
  let fromMs = -Infinity;
  if (rawPhase.from !== undefined && rawPhase.from !== null) {
    if (typeof rawPhase.from !== 'string' || !rawPhase.from.trim()) return null;
    const parsedFrom = parseIsoMs(rawPhase.from.trim());
    if (!parsedFrom || parsedFrom <= 0) return null;
    from = rawPhase.from.trim();
    fromMs = parsedFrom;
  }
  let until = null;
  let untilMs = Infinity;
  if (rawPhase.until !== undefined && rawPhase.until !== null) {
    if (typeof rawPhase.until !== 'string' || !rawPhase.until.trim()) return null;
    const parsedUntil = parseIsoMs(rawPhase.until.trim());
    if (!parsedUntil || parsedUntil <= 0) return null;
    until = rawPhase.until.trim();
    untilMs = parsedUntil;
  }
  if (from === null && until === null) return null;
  if (fromMs >= untilMs) return null;
  const imageOutput = sanitizeOptionalImageOutputRate(rawPhase.imageOutput);
  return {
    ...(from !== null ? { from, fromMs } : {}),
    ...(until !== null ? { until, untilMs } : {}),
    input: rawPhase.input,
    cache: rawPhase.cache,
    output: rawPhase.output,
    ...(imageOutput !== null ? { imageOutput } : {}),
  };
}

/**
 * Validates whether a single model pricing configuration is valid:
 * - `input`/`cache`/`output` must be native `number` types (preventing implicit conversion bugs like `Number(null) === 0` or `Number("") === 0`);
 * - Values must be non-negative and `<= 10000`, with at least `input > 0` or `output > 0` (rejecting all-zero pseudo-prices that would turn unpriced models into $0.00);
 * - `short`/`family` must be non-empty strings.
 */
function isValidPricingEntry(entry) {
  if (!isValidPricingRateTriplet(entry)) return false;
  if (typeof entry.short !== 'string' || !entry.short.trim()) return false;
  if (typeof entry.family !== 'string' || !entry.family.trim()) return false;
  return true;
}

/**
 * Validates whether a single enum placeholder mapping is valid.
 */
function isValidPlaceholderEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.modelId !== 'string' || !entry.modelId.trim()) return false;
  if (typeof entry.label !== 'string' || !entry.label.trim()) return false;
  return true;
}

/**
 * Sanitizes and validates a raw `pricing-catalog.json` object from local or cloud sources.
 * Any malformed individual entry is automatically filtered out to prevent corrupt data from polluting the in-memory pricing table.
 *
 * @param {object} raw
 * @returns {object|null}
 */
export function sanitizeCatalogPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pricing = {};
  let validPricingCount = 0;
  if (raw.pricing && typeof raw.pricing === 'object') {
    for (const [k, v] of Object.entries(raw.pricing)) {
      const key = String(k || '').trim();
      if (!key || !isValidPricingEntry(v)) continue;
      let phases = null;
      if (Array.isArray(v.phases)) {
        const cleanedPhases = v.phases.map(sanitizePricingPhase).filter(Boolean);
        if (cleanedPhases.length > 0) {
          phases = cleanedPhases;
        }
      }
      const imageOutput = sanitizeOptionalImageOutputRate(v.imageOutput);
      pricing[key] = {
        input: v.input,
        cache: v.cache,
        output: v.output,
        ...(imageOutput !== null ? { imageOutput } : {}),
        short: String(v.short).trim(),
        family: normalizeModelFamily(v.family),
        ...(phases ? { phases } : {}),
      };
      validPricingCount++;
    }
  }

  const placeholders = {};
  let validPlaceholderCount = 0;
  if (raw.placeholders && typeof raw.placeholders === 'object') {
    for (const [k, v] of Object.entries(raw.placeholders)) {
      const key = String(k || '').trim();
      if (!key || !isValidPlaceholderEntry(v)) continue;
      placeholders[key] = {
        modelId: String(v.modelId).trim(),
        label: String(v.label).trim(),
      };
      validPlaceholderCount++;
    }
  }

  const rawLatestVer =
    typeof raw.latestPluginVersion === 'string' ? raw.latestPluginVersion.trim() : '';
  const latestPluginVersion = isValidSemver(rawLatestVer)
    ? rawLatestVer.replace(/^v/i, '')
    : null;
  if (validPricingCount === 0 && validPlaceholderCount === 0 && !latestPluginVersion) {
    return null;
  }

  const explicitReleaseUrl = sanitizeTrustedGithubUrl(raw.releaseUrl, '');
  const explicitDownloadUrl = sanitizeTrustedGithubUrl(raw.downloadUrl, '');
  const explicitArchiveUrl = sanitizeTrustedGithubUrl(raw.archiveFallbackUrl, '');
  const rawSourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : '';
  const isLegacySource = isLegacyGithubRepoUrl(rawSourceUrl);

  return {
    schemaVersion: Number(raw.schemaVersion || 1),
    catalogVersion:
      typeof raw.catalogVersion === 'string' && raw.catalogVersion.trim()
        ? raw.catalogVersion.trim()
        : null,
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : null,
    latestPluginVersion,
    releaseUrl: explicitReleaseUrl || DEFAULT_RELEASE_URL,
    downloadUrl: explicitDownloadUrl || DEFAULT_DOWNLOAD_URL,
    archiveFallbackUrl: explicitArchiveUrl || DEFAULT_ARCHIVE_FALLBACK_URL,
    hasReleaseUrl: Boolean(explicitReleaseUrl),
    hasDownloadUrl: Boolean(explicitDownloadUrl),
    hasArchiveFallbackUrl: Boolean(explicitArchiveUrl),
    fetchedAtMs: isLegacySource ? 0 : Number(raw.fetchedAtMs || 0),
    sourceUrl: isLegacySource ? '' : rawSourceUrl,
    pricing,
    placeholders,
  };
}

/**
 * Rebuilds the in-memory pricing table by merging the bundled local catalog -> cloud cache (with precedence automatically resolved by `updatedAt` recency).
 */
export function rebuildActiveCatalog() {
  const localRaw = loadJson(LOCAL_CATALOG_FILE, null);
  const remoteRaw = loadJson(REMOTE_CATALOG_CACHE_FILE, null);
  const localCat = sanitizeCatalogPayload(localRaw);
  const remoteCat = sanitizeCatalogPayload(remoteRaw);

  const localUpdatedMs = parseIsoMs(localCat?.updatedAt);
  const remoteUpdatedMs = parseIsoMs(remoteCat?.updatedAt);

  const layers = [];
  if (localCat && remoteCat) {
    if (localUpdatedMs > remoteUpdatedMs) {
      layers.push({ kind: 'remote', cat: remoteCat }, { kind: 'local', cat: localCat });
    } else {
      layers.push({ kind: 'local', cat: localCat }, { kind: 'remote', cat: remoteCat });
    }
  } else if (remoteCat) {
    layers.push({ kind: 'remote', cat: remoteCat });
  } else if (localCat) {
    layers.push({ kind: 'local', cat: localCat });
  }

  const nextPricing = {};
  const nextPlaceholders = {};
  let activeSource = 'builtin';
  let catalogVersion = 'builtin';
  let updatedAt = null;
  const installedVersion = readInstalledPluginVersion();
  const customForkRepo = detectCustomGitForkRepo();
  const customForkPrefix = customForkRepo ? `/${customForkRepo.toLowerCase()}` : '';
  let latestPluginVersion = installedVersion;
  let releaseUrl = customForkRepo
    ? `https://github.com/${customForkRepo}/releases/latest`
    : DEFAULT_RELEASE_URL;
  let downloadUrl = customForkRepo
    ? `https://github.com/${customForkRepo}/releases/latest/download/usage-monitor.zip`
    : DEFAULT_DOWNLOAD_URL;
  let archiveFallbackUrl = customForkRepo
    ? `https://codeload.github.com/${customForkRepo}/zip/refs/heads/main`
    : DEFAULT_ARCHIVE_FALLBACK_URL;

  for (const { kind, cat } of layers) {
    for (const [pk, pv] of Object.entries(cat.pricing)) {
      const prevImgOut = nextPricing[pk]?.imageOutput;
      nextPricing[pk] =
        prevImgOut !== undefined && pv.imageOutput === undefined
          ? { ...pv, imageOutput: prevImgOut }
          : pv;
    }
    Object.assign(nextPlaceholders, cat.placeholders);
    if (kind === 'remote' || cat.catalogVersion || cat.updatedAt) {
      activeSource = kind;
    }
    if (cat.catalogVersion) catalogVersion = cat.catalogVersion;
    if (cat.updatedAt) updatedAt = cat.updatedAt;
    const isFromCustomFork = Boolean(
      customForkPrefix &&
        typeof cat.sourceUrl === 'string' &&
        cat.sourceUrl.toLowerCase().includes(customForkPrefix)
    );
    const shouldAcceptCatalogReleaseMeta = !customForkRepo || isFromCustomFork;
    if (shouldAcceptCatalogReleaseMeta && cat.latestPluginVersion) {
      // Use the latestPluginVersion from the higher-priority layer, but never lower than the locally installed version; custom forks ignore upstream versions
      latestPluginVersion =
        compareSemver(cat.latestPluginVersion, installedVersion) > 0
          ? cat.latestPluginVersion
          : installedVersion;
    }
    if (shouldAcceptCatalogReleaseMeta) {
      if (cat.hasReleaseUrl) releaseUrl = cat.releaseUrl;
      if (cat.hasDownloadUrl) downloadUrl = cat.downloadUrl;
      if (cat.hasArchiveFallbackUrl) archiveFallbackUrl = cat.archiveFallbackUrl;
    }
  }

  for (const k of Object.keys(MODEL_PRICING)) delete MODEL_PRICING[k];
  Object.assign(MODEL_PRICING, nextPricing);

  const boundarySet = new Set();
  for (const entry of Object.values(nextPricing)) {
    if (!Array.isArray(entry?.phases)) continue;
    for (const ph of entry.phases) {
      if (Number.isFinite(ph.fromMs) && ph.fromMs > 0) boundarySet.add(ph.fromMs);
      if (Number.isFinite(ph.untilMs) && ph.untilMs > 0) boundarySet.add(ph.untilMs);
    }
  }
  pricingPhaseBoundariesMs = Array.from(boundarySet).sort((a, b) => a - b);

  for (const k of Object.keys(PLACEHOLDER_MAP)) delete PLACEHOLDER_MAP[k];
  Object.assign(PLACEHOLDER_MAP, nextPlaceholders);
  pricingCatalogRevision += 1;

  cloudSyncState.source = activeSource;
  cloudSyncState.catalogVersion = catalogVersion;
  cloudSyncState.updatedAt = updatedAt;
  cloudSyncState.fetchedAtMs = remoteCat?.fetchedAtMs || cloudSyncState.fetchedAtMs || 0;
  cloudSyncState.sourceUrl = remoteCat?.sourceUrl || cloudSyncState.sourceUrl || '';
  cloudSyncState.latestPluginVersion = latestPluginVersion;
  cloudSyncState.releaseUrl = releaseUrl;
  cloudSyncState.downloadUrl = downloadUrl;
  cloudSyncState.archiveFallbackUrl = archiveFallbackUrl;
}

// Build the active pricing catalog immediately upon module initialization
rebuildActiveCatalog();

/**
 * Gets a snapshot of the cloud pricing catalog status and plugin update status for frontend display.
 */
export function getCloudStatus() {
  const currentPluginVersion = readInstalledPluginVersion();
  const rawLatest = cloudSyncState.latestPluginVersion || currentPluginVersion;
  const latestPluginVersion =
    compareSemver(rawLatest, currentPluginVersion) > 0 ? rawLatest : currentPluginVersion;
  const updateAvailable = compareSemver(latestPluginVersion, currentPluginVersion) > 0;
  return {
    currentPluginVersion,
    latestPluginVersion,
    updateAvailable,
    installMode: existsSync(join(PLUGIN_ROOT, '.git')) ? 'git' : 'zip',
    releaseUrl: cloudSyncState.releaseUrl || DEFAULT_RELEASE_URL,
    downloadUrl: cloudSyncState.downloadUrl || DEFAULT_DOWNLOAD_URL,
    catalogVersion: cloudSyncState.catalogVersion || 'builtin',
    catalogUpdatedAt: cloudSyncState.updatedAt || null,
    lastSyncedAtMs: cloudSyncState.fetchedAtMs || 0,
    source: cloudSyncState.source || 'builtin',
    modelCount: Object.keys(MODEL_PRICING).length,
    placeholderCount: Object.keys(PLACEHOLDER_MAP).length,
    isSyncing: Boolean(cloudSyncState.isSyncing),
    lastSyncError: cloudSyncState.lastError || null,
    isUpdating: Boolean(pluginUpdateState.isUpdating),
    lastUpdateResult: pluginUpdateState.lastResult || null,
    lastUpdateError: pluginUpdateState.lastError || null,
  };
}
