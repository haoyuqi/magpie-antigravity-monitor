/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Shared lazy-loaded, $O(1)$ case-insensitive, 30s-throttled trajectory cache store
 * reused by both the local sidecar (`config.mjs`) and remote SSH endpoints (`endpoint-registry.mjs`).
 *
 * Supports dual persistence backends behind a 100% compatible API:
 * - SQLite incremental ledger (`trajectory-sqlite-ledger.mjs`) with 24-session hot `detail` LRU
 *   and permanent archived ledger retention when conversations are deleted in Antigravity;
 * - JSON/in-memory fallback for environments without `node:sqlite` or VM unit-test sandboxes.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { inferCompactionStepModels, normalizeCachedStep } from './trajectory-metrics.mjs';
import { isPlainObject } from './http-helpers.mjs';
import { hasBuiltinNodeSqlite } from './sqlite-client.mjs';
import { writeTrajectoryCacheFile } from './trajectory-cache-file.mjs';
import {
  computePrecomputedStepFlags,
  createTrajectorySqliteLedger,
} from './trajectory-sqlite-ledger.mjs';

export const CACHE_RUNNING_SAVE_INTERVAL_MS = 30_000;
export const DEFAULT_HOT_SESSION_LRU_LIMIT = 64;
const TCS_WAL_SYNC_MIN_INTERVAL_MS = 250;

function tcsMarkColdSlimSteps(steps) {
  if (Array.isArray(steps)) {
    Object.defineProperty(steps, '_isColdSlimSteps', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return steps;
}

function tcsIsColdEntry(entry) {
  return Boolean(entry && (entry._coldSteps === true || entry.steps?._isColdSlimSteps === true));
}

function tcsDefineHiddenProp(obj, key, value) {
  if (!obj || typeof obj !== 'object') return;
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function tcsAttachEntryStepFlags(entry, flags) {
  if (!entry || typeof entry !== 'object') return;
  const resolved = flags || entry._stepFlags || computePrecomputedStepFlags(entry.steps);
  tcsDefineHiddenProp(entry, '_stepFlags', resolved);
}

function tcsIsVirtualSandboxPath(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  return norm.startsWith('/test/') || norm.startsWith('/test-home/');
}

/**
 * Normalizes and repairs raw trajectory cache JSON into an unprototyped map.
 *
 * @param {unknown} rawLoaded
 * @returns {{ cacheObj: Record<string, any>, migrated: boolean }}
 */
export function hydrateTrajectoryCacheObject(rawLoaded) {
  const cacheObj = Object.create(null);
  let migrated = rawLoaded !== null && rawLoaded !== undefined && !isPlainObject(rawLoaded);
  if (isPlainObject(rawLoaded)) {
    for (const [id, entry] of Object.entries(rawLoaded)) {
      if (!id || !isPlainObject(entry)) {
        migrated = true;
        continue;
      }
      const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
      if (!Array.isArray(entry.steps)) migrated = true;
      const objectSteps = rawSteps.filter((s) => isPlainObject(s));
      if (objectSteps.length !== rawSteps.length) migrated = true;
      const normalizedSteps = objectSteps.map((s) => {
        const norm = normalizeCachedStep(s);
        if (norm !== s) migrated = true;
        return norm;
      });
      const finalSteps = inferCompactionStepModels(normalizedSteps);
      for (let i = 0; i < finalSteps.length; i += 1) {
        if (finalSteps[i] !== normalizedSteps[i]) {
          migrated = true;
          break;
        }
      }
      const nextEntry = { ...entry, steps: finalSteps };
      tcsAttachEntryStepFlags(nextEntry, computePrecomputedStepFlags(finalSteps));
      cacheObj[id] = nextEntry;
    }
  }
  return { cacheObj, migrated };
}

/**
 * Creates an isolated trajectory cache store with lazy first-read hydration,
 * case-insensitive canonical key index, 24-session hot detail LRU, and 30-second throttled disk flushes.
 *
 * @param {{
 *   cacheFilePath?: string,
 *   sqliteFilePath?: string,
 *   enableSqlite?: boolean | null,
 *   hotSessionLimit?: number,
 *   loadJsonFn?: (filePath: string, fallback: any) => any,
 *   writeCacheFn?: (filePath: string, cacheObj: Record<string, any>) => boolean,
 *   shouldBypassThrottleFn?: (allowThrottleInTest: boolean) => boolean,
 *   registerExitHook?: boolean,
 * }} options
 */
export function createTrajectoryCacheStore({
  cacheFilePath = '',
  sqliteFilePath = '',
  enableSqlite = null,
  hotSessionLimit = DEFAULT_HOT_SESSION_LRU_LIMIT,
  loadJsonFn = null,
  writeCacheFn = null,
  shouldBypassThrottleFn = () => false,
  registerExitHook = false,
}) {
  const maxHotSessions = Math.max(1, Math.floor(Number(hotSessionLimit) || DEFAULT_HOT_SESSION_LRU_LIMIT));
  const useSqlite =
    enableSqlite === true
      ? Boolean(sqliteFilePath && hasBuiltinNodeSqlite())
      : enableSqlite === false
        ? false
        : Boolean(
            sqliteFilePath &&
              hasBuiltinNodeSqlite() &&
              !tcsIsVirtualSandboxPath(sqliteFilePath)
          );

  const sqliteLedger = useSqlite
    ? createTrajectorySqliteLedger({
        sqliteFilePath,
        legacyJsonPath: cacheFilePath,
        loadJsonFn,
      })
    : null;

  let cacheObj = Object.create(null);
  const byLower = new Map();
  // Map<lowerId, true> preserving insertion order (oldest -> newest) for hot hydrated sessions
  const hotLru = new Map();
  const dirtyUpserts = new Set();
  const dirtyRemovals = new Set();
  let pendingEpochBump = false;
  let loadedOnce = false;
  let lastWalSyncCheckMs = 0;

  const state = {
    needsSave: false,
    lastSavedAtMs: 0,
    flushTimer: null,
  };

  function defaultWriteCache(targetPath, dataObj) {
    if (!targetPath) return true;
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeTrajectoryCacheFile(targetPath, dataObj);
      return true;
    } catch (err) {
      console.error(`Failed writing trajectory cache ${targetPath}: ${err.message}`);
      return false;
    }
  }

  const doWriteJson = writeCacheFn || defaultWriteCache;

  function finalizeColdEntryInPlace(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    const preFlags = entry._stepFlags || null;
    if (Object.prototype.hasOwnProperty.call(entry, '_coldSteps')) {
      delete entry._coldSteps;
    }
    if (Object.prototype.hasOwnProperty.call(entry, '_stepFlags')) {
      delete entry._stepFlags;
    }
    tcsDefineHiddenProp(entry, '_coldSteps', true);
    if (preFlags) {
      tcsDefineHiddenProp(entry, '_stepFlags', preFlags);
    }
    tcsMarkColdSlimSteps(entry.steps);
    return entry;
  }

  function touchHotSession(lower) {
    if (!useSqlite || !lower) return;
    if (hotLru.has(lower)) {
      hotLru.delete(lower);
    }
    hotLru.set(lower, true);
    evictOverflowHotSessions();
  }

  function dehydrateSingleSessionToCold(lower) {
    if (!useSqlite || !sqliteLedger || !lower) return false;
    if (dirtyUpserts.has(lower)) return false;
    const canon = byLower.get(lower);
    const entry = canon ? cacheObj[canon] : null;
    if (!entry || entry.wasRunning) return false;
    if (tcsIsColdEntry(entry)) {
      hotLru.delete(lower);
      return true;
    }
    const curSteps = Array.isArray(entry.steps) ? entry.steps : [];
    const flags = entry._stepFlags || computePrecomputedStepFlags(curSteps);
    const slimSteps = tcsMarkColdSlimSteps(curSteps.map((s) => sqliteLedger.dehydrateStep(s)));
    entry.steps = slimSteps;
    tcsDefineHiddenProp(entry, '_coldSteps', true);
    tcsDefineHiddenProp(entry, '_stepFlags', flags);
    hotLru.delete(lower);
    return true;
  }

  function evictOverflowHotSessions() {
    if (!useSqlite || hotLru.size <= maxHotSessions) return;
    for (const candidateLower of Array.from(hotLru.keys())) {
      if (hotLru.size <= maxHotSessions) break;
      dehydrateSingleSessionToCold(candidateLower);
    }
  }

  function rebuildLowerIndexFromCacheObj(markCold = false) {
    byLower.clear();
    hotLru.clear();
    for (const key of Object.keys(cacheObj)) {
      const lower = key.toLowerCase();
      byLower.set(lower, key);
      if (markCold) {
        finalizeColdEntryInPlace(cacheObj[key]);
      }
    }
  }

  function ensureLoaded() {
    if (loadedOnce) return;
    if (useSqlite && sqliteLedger) {
      const hydrated = sqliteLedger.openAndHydrateInitial();
      cacheObj = hydrated.cacheObj;
      loadedOnce = true;
      rebuildLowerIndexFromCacheObj(true);
      lastWalSyncCheckMs = Date.now();
      return;
    }
    if (!cacheFilePath || typeof loadJsonFn !== 'function') {
      loadedOnce = true;
      return;
    }
    const loaded = loadJsonFn(cacheFilePath, {});
    const hydrated = hydrateTrajectoryCacheObject(loaded);
    cacheObj = hydrated.cacheObj;
    loadedOnce = true;
    for (const key of Object.keys(cacheObj)) {
      byLower.set(key.toLowerCase(), key);
    }
    if (hydrated.migrated) {
      state.needsSave = true;
    }
  }

  function syncExternalChangesNow() {
    if (!useSqlite || !sqliteLedger || !loadedOnce) return false;
    lastWalSyncCheckMs = Date.now();
    let res;
    try {
      res = sqliteLedger.syncExternalChangesIfNeeded();
    } catch {
      return false;
    }
    if (!res || !res.changed) return false;
    if (res.fullReset && res.cacheObj) {
      for (const [cid, entry] of Object.entries(res.cacheObj)) {
        const lower = cid.toLowerCase();
        if (dirtyUpserts.has(lower)) continue;
        finalizeColdEntryInPlace(entry);
      }
      // Preserve any local unflushed dirty entries on top of the peer reset
      const preservedDirty = [];
      for (const dirtyLower of dirtyUpserts) {
        const canon = byLower.get(dirtyLower);
        if (canon && cacheObj[canon]) {
          preservedDirty.push([canon, cacheObj[canon]]);
        }
      }
      cacheObj = res.cacheObj;
      rebuildLowerIndexFromCacheObj(true);
      for (const [canon, dirtyEntry] of preservedDirty) {
        cacheObj[canon] = dirtyEntry;
        byLower.set(canon.toLowerCase(), canon);
        touchHotSession(canon.toLowerCase());
      }
      return true;
    }
    if (Array.isArray(res.updatedEntries)) {
      for (const { cascadeId, lowerId, entry } of res.updatedEntries) {
        if (dirtyUpserts.has(lowerId) || dirtyRemovals.has(lowerId)) continue;
        const prevCanon = byLower.get(lowerId);
        if (prevCanon && prevCanon !== cascadeId) {
          delete cacheObj[prevCanon];
        }
        finalizeColdEntryInPlace(entry);
        cacheObj[cascadeId] = entry;
        byLower.set(lowerId, cascadeId);
        hotLru.delete(lowerId);
      }
      return true;
    }
    return false;
  }

  function syncExternalIfDue() {
    if (!useSqlite || !loadedOnce) return;
    const now = Date.now();
    if (now - lastWalSyncCheckMs < TCS_WAL_SYNC_MIN_INTERVAL_MS) return;
    syncExternalChangesNow();
  }

  function cancelFlushTimer() {
    if (state.flushTimer) {
      try {
        clearTimeout(state.flushTimer);
      } catch {
        // Ignore sandbox missing clearTimeout
      }
      state.flushTimer = null;
    }
  }

  function flushTrajectoryCacheNow() {
    ensureLoaded();
    cancelFlushTimer();

    if (useSqlite && sqliteLedger) {
      if (dirtyUpserts.size === 0 && dirtyRemovals.size === 0 && !pendingEpochBump) {
        state.needsSave = false;
        return true;
      }
      const upserts = [];
      for (const lower of dirtyUpserts) {
        const canon = byLower.get(lower);
        const entry = canon ? cacheObj[canon] : null;
        if (canon && entry) {
          upserts.push({ cascadeId: canon, entry });
        }
      }
      const removals = Array.from(dirtyRemovals);
      try {
        sqliteLedger.flushDeltaBatch({
          upserts,
          removals,
          bumpEpoch: pendingEpochBump,
        });
        dirtyUpserts.clear();
        dirtyRemovals.clear();
        pendingEpochBump = false;
        state.needsSave = false;
        state.lastSavedAtMs = Date.now();
        lastWalSyncCheckMs = state.lastSavedAtMs;
        evictOverflowHotSessions();
        return true;
      } catch (err) {
        console.error(`Failed flushing trajectory SQLite ledger ${sqliteFilePath}: ${err.message}`);
        state.needsSave = true;
        return false;
      }
    }

    if (!cacheFilePath) {
      state.needsSave = false;
      return true;
    }
    const ok = doWriteJson(cacheFilePath, cacheObj);
    state.needsSave = !ok;
    if (ok) {
      state.lastSavedAtMs = Date.now();
    }
    return ok;
  }

  function persistTrajectoryCacheIfNeeded({
    hasRunningSessions = false,
    allowThrottleInTest = false,
  } = {}) {
    if (!useSqlite && !cacheFilePath) {
      state.needsSave = false;
      return;
    }
    if (shouldBypassThrottleFn(allowThrottleInTest) || typeof setTimeout !== 'function') {
      flushTrajectoryCacheNow();
      return;
    }
    const nowMs = Date.now();
    const elapsedMs = nowMs - (state.lastSavedAtMs || 0);
    if (
      !hasRunningSessions ||
      state.lastSavedAtMs === 0 ||
      elapsedMs >= CACHE_RUNNING_SAVE_INTERVAL_MS
    ) {
      flushTrajectoryCacheNow();
      return;
    }
    state.needsSave = true;
    if (!state.flushTimer) {
      const delayMs = Math.max(100, CACHE_RUNNING_SAVE_INTERVAL_MS - elapsedMs);
      const timer = setTimeout(() => {
        state.flushTimer = null;
        if (state.needsSave) {
          flushTrajectoryCacheNow();
        }
      }, delayMs);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      state.flushTimer = timer;
    }
  }

  function hydrateEntryInPlaceIfNeeded(canonId, entry) {
    if (!canonId || !entry) return entry;
    const lower = canonId.toLowerCase();
    if (!useSqlite || !sqliteLedger) return entry;
    if (!tcsIsColdEntry(entry)) {
      touchHotSession(lower);
      return entry;
    }
    const fullSteps = sqliteLedger.loadHydratedStepsForConversation(canonId, entry);
    if (Array.isArray(fullSteps)) {
      const flags = entry._stepFlags || computePrecomputedStepFlags(fullSteps);
      entry.steps = fullSteps;
      tcsDefineHiddenProp(entry, '_coldSteps', false);
      tcsDefineHiddenProp(entry, '_stepFlags', flags);
      touchHotSession(lower);
    }
    return entry;
  }

  /**
   * Non-destructively clears live/empty cached entries to force fresh re-scanning, while
   * permanently archiving & preserving any conversation with `steps.length > 0` whose source
   * conversation has already been deleted (`!liveSet.has(lower)` or `entry.archived === true`).
   *
   * @param {{ liveCascadeIds?: Iterable<string> | null }} [options]
   */
  function clearCache({ liveCascadeIds = null } = {}) {
    ensureLoaded();
    syncExternalChangesNow();

    const liveSet =
      liveCascadeIds !== null && liveCascadeIds !== undefined
        ? new Set(
            Array.from(liveCascadeIds, (id) => String(id || '').trim().toLowerCase()).filter(
              Boolean
            )
          )
        : null;

    const retainedEntries = Object.create(null);
    const removedLowers = [];
    const archivedUpserts = [];

    for (const [key, entry] of Object.entries(cacheObj)) {
      const lower = key.toLowerCase();
      const hasSteps = Array.isArray(entry?.steps) && entry.steps.length > 0;
      const isDeletedHistorical =
        hasSteps && (entry.archived === true || (liveSet !== null && !liveSet.has(lower)));
      if (isDeletedHistorical) {
        const archivedEntry = entry.archived === true ? entry : { ...entry, archived: true };
        if (tcsIsColdEntry(entry)) {
          tcsDefineHiddenProp(archivedEntry, '_coldSteps', true);
        }
        if (entry._stepFlags) {
          tcsDefineHiddenProp(archivedEntry, '_stepFlags', entry._stepFlags);
        }
        retainedEntries[key] = archivedEntry;
        if (entry.archived !== true || dirtyUpserts.has(lower)) {
          archivedUpserts.push({ cascadeId: key, entry: archivedEntry });
        }
      } else {
        removedLowers.push(lower);
      }
    }

    if (useSqlite && sqliteLedger) {
      try {
        sqliteLedger.flushDeltaBatch({
          upserts: archivedUpserts,
          removals: removedLowers,
          bumpEpoch: true,
        });
      } catch (err) {
        console.error(`Failed clearing trajectory SQLite ledger ${sqliteFilePath}: ${err.message}`);
        return false;
      }
    } else if (cacheFilePath && !doWriteJson(cacheFilePath, retainedEntries)) {
      return false;
    }

    cancelFlushTimer();
    loadedOnce = true;
    cacheObj = retainedEntries;
    byLower.clear();
    for (const key of Object.keys(cacheObj)) {
      const lower = key.toLowerCase();
      byLower.set(lower, key);
    }
    for (const remLower of removedLowers) {
      hotLru.delete(remLower);
      dirtyUpserts.delete(remLower);
      dirtyRemovals.delete(remLower);
    }
    for (const { cascadeId } of archivedUpserts) {
      dirtyUpserts.delete(cascadeId.toLowerCase());
    }
    pendingEpochBump = false;
    state.needsSave = false;
    state.lastSavedAtMs = 0;
    return true;
  }

  if (registerExitHook && typeof process !== 'undefined' && typeof process?.once === 'function') {
    process.once('exit', () => {
      if (loadedOnce && state.needsSave) {
        flushTrajectoryCacheNow();
      }
    });
  }

  function lookupRawByLower(cascadeId) {
    if (!cascadeId) return null;
    ensureLoaded();
    syncExternalIfDue();
    const direct = cacheObj[cascadeId];
    if (direct) return { id: String(cascadeId), entry: direct };
    const canon = byLower.get(String(cascadeId).toLowerCase());
    if (canon && cacheObj[canon]) {
      return { id: canon, entry: cacheObj[canon] };
    }
    return null;
  }

  return {
    cacheFilePath,
    sqliteFilePath: useSqlite ? sqliteFilePath : '',
    isSqliteBacked: useSqlite,
    cacheState: state,
    cancelFlushTimer,
    syncExternalChangesNow,
    getHotSessionCount() {
      return hotLru.size;
    },
    isConversationCold(cascadeId) {
      const hit = lookupRawByLower(cascadeId);
      return hit ? tcsIsColdEntry(hit.entry) : false;
    },
    getCachedTrajectory(cascadeId) {
      ensureLoaded();
      syncExternalIfDue();
      return cacheObj[cascadeId];
    },
    getCachedTrajectoryEntryByLower(cascadeId) {
      return lookupRawByLower(cascadeId);
    },
    getHydratedTrajectory(cascadeId) {
      const hit = lookupRawByLower(cascadeId);
      if (!hit) return undefined;
      return hydrateEntryInPlaceIfNeeded(hit.id, hit.entry);
    },
    getHydratedTrajectoryEntryByLower(cascadeId) {
      const hit = lookupRawByLower(cascadeId);
      if (!hit) return null;
      return {
        id: hit.id,
        entry: hydrateEntryInPlaceIfNeeded(hit.id, hit.entry),
      };
    },
    listCachedTrajectoryEntries() {
      ensureLoaded();
      syncExternalIfDue();
      return Object.entries(cacheObj);
    },
    setCachedTrajectory(cascadeId, entry) {
      ensureLoaded();
      const lower = String(cascadeId || '').toLowerCase();
      const prevCanon = lower ? byLower.get(lower) : undefined;
      if (
        prevCanon &&
        prevCanon !== cascadeId &&
        Object.prototype.hasOwnProperty.call(cacheObj, prevCanon)
      ) {
        delete cacheObj[prevCanon];
      }
      if (entry && typeof entry === 'object') {
        const isStillCold = Boolean(entry.steps?._isColdSlimSteps === true);
        tcsDefineHiddenProp(entry, '_coldSteps', isStillCold);
        tcsAttachEntryStepFlags(entry, entry._stepFlags || null);
        if (useSqlite && lower) {
          dirtyRemovals.delete(lower);
          dirtyUpserts.add(lower);
          if (!isStillCold) {
            touchHotSession(lower);
          }
        }
      }
      cacheObj[cascadeId] = entry;
      if (lower) {
        byLower.set(lower, String(cascadeId));
      }
    },
    removeCachedTrajectory(cascadeId) {
      ensureLoaded();
      const lower = String(cascadeId || '').toLowerCase();
      const canon = lower ? byLower.get(lower) : undefined;
      if (canon && Object.prototype.hasOwnProperty.call(cacheObj, canon)) {
        delete cacheObj[canon];
      }
      delete cacheObj[cascadeId];
      if (lower) {
        byLower.delete(lower);
        hotLru.delete(lower);
        if (useSqlite) {
          dirtyUpserts.delete(lower);
          dirtyRemovals.add(lower);
        }
      }
    },
    hasPendingTrajectoryCacheSave() {
      ensureLoaded();
      return state.needsSave;
    },
    persistTrajectoryCacheIfNeeded,
    flushTrajectoryCacheNow,
    clearCache,
  };
}
