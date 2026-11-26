/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Model identity resolution, display name normalization, and per-step API-equivalent cost calculation.
 *
 * Core principles:
 * 1. Merge the server-provided dynamic model catalog (`dynamicModelMap`), static placeholder table (`PLACEHOLDER_MAP`),
 *    and actual response model (`responseModel`) with priority, matching exact pricing entries with tier suffixes first;
 * 2. When pricing is unknown or model identity cannot be confirmed, strictly return `pricing: null` and `costUsd: null`,
 *    never borrowing unit prices from other models to fabricate costs.
 */

import { parseIsoMs } from './trajectory-metrics.mjs';
import { MODEL_PRICING, PLACEHOLDER_MAP } from './pricing-catalog.mjs';

/**
 * Infers the model family (`'Gemini'` | `'Claude'` | `'GPT'` | `'Other'`) from API provider enum or model identifiers.
 * Note: match more specific `ANTHROPIC`/`CLAUDE` and `OPENAI`/`GPT` (including `o1`/`o3`/`o4` series) first,
 * preventing `API_PROVIDER_GOOGLE_VERTEX_ANTHROPIC` from being prematurely misclassified as `'Gemini'` by a broad `GOOGLE` substring.
 *
 * @param {string} [rawModelKey=''] Raw model key or placeholder
 * @param {string} [modelId=''] Normalized model ID
 * @param {string} [apiProvider=''] Upstream API provider enum string
 * @param {string} [displayLabel=''] Resolved model display label
 * @returns {'Gemini'|'Claude'|'GPT'|'Other'}
 */
function inferFamilyFromProviderOrKey(
  rawModelKey = '',
  modelId = '',
  apiProvider = '',
  displayLabel = ''
) {
  const prov = String(apiProvider || '').toUpperCase();
  if (prov.includes('ANTHROPIC') || prov.includes('CLAUDE')) return 'Claude';
  if (prov.includes('OPENAI') || prov.includes('GPT')) return 'GPT';
  if (prov.includes('GEMINI') || prov.includes('GOOGLE')) return 'Gemini';

  const combined = `${rawModelKey} ${modelId} ${displayLabel}`.toUpperCase();
  if (
    combined.includes('ANTHROPIC') ||
    combined.includes('CLAUDE') ||
    combined.includes('FABLE') ||
    combined.includes('SONNET') ||
    combined.includes('OPUS') ||
    combined.includes('HAIKU')
  ) {
    return 'Claude';
  }
  if (
    combined.includes('GPT') ||
    combined.includes('OPENAI') ||
    /\bO[134](?:[-_\s]|$)/.test(combined)
  ) {
    return 'GPT';
  }
  if (
    combined.includes('GEMINI') ||
    combined.includes('CARBON') ||
    combined.includes('ARGON') ||
    combined.includes('NEON') ||
    combined.includes('HYDROGEN') ||
    combined.includes('ORCHESTRATOR') ||
    combined.includes('HELIX') ||
    combined.includes('FLASH') ||
    combined.includes('GOOGLE')
  ) {
    return 'Gemini';
  }
  return 'Other';
}

/**
 * Checks whether a set of model identifier fields refers to the Gemini 4 Neon series (including M535 and M537 Orchestrator (Neon)).
 *
 * @param {...string} parts Identifier fragments to inspect
 * @returns {boolean}
 */
export function isNeonModelIdentifier(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) &&
    !/\bneon\b|MODEL_PLACEHOLDER_M53[57]\b/i.test(text)
  ) {
    return false;
  }
  return /\bneon\b|gemini-(?:4-)?neon|MODEL_PLACEHOLDER_M53[57]\b/i.test(text);
}

/**
 * Checks whether a set of model identifier fields refers to the Gemini 4 Argon series (including M417/M418/M419 and M681 Orchestrator (Argon)).
 *
 * @param {...string} parts Identifier fragments to inspect
 * @returns {boolean}
 */
export function isArgonModelIdentifier(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) &&
    !/\bargon\b|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text)
  ) {
    return false;
  }
  return /argon|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text);
}

/**
 * Normalizes an Orchestrator variant label or routing suffix into a compact codename (e.g. `"Claude Opus 5.5"` -> `"opus-5.5"`, `"Xenon"` -> `"xenon"`).
 *
 * @param {string} [raw='']
 * @returns {string}
 */
function normalizeOrchestratorVariantSlug(raw = '') {
  let s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s || /^worker(?:$|-)/.test(s)) return '';
  s = s.replace(/([a-z]-)(\d+)-(\d+)(?=$|-)/g, '$1$2.$3');
  s = s
    .replace(/^(?:claude|anthropic|openai)-(?=.+)/, '')
    .replace(/^gemini-(?:4-)?(?=(?:carbon|argon|neon|hydrogen|helix)(?:$|-))/, '');
  return s;
}

/**
 * Extracts an explicit non-generic Orchestrator variant codename from identifier fields (e.g. `Orchestrator (Opus 5.5)` -> `'opus-5.5'`,
 * `Orchestrator (Xenon)` -> `'xenon'`, `claude-opus-5-5-orchestrator` -> `'opus-5.5'`). Returns an empty string if unmatched.
 *
 * @param {...string} parts
 * @returns {string}
 */
function extractExplicitOrchestratorVariant(...parts) {
  for (const rawPart of parts) {
    const part = String(rawPart || '').trim();
    if (!part) continue;
    const parenAfter = part.match(/\bOrchestrator\s*\(\s*([^)]+?)\s*\)/i);
    if (parenAfter) {
      const v = normalizeOrchestratorVariantSlug(parenAfter[1]);
      if (v) return v;
    }
    const parenBefore = part.match(
      /^([a-z0-9][a-z0-9.\s-]{0,40}?)\s*\(\s*Orchestrator\s*\)(?:\s*\[[^\]]+\])?$/i
    );
    if (parenBefore) {
      const v = normalizeOrchestratorVariantSlug(parenBefore[1]);
      if (v) return v;
    }
    const prefixSlug = part.match(
      /\b(?:gemini-pro-orchestrator|orchestrator|orch)-([a-z0-9]+(?:[.-][a-z0-9]+)*)(?=·|\s|$)/i
    );
    if (prefixSlug) {
      const v = normalizeOrchestratorVariantSlug(prefixSlug[1]);
      if (v) return v;
    }
    const suffixSlug = part.match(/\b([a-z0-9]+(?:[.-][a-z0-9]+)*)-orchestrator(?=·|\s|$)/i);
    if (suffixSlug && !/^gemini-pro$/i.test(suffixSlug[1])) {
      const v = normalizeOrchestratorVariantSlug(suffixSlug[1]);
      if (v) return v;
    }
  }
  return '';
}

/**
 * Checks whether a set of model identifier fields refers to the Gemini 4 Carbon series (including M427/M429/M437/M438 and M667 Orchestrator (Carbon)).
 * Only classifies as Carbon when a Carbon identifier is explicitly matched or bare `gemini-pro-orchestrator` carries no other variant codename,
 * preventing future `Orchestrator (<new-codename>)` variants from being silently misclassified as Carbon.
 *
 * @param {...string} parts Identifier fragments to inspect
 * @returns {boolean}
 */
export function isCarbonModelIdentifier(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (/\bcarbon\b|gemini-4-carbon|MODEL_PLACEHOLDER_M(?:42[79]|43[78]|667)\b/i.test(text)) {
    return true;
  }
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) ||
    /\bneon\b|gemini-(?:4-)?neon|MODEL_PLACEHOLDER_M53[57]\b/i.test(text) ||
    /\bargon\b|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text) ||
    /\b(?:claude|anthropic|opus|sonnet|haiku|fable|gpt|openai)\b/i.test(text) ||
    /\bOrchestrator\s+Worker\b|-worker-agy\b/i.test(text)
  ) {
    return false;
  }
  const explicitVariant = extractExplicitOrchestratorVariant(...parts);
  if (explicitVariant && explicitVariant !== 'carbon') {
    return false;
  }
  return /\bgemini-pro-orchestrator\b(?![-_][a-z0-9])/i.test(text);
}

/**
 * Strips trailing thinking-tier suffixes from a model display name (such as `(XHigh)`, `(High)`, `(Medium)`, `(Thinking)`) to extract the base family name.
 * Preserves `(Carbon)` / `(Argon)` / `(Neon)` suffixes so different Orchestrator series remain separated in summary tables.
 *
 * @param {string} [label='']
 * @returns {string}
 */
export function getBaseModelLabel(label = '') {
  return (
    String(label || '')
      .replace(/\bFlash-Lite\b/gi, 'Flash Lite')
      .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered|Preview)\)\s*$/i, '')
      .trim() || String(label || 'Unknown Model')
  );
}

const SLUG_TIER_LABELS = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  'extra-low': 'Extra Low',
  tiered: 'Tiered',
};

/**
 * Converts strictly matched `gemini-3.1-pro`, `gemini-3.5-flash-lite`, `gemini-4-carbon`, or known internal routing aliases into human-readable labels.
 * Uses end-of-line anchor `$` to prevent unlisted new suffixes (e.g. `gemini-3.1-pro-ultra-v2`) from being silently truncated and disguised as older models with wrong pricing.
 *
 * @param {string} [slug='']
 * @returns {string}
 */
export function formatGenericModelSlug(slug = '') {
  const s = String(slug || '')
    .trim()
    .replace(/^session-display:/i, '');
  if (!s || /^MODEL_PLACEHOLDER_/i.test(s)) return '';
  if (/^gemini-4-argon-(?:b|f|trial|disabled)$/i.test(s)) return 'Gemini 4 Argon';
  if (/^gemini-3\.8-flash-n$/i.test(s)) return 'Gemini 3.8 Flash';
  if (/^gemini-3\.7-flash-safety-le$/i.test(s)) return 'Gemini 3.7 Flash';
  if (/^gemini-3-flash-(?:[abd]|agent)$/i.test(s)) return 'Gemini 3.5 Flash';
  if (/^gemini-3-flash-c$/i.test(s)) return 'Gemini 3 Flash';
  if (/^gemini-pro-(?:default|agent|b)$/i.test(s)) return 'Gemini 3.1 Pro';
  const imgMatch = s.match(
    /^gemini-(\d+(?:\.\d+)?)-(pro|flash)(?:-(lite))?-image(?:-(preview))?$/i
  );
  if (imgMatch) {
    const ver = imgMatch[1];
    const tier = imgMatch[2].charAt(0).toUpperCase() + imgMatch[2].slice(1).toLowerCase();
    const lite = imgMatch[3] ? ' Lite' : '';
    const prev = imgMatch[4] ? ' (Preview)' : '';
    return `Gemini ${ver} ${tier}${lite} Image${prev}`;
  }
  const m = s.match(
    /^gemini-(\d+(?:\.\d+)?)-(pro|flash|argon|carbon|neon|hydrogen|helix)(?:-(lite))?(?:-(xhigh|high|medium|low|extra-low|tiered|preview))?$/i
  );
  if (m) {
    const ver = m[1];
    const tier = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
    const lite = m[3] ? ' Lite' : '';
    const suffixKey = m[4] ? m[4].toLowerCase() : '';
    const tierSuffix = SLUG_TIER_LABELS[suffixKey] ? ` (${SLUG_TIER_LABELS[suffixKey]})` : '';
    return `Gemini ${ver} ${tier}${lite}${tierSuffix}`;
  }
  const codenameMatch = s.match(/^gemini-(hydrogen|helix|neon)$/i);
  if (codenameMatch) {
    const codename =
      codenameMatch[1].charAt(0).toUpperCase() + codenameMatch[1].slice(1).toLowerCase();
    return `Gemini ${codename}`;
  }
  const orchVariantMatch = s.match(/^gemini-pro-orchestrator-([a-z0-9]+)$/i);
  if (orchVariantMatch) {
    const variant =
      orchVariantMatch[1].charAt(0).toUpperCase() + orchVariantMatch[1].slice(1).toLowerCase();
    return `Orchestrator (${variant})`;
  }
  if (/^(?:claude-opus-5[.-]5-orchestrator|orchestrator-(?:claude-)?opus-5[.-]5)$/i.test(s)) {
    return 'Orchestrator (Opus 5.5)';
  }
  if (/^gemini-flash-worker-agy$/i.test(s)) {
    return 'Orchestrator Worker (Hydrogen)';
  }
  if (/^gemini-(?:4-)?neon-worker-agy$/i.test(s)) {
    return 'Orchestrator Worker (Neon)';
  }
  return '';
}

function extractStepTimestampMs(step) {
  if (!step || typeof step !== 'object') return 0;
  const direct = Number(step.createdAtMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (typeof step.createdAt === 'string' && step.createdAt.trim()) {
    return parseIsoMs(step.createdAt.trim()) || 0;
  }
  return 0;
}

/**
 * Matches the time phase (`phases`, half-open interval `[fromMs, untilMs)`) of a model pricing entry for the target timestamp.
 * Falls back to the current time if no valid timestamp is provided; falls back to top-level base unit prices if no phase matches or none are configured.
 *
 * @param {object|null} pricingEntry
 * @param {number|string|null} [atMs]
 * @returns {object|null}
 */
export function resolvePricingAt(pricingEntry, atMs) {
  if (!pricingEntry || typeof pricingEntry !== 'object') return null;
  const baseEntry = pricingEntry._basePricing || pricingEntry;
  const phases = baseEntry.phases;
  if (!Array.isArray(phases) || phases.length === 0) return baseEntry;

  let tMs = 0;
  if (typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0) {
    tMs = atMs;
  } else if (typeof atMs === 'string' && atMs.trim()) {
    tMs = parseIsoMs(atMs.trim()) || 0;
  }
  if (tMs <= 0) {
    tMs = Date.now();
  }

  for (let i = 0; i < phases.length; i++) {
    const ph = phases[i];
    if (!ph || typeof ph !== 'object') continue;
    const fromMs = Number.isFinite(ph.fromMs)
      ? ph.fromMs
      : typeof ph.from === 'string' && ph.from.trim()
        ? parseIsoMs(ph.from.trim()) || -Infinity
        : -Infinity;
    const untilMs = Number.isFinite(ph.untilMs)
      ? ph.untilMs
      : typeof ph.until === 'string' && ph.until.trim()
        ? parseIsoMs(ph.until.trim()) || Infinity
        : Infinity;
    if (tMs >= fromMs && tMs < untilMs) {
      const nextImgOut = ph.imageOutput ?? baseEntry.imageOutput;
      if (
        ph.input === baseEntry.input &&
        ph.cache === baseEntry.cache &&
        ph.output === baseEntry.output &&
        nextImgOut === baseEntry.imageOutput
      ) {
        return baseEntry;
      }
      const resolved = {
        ...baseEntry,
        input: ph.input,
        cache: ph.cache,
        output: ph.output,
        ...(nextImgOut !== undefined ? { imageOutput: nextImgOut } : {}),
      };
      Object.defineProperty(resolved, '_basePricing', {
        value: baseEntry,
        enumerable: false,
      });
      return resolved;
    }
  }
  return baseEntry;
}

function resolveModelCatalogEntry(
  rawModelKey,
  dynamicModelMap = new Map(),
  apiProvider = '',
  modelDisplayName = '',
  responseModel = ''
) {
  const dynEntry =
    dynamicModelMap && typeof dynamicModelMap.get === 'function'
      ? dynamicModelMap.get(rawModelKey)
      : null;
  const staticPh = PLACEHOLDER_MAP[rawModelKey] || null;

  // If GetUserStatus only provided label without a real modelId (or filled it with the placeholder itself), merge the exact modelId from static PLACEHOLDER_MAP
  const dynValidModelId =
    dynEntry?.modelId && dynEntry.modelId !== rawModelKey ? dynEntry.modelId : '';
  const mergedModelId = dynValidModelId || staticPh?.modelId || dynEntry?.modelId || '';
  const mergedLabel = dynEntry?.label || staticPh?.label || '';

  const cleanResponseModel =
    responseModel && responseModel !== 'unknown' ? String(responseModel).trim() : '';
  const cleanRawFallback =
    rawModelKey && rawModelKey !== 'unknown' ? rawModelKey : cleanResponseModel;
  const isHydrogenWorkerSlot =
    rawModelKey === 'MODEL_PLACEHOLDER_M669' ||
    /^gemini-flash-worker-agy$/i.test(cleanResponseModel);
  const isNeonWorkerSlot = /^gemini-(?:4-)?neon-worker-agy$/i.test(cleanResponseModel);
  const isVagueGenericDisplay = Boolean(
    modelDisplayName &&
      (/^gemini\s+(?:flash|pro)(?:\s+worker)?$/i.test(modelDisplayName.trim()) ||
        (isHydrogenWorkerSlot && /^gemini\s+4\s+hydrogen$/i.test(modelDisplayName.trim())) ||
        (isNeonWorkerSlot && /^gemini\s+(?:4\s+)?neon$/i.test(modelDisplayName.trim())))
  );
  const isNamedWorkerDisplay = Boolean(
    modelDisplayName && /\bOrchestrator\s+Worker\s*\([^)]+\)/i.test(modelDisplayName)
  );
  const effectiveDisplayName =
    modelDisplayName &&
    ((mergedLabel &&
      ((/\borchestrator\b/i.test(modelDisplayName) && !isNamedWorkerDisplay) ||
        isVagueGenericDisplay) &&
      !/\borchestrator\b/i.test(mergedLabel)) ||
      (isVagueGenericDisplay && (isHydrogenWorkerSlot || isNeonWorkerSlot)))
      ? ''
      : modelDisplayName;
  const derivedDisplay =
    effectiveDisplayName ||
    mergedLabel ||
    formatGenericModelSlug(rawModelKey) ||
    formatGenericModelSlug(cleanResponseModel) ||
    cleanRawFallback ||
    'Unknown model';

  // Generate an exact slug preserving tier suffix first (e.g. "Gemini 3.8 Flash (Low)" -> "gemini-3.8-flash-low") to prevent being shadowed by base family pricing
  const tieredSlug = derivedDisplay
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .trim()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const tieredDashedSlug = tieredSlug.replace(/\./g, '-');

  const baseLabel = getBaseModelLabel(derivedDisplay);
  const canonicalSlug = baseLabel.toLowerCase().replace(/\s+/g, '-');
  const dashedSlug = canonicalSlug.replace(/\./g, '-');
  const baseTierlessSlug = baseLabel
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .trim()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const baseTierlessDashedSlug = baseTierlessSlug.replace(/\./g, '-');
  const modelId =
    mergedModelId ||
    (rawModelKey && rawModelKey !== 'unknown' ? rawModelKey : cleanResponseModel) ||
    'unknown';

  const isExplicitOrchestratorDisplay = /\borchestrator\b/i.test(derivedDisplay);
  const orchEffortStrippedSlug = isExplicitOrchestratorDisplay
    ? tieredDashedSlug.replace(
        /-(?:max|xhigh|high|medium|low|thinking|extra-low|tiered|preview)$/,
        ''
      )
    : '';
  const displayOrchestratorPricing = isExplicitOrchestratorDisplay
    ? MODEL_PRICING[tieredSlug] ||
      MODEL_PRICING[tieredDashedSlug] ||
      MODEL_PRICING[baseTierlessSlug] ||
      MODEL_PRICING[baseTierlessDashedSlug] ||
      (orchEffortStrippedSlug ? MODEL_PRICING[orchEffortStrippedSlug] : null) ||
      null
    : null;

  const isOpaqueOrchestratorResp = Boolean(
    cleanResponseModel && /\borchestrator\b/i.test(cleanResponseModel)
  );
  const isBareOpaqueOrchestratorResp = /^gemini-pro-orchestrator$/i.test(cleanResponseModel);
  const allowOpaqueOrchestratorFallback =
    isOpaqueOrchestratorResp &&
    (!isBareOpaqueOrchestratorResp ||
      isCarbonModelIdentifier(rawModelKey, modelId, derivedDisplay, cleanResponseModel));
  const explicitPricing =
    MODEL_PRICING[modelId] ||
    MODEL_PRICING[rawModelKey] ||
    displayOrchestratorPricing ||
    (cleanResponseModel && !isOpaqueOrchestratorResp
      ? MODEL_PRICING[cleanResponseModel]
      : null) ||
    MODEL_PRICING[tieredSlug] ||
    MODEL_PRICING[tieredDashedSlug] ||
    MODEL_PRICING[canonicalSlug] ||
    MODEL_PRICING[dashedSlug] ||
    MODEL_PRICING[baseTierlessSlug] ||
    MODEL_PRICING[baseTierlessDashedSlug] ||
    (allowOpaqueOrchestratorFallback ? MODEL_PRICING[cleanResponseModel] : null);

  if (explicitPricing) {
    return {
      catalogPricing: explicitPricing,
      info: {
        rawModel: rawModelKey,
        modelId,
        label: derivedDisplay,
        baseLabel,
        shortName: explicitPricing.short,
        family: explicitPricing.family,
        pricing: explicitPricing,
        isEstimatedPrice: false,
      },
    };
  }

  const inferredFamily = inferFamilyFromProviderOrKey(
    rawModelKey,
    modelId,
    apiProvider,
    derivedDisplay
  );
  return {
    catalogPricing: null,
    info: {
      rawModel: rawModelKey,
      modelId,
      label: derivedDisplay,
      baseLabel,
      shortName: derivedDisplay,
      family: inferredFamily,
      pricing: null,
      isEstimatedPrice: true,
    },
  };
}

/**
 * Combines the dynamic model catalog, placeholder dictionary, and pricing table to resolve step model metadata and unit pricing at a given timestamp.
 *
 * @param {string} rawModelKey Raw model key recorded on the step (e.g. `MODEL_PLACEHOLDER_M320`)
 * @param {Map<string, {modelId: string, label: string, quotaInfo?: object}>} [dynamicModelMap=new Map()] Dynamic model map extracted from `GetUserStatus`
 * @param {string} [apiProvider=''] API provider enum
 * @param {string} [modelDisplayName=''] Known model display name
 * @param {string} [responseModel=''] Actual upstream response model ID (e.g. `gemini-3.8-flash-n`)
 * @param {number|string|null} [atMs=0] Step timestamp (defaults to current time for phase pricing matching)
 */
export function resolveModelInfo(
  rawModelKey,
  dynamicModelMap = new Map(),
  apiProvider = '',
  modelDisplayName = '',
  responseModel = '',
  atMs = 0
) {
  const { catalogPricing, info } = resolveModelCatalogEntry(
    rawModelKey,
    dynamicModelMap,
    apiProvider,
    modelDisplayName,
    responseModel
  );
  if (!catalogPricing) return info;
  const effectivePricing = resolvePricingAt(catalogPricing, atMs);
  return effectivePricing === catalogPricing ? info : { ...info, pricing: effectivePricing };
}

/** Reuses resolved results by model identity and pricing phase within a single telemetry request. */
export function createStepModelResolver(dynamicModelMap) {
  const models = new Map();
  return (step) => {
    const stepMs = extractStepTimestampMs(step);
    const { modelKey, apiProvider = '', modelDisplayName = '', responseModel = '' } = step || {};
    if (
      typeof modelKey !== 'string' ||
      typeof apiProvider !== 'string' ||
      typeof modelDisplayName !== 'string' ||
      typeof responseModel !== 'string'
    ) {
      return resolveModelInfo(
        modelKey,
        dynamicModelMap,
        apiProvider,
        modelDisplayName,
        responseModel,
        stepMs
      );
    }
    let providers = models.get(modelKey);
    if (!providers) models.set(modelKey, (providers = new Map()));
    let names = providers.get(apiProvider);
    if (!names) providers.set(apiProvider, (names = new Map()));
    let responses = names.get(modelDisplayName);
    if (!responses) names.set(modelDisplayName, (responses = new Map()));
    let cached = responses.get(responseModel);
    if (!cached) {
      const { catalogPricing, info } = resolveModelCatalogEntry(
        modelKey,
        dynamicModelMap,
        apiProvider,
        modelDisplayName,
        responseModel
      );
      cached = {
        catalogPricing,
        baseInfo: info,
        byPhaseIdx: catalogPricing?.phases?.length ? new Map() : null,
      };
      responses.set(responseModel, cached);
    }
    if (!cached.byPhaseIdx) {
      return cached.baseInfo;
    }
    const tMs = stepMs > 0 ? stepMs : Date.now();
    const phases = cached.catalogPricing.phases;
    let phaseIdx = -1;
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i];
      const fromMs = Number.isFinite(ph.fromMs) ? ph.fromMs : -Infinity;
      const untilMs = Number.isFinite(ph.untilMs) ? ph.untilMs : Infinity;
      if (tMs >= fromMs && tMs < untilMs) {
        phaseIdx = i;
        break;
      }
    }
    let phasedInfo = cached.byPhaseIdx.get(phaseIdx);
    if (!phasedInfo) {
      const effectivePricing =
        phaseIdx >= 0
          ? resolvePricingAt(cached.catalogPricing, tMs)
          : cached.catalogPricing;
      phasedInfo =
        effectivePricing === cached.catalogPricing
          ? cached.baseInfo
          : { ...cached.baseInfo, pricing: effectivePricing };
      cached.byPhaseIdx.set(phaseIdx, phasedInfo);
    }
    return phasedInfo;
  };
}

/**
 * Annotates opaque Orchestrator routing model IDs with the underlying actual model codename (e.g. `gemini-pro-orchestrator (carbon-4)`),
 * while returning ordinary transparent upstream model IDs (e.g. `gemini-3.8-flash-n`, `gemini-4-hydrogen`) unchanged.
 *
 * @param {string} [rawUpstream='']
 * @param {ReturnType<typeof resolveModelInfo>|null} [mInfo=null]
 * @returns {string}
 */
export function formatUpstreamModelId(rawUpstream = '', mInfo = null) {
  const s = String(rawUpstream || '').trim();
  if (!s || !/(?:orchestrator|-worker-agy\b)/i.test(s) || /\([^)]+\)\s*$/.test(s)) {
    return s;
  }
  const metaText = `${mInfo?.rawModel || ''} ${mInfo?.modelId || ''} ${mInfo?.shortName || ''} ${mInfo?.label || ''} ${s}`;
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(
      metaText
    )
  ) {
    return `${s} (hydrogen-4)`;
  }
  if (isNeonModelIdentifier(mInfo?.rawModel, mInfo?.modelId, mInfo?.label, s)) {
    return `${s} (neon-4)`;
  }
  if (isArgonModelIdentifier(mInfo?.rawModel, mInfo?.modelId, mInfo?.label, s)) {
    return `${s} (argon-4)`;
  }
  if (isCarbonModelIdentifier(mInfo?.rawModel, mInfo?.modelId, mInfo?.label, s)) {
    return `${s} (carbon-4)`;
  }
  if (/\bopus(?:[\s_-]*5[.-]5)\b/i.test(metaText)) {
    return `${s} (opus-5.5)`;
  }
  return s;
}

/**
 * Computes the API-equivalent USD cost for a single step; returns `null` if the model is unpriced (`pricing === null`).
 * Safely clamps negative, NaN, or non-finite numbers to 0.
 *
 * @param {{ inputTokens: number, cacheReadTokens: number, outputTokens: number }} step
 * @param {{ input: number, cache: number, output: number } | null} pricing
 * @returns {number|null}
 */
export function resolveEffectiveOutputRate(pricing, step) {
  if (!pricing || typeof pricing !== 'object') return null;
  if (
    step?.isImageGenStep &&
    typeof pricing.imageOutput === 'number' &&
    Number.isFinite(pricing.imageOutput) &&
    pricing.imageOutput > 0
  ) {
    return pricing.imageOutput;
  }
  return pricing.output;
}

export function computeStepCost(step, pricing) {
  if (!pricing) return null;
  const stepMs = extractStepTimestampMs(step);
  const effectivePricing =
    stepMs > 0 && Array.isArray(pricing.phases) && pricing.phases.length > 0
      ? resolvePricingAt(pricing, stepMs)
      : pricing;
  const safeTok = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const outRate = resolveEffectiveOutputRate(effectivePricing, step);
  const inCost = (safeTok(step?.inputTokens) / 1_000_000) * effectivePricing.input;
  const cacheCost = (safeTok(step?.cacheReadTokens) / 1_000_000) * effectivePricing.cache;
  const outCost = (safeTok(step?.outputTokens) / 1_000_000) * outRate;
  return inCost + cacheCost + outCost;
}
