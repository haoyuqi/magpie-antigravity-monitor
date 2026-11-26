/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Official quota bucket normalization, cycle window detection, and multi-model pool construction (Gemini / Argon / Carbon / Claude & GPT).
 *
 * Handles all known Antigravity server-side quota shapes:
 * - Google AI Ultra: Argon / Carbon share the same Gemini Models quota pool with Flash;
 * - Google AI Pro (Shape 1): `RetrieveUserQuotaSummary` returns separate `Gemini 4 Argon` / `Gemini 4 Carbon` groups;
 * - Google AI Pro (Shape 2): `Gemini Models` group nests independent `argon-weekly` / `carbon-weekly` buckets;
 * - Google AI Pro (Shape 3): `GetUserStatus` `clientModelConfigs.quotaInfo` reports an independent remaining fraction for Argon / Carbon distinct from standard Gemini;
 * - Proto3 zero-value omission compatibility: when quota is exhausted (`remainingFraction === 0`) causing the field to be omitted and a valid unexpired `resetTime` exists, correctly identify it as 0% remaining (100% used).
 */

import { parseIsoMs } from './trajectory-metrics.mjs';
import { THIRD_PARTY_POOL_RE } from './telemetry-display-rules.mjs';
import {
  isArgonModelIdentifier,
  isCarbonModelIdentifier,
  resolveModelInfo,
} from './model-pricing.mjs';

/**
 * Normalizes a raw quota object (from a `RetrieveUserQuotaSummary` bucket or `clientModelConfigs.quotaInfo`) into a percentage structure.
 *
 * @param {object} rawObj
 * @param {number} [nowMs=Date.now()]
 * @returns {{
 *   remainingFraction: number,
 *   remainingPct: number,
 *   remainingIntPct: number,
 *   usedPct: number,
 *   resetTime: string|null,
 *   description: string
 * } | null}
 */
function normalizeQuotaFraction(rawObj, nowMs = Date.now()) {
  if (!rawObj || typeof rawObj !== 'object') return null;
  let remFrac = null;
  if (rawObj.disabled === true) {
    remFrac = 0;
  } else if (
    rawObj.remainingFraction !== undefined &&
    rawObj.remainingFraction !== null &&
    Number.isFinite(Number(rawObj.remainingFraction))
  ) {
    remFrac = Math.max(0, Math.min(1, Number(rawObj.remainingFraction)));
  } else if (typeof rawObj.resetTime === 'string' && rawObj.resetTime.trim().length > 0) {
    // Proto3 omits default numeric fields when quota is completely exhausted (0.0); only treat as 0% remaining if resetTime is a valid future timestamp
    const resetMs = parseIsoMs(rawObj.resetTime);
    if (resetMs > nowMs) {
      remFrac = 0;
    }
  }
  if (remFrac === null) return null;
  const usedFrac = Math.max(0, Math.min(1, 1 - remFrac));
  return {
    remainingFraction: remFrac,
    remainingPct: +(remFrac * 100).toFixed(1),
    remainingIntPct: Math.floor(remFrac * 100 + 1e-6),
    usedPct: +(usedFrac * 100).toFixed(1),
    resetTime: rawObj.resetTime || null,
    description: rawObj.description || '',
  };
}

/**
 * Identifies the time window type (`'5h'` or `'weekly'`) of an official quota bucket.
 *
 * @param {object} bucket
 * @param {number} [_groupBucketCount=1] Total bucket count in the parent group (retained for signature compatibility)
 * @param {number} [nowMs=Date.now()] Current millisecond timestamp
 * @returns {'5h'|'weekly'}
 */
function classifyOfficialBucketWindow(bucket, _groupBucketCount = 1, nowMs = Date.now()) {
  const w = String(bucket?.window || '')
    .trim()
    .toLowerCase();
  const idAndName = `${bucket?.bucketId || ''} ${bucket?.displayName || ''}`.toLowerCase();
  if (
    w === '5h' ||
    /(?:^|[-_\s])5h(?:$|[-_\s])|five[-_\s]?hour/.test(w) ||
    /(?:^|[-_\s])5h(?:$|[-_\s])|five[-_\s]?hour/.test(idAndName)
  ) {
    return '5h';
  }
  if (w === 'weekly' || w === '7d' || /week/.test(w) || /week/.test(idAndName)) {
    return 'weekly';
  }
  const resetMs = parseIsoMs(bucket?.resetTime);
  if (resetMs > 0 && resetMs <= nowMs + 6 * 3600 * 1000) {
    return '5h';
  }
  return 'weekly';
}

/**
 * Identifies the quota pool identity (`Gemini` / `Argon` / `Carbon` / `Claude & GPT`) from group name, group description, and bucket ID.
 * Prioritizes explicit third-party model pool identifiers so a group description containing `"separate from Gemini"` does not get misclassified into Gemini.
 *
 * @param {{ groupName?: string, groupDesc?: string, bucketId?: string, bucketName?: string }} params
 * @returns {{ poolKey: string, poolLabel: string, poolName: string }}
 */
function classifyQuotaPoolIdentity({
  groupName = '',
  groupDesc = '',
  bucketId = '',
  bucketName = '',
}) {
  const bId = String(bucketId || '');
  const bName = String(bucketName || '');
  const gName = String(groupName || '');
  const gDesc = String(groupDesc || '');
  const primaryText = `${bId} ${bName} ${gName}`;

  if (
    /carbon/i.test(bId) ||
    /carbon/i.test(bName) ||
    /carbon/i.test(gName) ||
    (/\bcarbon\b/i.test(gDesc) &&
      !/\bflash\b/i.test(gDesc) &&
      !/^gemini models$/i.test(gName.trim()))
  ) {
    return {
      poolKey: 'Carbon',
      poolLabel: 'Gemini 4 Carbon',
      poolName: 'Gemini 4 Carbon Model Pool',
    };
  }
  if (
    /argon/i.test(bId) ||
    /argon/i.test(bName) ||
    /argon/i.test(gName) ||
    (/\bargon\b/i.test(gDesc) &&
      !/\bflash\b/i.test(gDesc) &&
      !/^gemini models$/i.test(gName.trim()))
  ) {
    return {
      poolKey: 'Argon',
      poolLabel: 'Gemini 4 Argon',
      poolName: 'Gemini 4 Argon Model Pool',
    };
  }
  if (
    THIRD_PARTY_POOL_RE.test(primaryText) ||
    (!/gemini/i.test(primaryText) && THIRD_PARTY_POOL_RE.test(gDesc))
  ) {
    return {
      poolKey: 'Claude & GPT',
      poolLabel: 'Claude & GPT',
      poolName: 'Claude & GPT Model Pool',
    };
  }
  if (/gemini/i.test(`${primaryText} ${gDesc}`)) {
    return {
      poolKey: 'Gemini',
      poolLabel: 'Gemini',
      poolName: 'Gemini Model Pool',
    };
  }
  const cleanLabel = (gName || bId || 'Other').trim();
  return {
    poolKey: cleanLabel,
    poolLabel: cleanLabel,
    poolName: `${cleanLabel} Model Pool`,
  };
}

/**
 * Determines whether two normalized quota snapshots represent the same shared quota bucket (remaining percentage difference <= 1.5% and reset time difference <= 2 minutes).
 *
 * @param {ReturnType<typeof normalizeQuotaFraction>} a
 * @param {ReturnType<typeof normalizeQuotaFraction>} b
 * @returns {boolean}
 */
function quotaFractionsMatch(a, b) {
  if (!a || !b) return false;
  if (Math.abs(a.remainingFraction - b.remainingFraction) > 0.015) return false;
  if (a.resetTime && b.resetTime) {
    const diffMs = Math.abs(parseIsoMs(a.resetTime) - parseIsoMs(b.resetTime));
    if (diffMs > 120_000) return false;
  }
  return true;
}

/**
 * Combines `RetrieveUserQuotaSummary` and `GetUserStatus.clientModelConfigs` to build the dynamic model map,
 * per-model quota list, and aggregated quota pool map (`quotaPoolsMap`).
 *
 * @param {object|null} officialQuota Response body from `RetrieveUserQuotaSummary`
 * @param {object[]} clientConfigs Client model config array from `GetUserStatus`
 * @returns {{
 *   dynamicModelMap: Map<string, object>,
 *   quotaPoolsMap: Map<string, object>,
 *   modelQuotas: object[]
 * }}
 */
export function buildOfficialQuotaPools(officialQuota, clientConfigs = []) {
  const dynamicModelMap = new Map();
  const nowForQuotaMs = Date.now();
  const poolBuilders = new Map();

  function ensurePoolBuilder({ poolKey, poolLabel, poolName }) {
    if (!poolBuilders.has(poolKey)) {
      poolBuilders.set(poolKey, {
        poolKey,
        poolLabel,
        poolName,
        bucket5h: null,
        bucketWeekly: null,
        fallback5h: null,
        models: [],
      });
    }
    return poolBuilders.get(poolKey);
  }

  const rawGroups = Array.isArray(officialQuota?.groups) ? [...officialQuota.groups] : [];
  if (
    Array.isArray(officialQuota?.buckets) &&
    officialQuota.buckets.length > 0 &&
    rawGroups.length === 0
  ) {
    rawGroups.push({ displayName: '', description: '', buckets: officialQuota.buckets });
  }

  for (const grp of rawGroups) {
    const grpBuckets = Array.isArray(grp?.buckets) ? grp.buckets : [];
    for (const b of grpBuckets) {
      const norm = normalizeQuotaFraction(b, nowForQuotaMs);
      if (!norm) continue;
      const ident = classifyQuotaPoolIdentity({
        groupName: grp?.displayName,
        groupDesc: grp?.description,
        bucketId: b?.bucketId,
        bucketName: b?.displayName,
      });
      const win = classifyOfficialBucketWindow(b, grpBuckets.length, nowForQuotaMs);
      const entry = {
        ...norm,
        bucketId: b?.bucketId || '',
        groupName: grp?.displayName || ident.poolLabel,
        window: win,
      };
      const builder = ensurePoolBuilder(ident);
      if (win === '5h') {
        if (!builder.bucket5h) {
          builder.bucket5h = entry;
        } else if (!builder.bucketWeekly) {
          // When two unlabeled buckets in the same pool are both within <6h of reset, distinguish 5h vs weekly by earlier vs later reset time
          const prevResetMs = parseIsoMs(builder.bucket5h.resetTime);
          const nextResetMs = parseIsoMs(entry.resetTime);
          if (prevResetMs > 0 && nextResetMs > 0 && nextResetMs < prevResetMs) {
            builder.bucketWeekly = { ...builder.bucket5h, window: 'weekly' };
            builder.bucket5h = entry;
          } else {
            builder.bucketWeekly = { ...entry, window: 'weekly' };
          }
        }
      } else if (!builder.bucketWeekly) {
        builder.bucketWeekly = entry;
      }
    }
  }

  // Register the dynamic model dictionary (without polluting modelId with placeholder rawKey), and sample per-model quotaInfo for Carbon / Argon vs standard Gemini
  let sampleCarbonCfgQuota = null;
  let sampleArgonCfgQuota = null;
  let sampleStdGeminiCfgQuota = null;

  for (const cfg of clientConfigs) {
    const rawKey = cfg?.modelOrAlias?.model;
    if (rawKey) {
      dynamicModelMap.set(rawKey, {
        modelId: cfg.modelId || '',
        label: cfg.label || cfg.modelId || rawKey,
        quotaInfo: cfg.quotaInfo || null,
      });
    }
    const info = resolveModelInfo(rawKey, dynamicModelMap);
    const cfgQuota = normalizeQuotaFraction(cfg?.quotaInfo, nowForQuotaMs);
    if (!cfgQuota || info.family !== 'Gemini') continue;
    if (isCarbonModelIdentifier(rawKey, cfg?.modelId, cfg?.label, info.modelId)) {
      if (!sampleCarbonCfgQuota) sampleCarbonCfgQuota = cfgQuota;
    } else if (isArgonModelIdentifier(rawKey, cfg?.modelId, cfg?.label, info.modelId)) {
      if (!sampleArgonCfgQuota) sampleArgonCfgQuota = cfgQuota;
    } else if (!sampleStdGeminiCfgQuota) {
      sampleStdGeminiCfgQuota = cfgQuota;
    }
  }

  // Pro account fallback detection: if RetrieveUserQuotaSummary did not list separate Argon / Carbon groups,
  // but GetUserStatus reports clearly distinct quotaInfo for Argon / Carbon vs standard Gemini, synthesize an independent weekly pool
  if (!poolBuilders.has('Argon') && sampleArgonCfgQuota) {
    const geminiBuilder = poolBuilders.get('Gemini');
    const hasGeminiBaseline = Boolean(
      sampleStdGeminiCfgQuota || geminiBuilder?.bucket5h || geminiBuilder?.bucketWeekly
    );
    const matchesSharedGemini =
      quotaFractionsMatch(sampleArgonCfgQuota, sampleStdGeminiCfgQuota) ||
      quotaFractionsMatch(sampleArgonCfgQuota, geminiBuilder?.bucket5h) ||
      quotaFractionsMatch(sampleArgonCfgQuota, geminiBuilder?.bucketWeekly);

    if (hasGeminiBaseline && !matchesSharedGemini) {
      const argonBuilder = ensurePoolBuilder({
        poolKey: 'Argon',
        poolLabel: 'Gemini 4 Argon',
        poolName: 'Gemini 4 Argon Model Pool',
      });
      argonBuilder.bucketWeekly = {
        ...sampleArgonCfgQuota,
        bucketId: 'argon-weekly-inferred',
        groupName: 'Gemini 4 Argon',
        window: 'weekly',
      };
    }
  }

  if (!poolBuilders.has('Carbon') && sampleCarbonCfgQuota) {
    const geminiBuilder = poolBuilders.get('Gemini');
    const argonBuilder = poolBuilders.get('Argon');
    const hasBaseline = Boolean(
      sampleStdGeminiCfgQuota ||
        sampleArgonCfgQuota ||
        geminiBuilder?.bucket5h ||
        geminiBuilder?.bucketWeekly ||
        argonBuilder?.bucketWeekly
    );
    const matchesSharedPool =
      quotaFractionsMatch(sampleCarbonCfgQuota, sampleStdGeminiCfgQuota) ||
      quotaFractionsMatch(sampleCarbonCfgQuota, sampleArgonCfgQuota) ||
      quotaFractionsMatch(sampleCarbonCfgQuota, geminiBuilder?.bucket5h) ||
      quotaFractionsMatch(sampleCarbonCfgQuota, geminiBuilder?.bucketWeekly) ||
      quotaFractionsMatch(sampleCarbonCfgQuota, argonBuilder?.bucketWeekly);

    if (hasBaseline && !matchesSharedPool) {
      const carbonBuilder = ensurePoolBuilder({
        poolKey: 'Carbon',
        poolLabel: 'Gemini 4 Carbon',
        poolName: 'Gemini 4 Carbon Model Pool',
      });
      carbonBuilder.bucketWeekly = {
        ...sampleCarbonCfgQuota,
        bucketId: 'carbon-weekly-inferred',
        groupName: 'Gemini 4 Carbon',
        window: 'weekly',
      };
    }
  }

  const hasDedicatedArgonPool = poolBuilders.has('Argon');
  const hasDedicatedCarbonPool = poolBuilders.has('Carbon');
  const modelQuotas = [];

  for (const cfg of clientConfigs) {
    const rawKey = cfg?.modelOrAlias?.model;
    const info = resolveModelInfo(rawKey, dynamicModelMap);
    const isCarbon = isCarbonModelIdentifier(rawKey, cfg?.modelId, cfg?.label, info.modelId);
    const isArgon = isArgonModelIdentifier(rawKey, cfg?.modelId, cfg?.label, info.modelId);
    const isGemini = info.family === 'Gemini';
    const targetIdent =
      isCarbon && hasDedicatedCarbonPool
        ? { poolKey: 'Carbon', poolLabel: 'Gemini 4 Carbon', poolName: 'Gemini 4 Carbon Model Pool' }
        : isArgon && hasDedicatedArgonPool
          ? { poolKey: 'Argon', poolLabel: 'Gemini 4 Argon', poolName: 'Gemini 4 Argon Model Pool' }
          : isGemini
            ? { poolKey: 'Gemini', poolLabel: 'Gemini', poolName: 'Gemini Model Pool' }
            : { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', poolName: 'Claude & GPT Model Pool' };

    const builder = ensurePoolBuilder(targetIdent);
    if (cfg?.label && !builder.models.includes(cfg.label)) {
      builder.models.push(cfg.label);
    }

    const cfgQuota = normalizeQuotaFraction(cfg?.quotaInfo, nowForQuotaMs);
    const cfgResetMs = parseIsoMs(cfgQuota?.resetTime);
    const isCfgWeekly =
      targetIdent.poolKey === 'Argon' ||
      targetIdent.poolKey === 'Carbon' ||
      cfgResetMs > nowForQuotaMs + 6 * 3600 * 1000;
    if (!builder.bucket5h && !builder.bucketWeekly && !builder.fallback5h && cfgQuota) {
      if (isCfgWeekly) {
        builder.bucketWeekly = { ...cfgQuota, window: 'weekly' };
      } else {
        builder.fallback5h = cfgQuota;
      }
    }

    const eff5h = builder.bucket5h || (!builder.bucketWeekly ? cfgQuota : null);
    const effWk = builder.bucketWeekly;
    const hasValid5h = Boolean(eff5h);
    modelQuotas.push({
      label: cfg.label,
      modelId: cfg.modelId || info.modelId,
      rawKey,
      family: targetIdent.poolKey,
      isAvailable: Boolean(eff5h || effWk || cfgQuota),
      remainingPct: hasValid5h ? eff5h.remainingPct : null,
      remainingIntPct: hasValid5h ? eff5h.remainingIntPct : null,
      usedPct: hasValid5h ? eff5h.usedPct : null,
      resetTime: hasValid5h ? eff5h.resetTime : null,
      weeklyRemainingPct: effWk?.remainingPct ?? null,
      weeklyRemainingIntPct: effWk?.remainingIntPct ?? null,
      weeklyUsedPct: effWk?.usedPct ?? null,
      weeklyResetTime: effWk?.resetTime || null,
    });
  }

  // Ensure the base Gemini and Claude & GPT model pools always exist
  ensurePoolBuilder({ poolKey: 'Gemini', poolLabel: 'Gemini', poolName: 'Gemini Model Pool' });
  ensurePoolBuilder({
    poolKey: 'Claude & GPT',
    poolLabel: 'Claude & GPT',
    poolName: 'Claude & GPT Model Pool',
  });

  const quotaPoolsMap = new Map();
  for (const [poolKey, builder] of poolBuilders.entries()) {
    const b5h = builder.bucket5h || builder.fallback5h || null;
    const bWk = builder.bucketWeekly || null;
    quotaPoolsMap.set(poolKey, {
      poolKey,
      poolLabel: builder.poolLabel,
      poolName: builder.poolName,
      family: poolKey,
      isAvailable: Boolean(b5h || bWk),
      has5h: Boolean(b5h),
      hasWeekly: Boolean(bWk),
      remainingFraction: b5h?.remainingFraction ?? null,
      remainingPct: b5h?.remainingPct ?? null,
      remainingIntPct: b5h?.remainingIntPct ?? null,
      usedPct: b5h?.usedPct ?? null,
      resetTime: b5h?.resetTime || null,
      weeklyRemainingFraction: bWk?.remainingFraction ?? null,
      weeklyRemainingPct: bWk?.remainingPct ?? null,
      weeklyRemainingIntPct: bWk?.remainingIntPct ?? null,
      weeklyUsedPct: bWk?.usedPct ?? null,
      weeklyResetTime: bWk?.resetTime || null,
      models: builder.models,
    });
  }

  return {
    dynamicModelMap,
    quotaPoolsMap,
    modelQuotas,
  };
}
