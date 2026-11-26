/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Compact, collinear-compressed per-account quota history store
 * (`account-quota-history.mjs`).
 *
 * Records 5-hour and weekly remaining-percentage trajectories across quota pools
 * for the active host account (from live telemetry) and saved backup accounts
 * (from scheduled OAuth refreshes). Bootstraps initial history from existing
 * `quota_reservation_state.json` observations when available.
 */

import { parseIsoMs } from './trajectory-metrics.mjs';
import {
  ACCOUNT_QUOTA_HISTORY_FILE,
  QUOTA_RESERVATION_STATE_FILE,
  loadJson,
  lsRuntimeEndpoint,
  saveJson,
} from '../runtime/paths.mjs';

const AQH_SCHEMA_VERSION = 1;
const AQH_MAX_ACCOUNTS = 32;
const AQH_MAX_POOLS_PER_ACCOUNT = 8;
const AQH_MAX_POINTS_PER_POOL = 1600;
const AQH_PERSIST_MIN_INTERVAL_MS = 5000;
const AQH_CHANGE_EPSILON_PCT = 0.05;
const AQH_MAX_FLAT_MERGE_GAP_MS = 6 * 3600 * 1000;

function aqhClampPct(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  return Math.round(Math.max(0, Math.min(100, num)) * 10) / 10;
}

function aqhNormEmail(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function aqhSameVal(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < AQH_CHANGE_EPSILON_PCT;
}

const AQH_IMPULSE_MAX_SPAN_MS = 20 * 60_000;
const AQH_IMPULSE_MIN_JUMP_PCT = 3;
const AQH_IMPULSE_MAX_NEIGHBOR_DIFF_PCT = 1.2;

function aqhIsIsolatedUpwardImpulse(prevVal, curVal, nextVal) {
  if (prevVal === null || curVal === null || nextVal === null) return false;
  return (
    curVal - prevVal >= AQH_IMPULSE_MIN_JUMP_PCT &&
    curVal - nextVal >= AQH_IMPULSE_MIN_JUMP_PCT &&
    Math.abs(nextVal - prevVal) <= AQH_IMPULSE_MAX_NEIGHBOR_DIFF_PCT
  );
}

/**
 * Removes isolated single-sample upward spikes (e.g. cross-account `init` seed events
 * where remaining % momentarily jumps `94.8 -> 100 -> 94.7` within minutes and snaps
 * right back to the pre-spike trajectory).
 */
export function sanitizeQuotaHistoryPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let removed = false;
  let i = 1;
  while (i < points.length - 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const spanMs = next[0] - prev[0];
    if (
      spanMs >= 0 &&
      spanMs <= AQH_IMPULSE_MAX_SPAN_MS &&
      (aqhIsIsolatedUpwardImpulse(prev[1], cur[1], next[1]) ||
        aqhIsIsolatedUpwardImpulse(prev[2], cur[2], next[2]))
    ) {
      points.splice(i, 1);
      removed = true;
      if (i > 1) i -= 1;
      continue;
    }
    i += 1;
  }
  return removed;
}

function aqhDownsamplePoints(points, targetLen) {
  if (points.length <= targetLen) return points;
  const keepRecent = Math.floor(targetLen * 0.65);
  const oldEnd = points.length - keepRecent;
  const oldQuota = Math.max(2, targetLen - keepRecent);
  const stride = Math.max(2, Math.ceil(oldEnd / oldQuota));
  const compacted = [];
  for (let i = 0; i < oldEnd; i += stride) {
    const sliceEnd = Math.min(oldEnd, i + stride);
    let minPt = points[i];
    let maxPt = points[i];
    for (let j = i + 1; j < sliceEnd; j++) {
      const p = points[j];
      const v = p[1] ?? p[2] ?? 100;
      if (v < (minPt[1] ?? minPt[2] ?? 100)) minPt = p;
      if (v > (maxPt[1] ?? maxPt[2] ?? 0)) maxPt = p;
    }
    if (minPt === maxPt) {
      compacted.push(minPt);
    } else if (minPt[0] <= maxPt[0]) {
      compacted.push(minPt, maxPt);
    } else {
      compacted.push(maxPt, minPt);
    }
  }
  for (let i = oldEnd; i < points.length; i++) {
    compacted.push(points[i]);
  }
  return compacted;
}

function aqhAppendPoint(points, tsMs, r5h, rWk) {
  const len = points.length;
  if (len === 0) {
    points.push([tsMs, r5h, rWk]);
    return true;
  }
  const last = points[len - 1];
  if (tsMs < last[0]) {
    return false;
  }
  const resolved5h = r5h !== null ? r5h : last[1];
  const resolvedWk = rWk !== null ? rWk : last[2];
  if (tsMs === last[0]) {
    if (!aqhSameVal(last[1], resolved5h) || !aqhSameVal(last[2], resolvedWk)) {
      last[1] = resolved5h;
      last[2] = resolvedWk;
      return true;
    }
    return false;
  }
  const unchanged = aqhSameVal(last[1], resolved5h) && aqhSameVal(last[2], resolvedWk);
  if (unchanged && len >= 2) {
    const prev = points[len - 2];
    const prevSame = aqhSameVal(prev[1], resolved5h) && aqhSameVal(prev[2], resolvedWk);
    if (prevSame && tsMs - prev[0] <= AQH_MAX_FLAT_MERGE_GAP_MS) {
      // Collinear flat segment: advance trailing endpoint timestamp in place
      if (tsMs - last[0] < 60_000) return false;
      last[0] = tsMs;
      return true;
    }
  }
  if (unchanged && tsMs - last[0] < 10 * 60_000) {
    return false;
  }
  points.push([tsMs, resolved5h, resolvedWk]);
  if (points.length > AQH_MAX_POINTS_PER_POOL) {
    const trimmed = aqhDownsamplePoints(points, Math.floor(AQH_MAX_POINTS_PER_POOL * 0.8));
    points.length = 0;
    for (let i = 0; i < trimmed.length; i++) points.push(trimmed[i]);
  }
  return true;
}

export function createAccountQuotaHistoryTracker({
  loadState = () => null,
  saveState = () => {},
  loadSeedEvents = () => null,
} = {}) {
  const accountsMap = new Map();
  let latestHostEmail = '';
  let hydrated = false;
  let seededFromQr = false;
  let lastPersistMs = 0;
  let dirty = false;

  function ensureAccountEntry(email, nowMs) {
    let acc = accountsMap.get(email);
    if (acc) {
      acc.updatedAtMs = nowMs;
      return acc;
    }
    if (accountsMap.size >= AQH_MAX_ACCOUNTS) {
      let oldestEmail = null;
      let oldestTs = Infinity;
      for (const [k, v] of accountsMap.entries()) {
        if ((v.updatedAtMs || 0) < oldestTs) {
          oldestTs = v.updatedAtMs || 0;
          oldestEmail = k;
        }
      }
      if (oldestEmail) accountsMap.delete(oldestEmail);
    }
    acc = { updatedAtMs: nowMs, pools: new Map() };
    accountsMap.set(email, acc);
    return acc;
  }

  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
      const raw = loadState();
      if (raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object') {
        seededFromQr = Boolean(raw.seededFromQr);
        for (const [rawEmail, accVal] of Object.entries(raw.accounts)) {
          const email = aqhNormEmail(rawEmail);
          if (!email || !accVal || typeof accVal !== 'object') continue;
          const poolsMap = new Map();
          for (const [pk, pVal] of Object.entries(accVal.pools || {})) {
            if (!pk || !pVal || !Array.isArray(pVal.points)) continue;
            const cleanPts = [];
            for (let i = 0; i < pVal.points.length; i++) {
              const pt = pVal.points[i];
              if (!Array.isArray(pt) || !(Number(pt[0]) > 0)) continue;
              const r5 = aqhClampPct(pt[1]);
              const rw = aqhClampPct(pt[2]);
              if (r5 === null && rw === null) continue;
              cleanPts.push([Math.floor(Number(pt[0])), r5, rw]);
            }
            if (cleanPts.length > 0) {
              if (sanitizeQuotaHistoryPoints(cleanPts)) {
                dirty = true;
              }
              poolsMap.set(pk, {
                label: String(pVal.label || pk),
                reset5hMs: Number(pVal.reset5hMs) > 0 ? Math.floor(Number(pVal.reset5hMs)) : 0,
                resetWeeklyMs:
                  Number(pVal.resetWeeklyMs) > 0 ? Math.floor(Number(pVal.resetWeeklyMs)) : 0,
                points: cleanPts.slice(-AQH_MAX_POINTS_PER_POOL),
              });
            }
          }
          if (poolsMap.size > 0) {
            accountsMap.set(email, {
              updatedAtMs: Number(accVal.updatedAtMs) || Date.now(),
              pools: poolsMap,
            });
          }
        }
      }
    } catch {
      // Ignore corrupt history file and start fresh
    }
  }

  function seedFromReservationEventsIfEmpty(activeEmail) {
    if (seededFromQr || !activeEmail) return;
    const existing = accountsMap.get(activeEmail);
    if (existing && existing.pools.size > 0) {
      seededFromQr = true;
      return;
    }
    seededFromQr = true;
    try {
      const qr = loadSeedEvents();
      const events = Array.isArray(qr?.events) ? qr.events : [];
      if (events.length === 0) return;
      const acc = ensureAccountEntry(activeEmail, Date.now());
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const pk = String(ev?.pool || '').trim();
        const win = String(ev?.win || '').trim();
        const tsMs = parseIsoMs(ev?.ts);
        const used = Number(ev?.usedPct);
        if (!pk || !(tsMs > 0) || !Number.isFinite(used)) continue;
        const rem = aqhClampPct(100 - used);
        if (rem === null) continue;
        let poolEntry = acc.pools.get(pk);
        if (!poolEntry) {
          if (acc.pools.size >= AQH_MAX_POOLS_PER_ACCOUNT) continue;
          poolEntry = { label: pk, reset5hMs: 0, resetWeeklyMs: 0, points: [] };
          acc.pools.set(pk, poolEntry);
        }
        if (ev?.event === 'init' && poolEntry.points.length > 0) {
          const lastPt = poolEntry.points[poolEntry.points.length - 1];
          const prevVal = win === 'weekly' ? lastPt[2] : lastPt[1];
          if (prevVal !== null && rem - prevVal >= AQH_IMPULSE_MIN_JUMP_PCT) {
            continue;
          }
        }
        aqhAppendPoint(
          poolEntry.points,
          tsMs,
          win === '5h' ? rem : null,
          win === 'weekly' ? rem : null
        );
        dirty = true;
      }
      for (const poolEntry of acc.pools.values()) {
        sanitizeQuotaHistoryPoints(poolEntry.points);
      }
    } catch {
      // Optional seed is best-effort
    }
  }

  function persistIfNeeded(nowMs, force = false) {
    if (!dirty) return;
    if (!force && lastPersistMs > 0 && nowMs - lastPersistMs < AQH_PERSIST_MIN_INTERVAL_MS) {
      return;
    }
    lastPersistMs = nowMs;
    dirty = false;
    const serializedAccounts = {};
    for (const [email, acc] of accountsMap.entries()) {
      const poolsObj = {};
      for (const [pk, pVal] of acc.pools.entries()) {
        if (!pVal.points.length) continue;
        poolsObj[pk] = {
          label: pVal.label,
          ...(pVal.reset5hMs > 0 ? { reset5hMs: pVal.reset5hMs } : {}),
          ...(pVal.resetWeeklyMs > 0 ? { resetWeeklyMs: pVal.resetWeeklyMs } : {}),
          points: pVal.points,
        };
      }
      if (Object.keys(poolsObj).length > 0) {
        serializedAccounts[email] = {
          updatedAtMs: acc.updatedAtMs,
          pools: poolsObj,
        };
      }
    }
    try {
      saveState({
        schemaVersion: AQH_SCHEMA_VERSION,
        seededFromQr,
        updatedAt: new Date(nowMs).toISOString(),
        accounts: serializedAccounts,
      });
    } catch {
      // Best-effort persistence
    }
  }

  function recordSnapshot(rawEmail, pools, nowMs = Date.now(), { isActiveHost = false } = {}) {
    const email = aqhNormEmail(rawEmail);
    if (!email || !Array.isArray(pools) || pools.length === 0) return;
    hydrate();
    if (isActiveHost) {
      latestHostEmail = email;
      seedFromReservationEventsIfEmpty(email);
    }
    const tsMs = Number.isFinite(Number(nowMs)) && Number(nowMs) > 0 ? Math.floor(Number(nowMs)) : Date.now();
    const acc = ensureAccountEntry(email, tsMs);
    let anyChanged = false;

    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      const pk = String(p?.poolKey || p?.family || p?.poolLabel || '').trim();
      if (!pk || pk === 'Unknown') continue;
      const r5h = aqhClampPct(p?.remainingPct ?? p?.remaining5hPct);
      const rWk = aqhClampPct(p?.weeklyRemainingPct ?? p?.remainingWeeklyPct);
      if (r5h === null && rWk === null) continue;

      let poolEntry = acc.pools.get(pk);
      if (!poolEntry) {
        if (acc.pools.size >= AQH_MAX_POOLS_PER_ACCOUNT) continue;
        poolEntry = {
          label: String(p?.poolLabel || pk),
          reset5hMs: 0,
          resetWeeklyMs: 0,
          points: [],
        };
        acc.pools.set(pk, poolEntry);
      }
      if (p?.poolLabel) poolEntry.label = String(p.poolLabel);
      const nextReset5h = parseIsoMs(p?.resetTime || p?.reset5h);
      const nextResetWk = parseIsoMs(p?.weeklyResetTime || p?.resetWeekly);
      if (nextReset5h > 0 && nextReset5h !== poolEntry.reset5hMs) {
        poolEntry.reset5hMs = nextReset5h;
        anyChanged = true;
      }
      if (nextResetWk > 0 && nextResetWk !== poolEntry.resetWeeklyMs) {
        poolEntry.resetWeeklyMs = nextResetWk;
        anyChanged = true;
      }
      if (aqhAppendPoint(poolEntry.points, tsMs, r5h, rWk)) {
        anyChanged = true;
      }
    }

    if (anyChanged) {
      dirty = true;
      persistIfNeeded(tsMs, false);
    }
  }

  function removeAccount(rawEmail, nowMs = Date.now()) {
    const email = aqhNormEmail(rawEmail);
    if (!email) return;
    hydrate();
    if (accountsMap.delete(email)) {
      dirty = true;
      persistIfNeeded(nowMs, true);
    }
  }

  function getHistoryPayload({ allowedEmails = null } = {}) {
    hydrate();
    const allowSet = Array.isArray(allowedEmails)
      ? new Set(allowedEmails.map(aqhNormEmail).filter(Boolean))
      : null;
    const out = {};
    for (const [email, acc] of accountsMap.entries()) {
      if (allowSet && !allowSet.has(email)) continue;
      const poolsObj = {};
      for (const [pk, pVal] of acc.pools.entries()) {
        if (!pVal.points.length) continue;
        poolsObj[pk] = {
          label: pVal.label,
          ...(pVal.reset5hMs > 0 ? { reset5hMs: pVal.reset5hMs } : {}),
          ...(pVal.resetWeeklyMs > 0 ? { resetWeeklyMs: pVal.resetWeeklyMs } : {}),
          points: pVal.points,
        };
      }
      if (Object.keys(poolsObj).length > 0) {
        out[email] = { pools: poolsObj };
      }
    }
    return out;
  }

  function reset() {
    accountsMap.clear();
    latestHostEmail = '';
    hydrated = true;
    seededFromQr = false;
    lastPersistMs = 0;
    dirty = false;
  }

  return {
    recordSnapshot,
    removeAccount,
    getHistoryPayload,
    getLatestHostEmail: () => latestHostEmail,
    flush: (nowMs = Date.now()) => persistIfNeeded(nowMs, true),
    reset,
  };
}

function aqhIsTestRuntime() {
  return (
    lsRuntimeEndpoint?.addr === 'test.invalid' ||
    String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid'
  );
}

const defaultAccountQuotaHistoryTracker = createAccountQuotaHistoryTracker({
  loadState: () => (aqhIsTestRuntime() ? null : loadJson(ACCOUNT_QUOTA_HISTORY_FILE, null)),
  saveState: (payload) => {
    if (!aqhIsTestRuntime()) saveJson(ACCOUNT_QUOTA_HISTORY_FILE, payload);
  },
  loadSeedEvents: () => (aqhIsTestRuntime() ? null : loadJson(QUOTA_RESERVATION_STATE_FILE, null)),
});

export function recordAccountQuotaSnapshot(email, pools, nowMs = Date.now(), opts = {}) {
  defaultAccountQuotaHistoryTracker.recordSnapshot(email, pools, nowMs, opts);
}

export function removeAccountQuotaHistory(email, nowMs = Date.now()) {
  defaultAccountQuotaHistoryTracker.removeAccount(email, nowMs);
}

export function getAccountQuotaHistoryPayload(opts = {}) {
  return defaultAccountQuotaHistoryTracker.getHistoryPayload(opts);
}

export function getLatestRecordedHostEmail() {
  return defaultAccountQuotaHistoryTracker.getLatestHostEmail();
}

export function flushAccountQuotaHistoryNow(nowMs = Date.now()) {
  defaultAccountQuotaHistoryTracker.flush(nowMs);
}

export function resetAccountQuotaHistoryState() {
  defaultAccountQuotaHistoryTracker.reset();
}
