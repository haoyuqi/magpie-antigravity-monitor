/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Pure display thresholds, compact formatting, third-party quota pooling, and exact integer scaling rules shared across Backend / Frontend / CLI.
 */

export const THIRD_PARTY_POOL_RE =
  /3p|claude|anthropic|fable|gpt|openai|oss|sonnet|opus|haiku|third[-_\s]?party/i;

/**
 * Determine whether a model or quota bucket text belongs to the third-party model pool (Claude & GPT / OSS / 3P).
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isThirdPartyPoolText(text) {
  return THIRD_PARTY_POOL_RE.test(String(text || ''));
}

/**
 * Four-tier semantic color classification for output speed (`'muted'|'good'|'info'|'warn'|'danger'`).
 */
export function classifySpeedTier(tokPerSec) {
  if (tokPerSec == null || !Number.isFinite(Number(tokPerSec)) || Number(tokPerSec) <= 0) {
    return 'muted';
  }
  const v = Number(tokPerSec);
  if (v >= 60) return 'good';
  if (v >= 35) return 'info';
  if (v >= 20) return 'warn';
  return 'danger';
}

/**
 * Four-tier semantic color classification for cache hit rate (`'muted'|'good'|'info'|'warn'|'danger'`).
 */
export function classifyCacheTier(cacheHitPct, promptTokens = null) {
  if (cacheHitPct == null || !Number.isFinite(Number(cacheHitPct))) {
    return 'muted';
  }
  const v = Number(cacheHitPct);
  if (promptTokens != null && Number(promptTokens) <= 0 && v <= 0) {
    return 'muted';
  }
  if (v >= 85) return 'good';
  if (v >= 65) return 'info';
  if (v >= 30) return 'warn';
  return 'danger';
}

/**
 * Alert color tier classification for per-step cost (`''|'warn'|'danger'`).
 */
export function classifyStepCostTier(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '';
  const v = Number(costUsd);
  if (v >= 0.3) return 'danger';
  if (v >= 0.15) return 'warn';
  return '';
}

/**
 * Alert color tier classification for time-to-first-token (TTFT) latency (`'muted'|''|'warn'|'danger'`).
 */
export function classifyTtftTier(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) {
    return 'muted';
  }
  const v = Number(ttftSec);
  if (v >= 30) return 'danger';
  if (v >= 18) return 'warn';
  return '';
}

export function formatCompactTokens(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCompactCapsuleCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '--';
  const val = Math.max(0, Number(costUsd));
  if (val === 0) return '$0.00';
  if (val < 0.001) return '<$0.001';
  if (val < 1) return `$${val.toFixed(3)}`;
  if (val < 100) return `$${val.toFixed(2)}`;
  return `$${Math.round(val)}`;
}

export function formatCompactCapsuleTtft(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) return '--s';
  const val = Number(ttftSec);
  if (val < 1) return `${val.toFixed(2)}s`;
  if (val < 100) return `${val.toFixed(1)}s`;
  return `${Math.round(val)}s`;
}

function readPoolWeeklyRemainingPct(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const raw = pool.weeklyRemainingPct ?? pool.remainingWeeklyPct;
  return raw != null && Number.isFinite(Number(raw)) ? Number(raw) : null;
}

function isArgonPoolObject(pool) {
  if (!pool || typeof pool !== 'object') return false;
  if (pool.poolKey === 'Argon' || pool.family === 'Argon') return true;
  return /\bargon\b/i.test(String(pool.poolKey || pool.poolLabel || pool.family || ''));
}

/**
 * Determine whether the current quota summary contains an independent Argon weekly quota pool (e.g., Google AI Pro accounts).
 *
 * @param {object|null|undefined} quotas
 * @returns {boolean}
 */
export function hasArgonWeeklyQuotaPool(quotas) {
  if (!quotas || typeof quotas !== 'object') return false;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const argonPool = pools.find(isArgonPoolObject);
  if (argonPool && readPoolWeeklyRemainingPct(argonPool) != null) {
    return true;
  }
  const activePool = quotas.activePool;
  if (activePool && isArgonPoolObject(activePool) && readPoolWeeklyRemainingPct(activePool) != null) {
    return true;
  }
  return false;
}

/**
 * Resolve the integer remaining percentage for a specified capsule quota slot (`quota_auto` / `gemini_5h` / `gemini_weekly` / `argon_weekly` / `claude_5h` / `claude_weekly`).
 *
 * @param {object|null|undefined} quotas
 * @param {string} slotKey
 * @returns {number|null}
 */
export function resolveCapsuleQuotaSlotPct(quotas, slotKey) {
  if (!quotas || typeof quotas !== 'object') return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const activePool = quotas.activePool || null;
  const weekly = quotas.weekly || null;

  if (slotKey === 'quota_auto') {
    const candidates = [];
    if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
      candidates.push(Number(activePool.remainingPct));
    }
    const activeWk = readPoolWeeklyRemainingPct(activePool);
    if (activeWk != null) {
      candidates.push(activeWk);
    }
    if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
      candidates.push(Number(weekly.remainingPct));
    }
    if (!candidates.length && pools.length > 0) {
      for (const p of pools) {
        if (p && Number.isFinite(Number(p.remainingPct))) candidates.push(Number(p.remainingPct));
        const pWk = readPoolWeeklyRemainingPct(p);
        if (pWk != null) candidates.push(pWk);
      }
    }
    if (!candidates.length) return null;
    return Math.max(0, Math.min(100, Math.round(Math.min(...candidates))));
  }

  if (slotKey === 'argon_weekly') {
    const argonPool = pools.find(isArgonPoolObject);
    let argonPct = readPoolWeeklyRemainingPct(argonPool);
    if (argonPct == null && isArgonPoolObject(activePool)) {
      argonPct = readPoolWeeklyRemainingPct(activePool);
    }
    if (argonPct == null || !Number.isFinite(argonPct)) return null;
    return Math.max(0, Math.min(100, Math.round(argonPct)));
  }

  const isClaude = slotKey.startsWith('claude_');
  const isWeekly = slotKey.endsWith('_weekly');
  let rawPct = null;

  if (isClaude) {
    const claudePool =
      pools.find((p) => p?.poolKey === 'Claude & GPT') ||
      pools.find((p) => isThirdPartyPoolText(p?.poolKey || p?.poolLabel || ''));
    const cand = isWeekly ? readPoolWeeklyRemainingPct(claudePool) : claudePool?.remainingPct;
    if (cand != null && Number.isFinite(Number(cand))) {
      rawPct = Number(cand);
    } else if (activePool && isThirdPartyPoolText(activePool.family || activePool.poolLabel || '')) {
      const fb = isWeekly ? readPoolWeeklyRemainingPct(activePool) : activePool.remainingPct;
      if (fb != null && Number.isFinite(Number(fb))) rawPct = Number(fb);
    }
  } else {
    const stdGemini =
      pools.find((p) => p?.poolKey === 'Gemini') ||
      pools.find(
        (p) =>
          /gemini/i.test(String(p?.poolKey || p?.poolLabel || '')) &&
          !/carbon|argon/i.test(String(p?.poolKey || ''))
      );
    const geminiFamilyPools = pools.filter((p) =>
      /gemini|carbon|argon/i.test(String(p?.poolKey || p?.poolLabel || ''))
    );
    const primaryCand = isWeekly ? readPoolWeeklyRemainingPct(stdGemini) : stdGemini?.remainingPct;
    if (primaryCand != null && Number.isFinite(Number(primaryCand))) {
      rawPct = Number(primaryCand);
    } else {
      const familyVals = geminiFamilyPools
        .map((p) => (isWeekly ? readPoolWeeklyRemainingPct(p) : p?.remainingPct))
        .filter((v) => v != null && Number.isFinite(Number(v)))
        .map(Number);
      if (familyVals.length > 0) {
        rawPct = Math.min(...familyVals);
      } else if (
        activePool &&
        !isThirdPartyPoolText(activePool.family || activePool.poolLabel || '')
      ) {
        const fb = isWeekly ? readPoolWeeklyRemainingPct(activePool) : activePool.remainingPct;
        if (fb != null && Number.isFinite(Number(fb))) rawPct = Number(fb);
      }
      if (
        rawPct == null &&
        isWeekly &&
        weekly &&
        !isThirdPartyPoolText(weekly.poolFamily || '') &&
        weekly.remainingPct != null &&
        Number.isFinite(Number(weekly.remainingPct))
      ) {
        rawPct = Number(weekly.remainingPct);
      }
    }
  }

  if (rawPct == null || !Number.isFinite(rawPct)) return null;
  return Math.max(0, Math.min(100, Math.round(rawPct)));
}

/**
 * Proportionally scale non-zero buckets to a target integer total using the largest-remainder method (Hamilton method),
 * ensuring zero-value channels never receive phantom remainders and that the scaled buckets sum exactly to `targetTotal`.
 *
 * @param {Record<string, number>} buckets
 * @param {readonly string[]} keys
 * @param {number} targetTotal
 * @returns {Record<string, number>}
 */
export function scaleBucketsExact(buckets, keys, targetTotal) {
  const safeTarget = Math.max(0, Math.round(Number(targetTotal || 0)));
  const out = {};
  let currentSum = 0;
  for (const k of keys) {
    const val = Math.max(0, Number(buckets[k] || 0));
    out[k] = val;
    currentSum += val;
  }
  if (safeTarget === 0 || currentSum <= 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }
  if (currentSum === safeTarget) {
    for (const k of keys) out[k] = Math.round(out[k]);
    return out;
  }
  const remainders = [];
  let assigned = 0;
  for (const k of keys) {
    const rawVal = out[k];
    if (rawVal <= 0) {
      out[k] = 0;
      continue;
    }
    const exact = (rawVal * safeTarget) / currentSum;
    const floored = Math.floor(exact);
    out[k] = floored;
    assigned += floored;
    remainders.push({ key: k, rem: exact - floored, orig: rawVal });
  }
  const diff = safeTarget - assigned;
  if (diff > 0 && remainders.length > 0) {
    remainders.sort((a, b) => b.rem - a.rem || b.orig - a.orig);
    for (let i = 0; i < diff; i++) {
      out[remainders[i % remainders.length].key] += 1;
    }
  }
  return out;
}
