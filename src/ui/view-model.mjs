/*
 * Copyright (C) 2026 haoyuqi and contributors
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
 * Pure view-model helpers mapping `/api/telemetry` payloads onto dashboard UI models.
 */

export const CONTEXT_CHANNELS = Object.freeze([
  Object.freeze({ key: 'userInputTokens', label: 'User Input' }),
  Object.freeze({ key: 'assistantTokens', label: 'Assistant' }),
  Object.freeze({ key: 'toolResultsTokens', label: 'Tool Results' }),
  Object.freeze({ key: 'subagentTokens', label: 'Subagents' }),
  Object.freeze({ key: 'checkpointTokens', label: 'Checkpoints' }),
  Object.freeze({ key: 'systemToolsTokens', label: 'System Tools' }),
  Object.freeze({ key: 'mcpToolsTokens', label: 'MCP Tools' }),
  Object.freeze({ key: 'skillsTokens', label: 'Skills' }),
  Object.freeze({ key: 'systemPromptTokens', label: 'System Prompt' }),
  Object.freeze({ key: 'userRulesTokens', label: 'User Rules' }),
]);

/**
 * Extracts the 10-channel context breakdown from the flat `context` object.
 *
 * @param {object|null|undefined} ctx
 * @returns {{ channels: { key: string, label: string, tokens: number }[], totalChannelTokens: number, cachedTokens: number, freshInputTokens: number }}
 */
export function extractContextChannels(ctx) {
  const safe = ctx && typeof ctx === 'object' ? ctx : {};
  const channels = CONTEXT_CHANNELS.map(({ key, label }) => ({
    key,
    label,
    tokens: Math.max(0, Number(safe[key] || 0) || 0),
  }));
  const totalChannelTokens = channels.reduce((sum, ch) => sum + ch.tokens, 0);
  return {
    channels,
    totalChannelTokens,
    cachedTokens: Math.max(0, Number(safe.cachedTokens || 0) || 0),
    freshInputTokens: Math.max(0, Number(safe.freshInputTokens || 0) || 0),
  };
}

/**
 * Normalizes a quota pool entry from `quotas.pools` using exact backend field names.
 *
 * @param {object} pool
 * @param {string} [activePoolKey='']
 */
export function normalizeQuotaPoolView(pool, activePoolKey = '') {
  const p = pool && typeof pool === 'object' ? pool : {};
  const has5hVal = Number.isFinite(Number(p.remainingPct)) && p.remainingPct !== null;
  const hasWkVal =
    Number.isFinite(Number(p.weeklyRemainingPct)) && p.weeklyRemainingPct !== null;
  const has5h = Boolean(p.has5h !== undefined ? p.has5h && has5hVal : has5hVal);
  const hasWeekly = Boolean(p.hasWeekly !== undefined ? p.hasWeekly && hasWkVal : hasWkVal);

  const fiveHourPct = has5h ? Math.max(0, Math.min(100, Number(p.remainingPct))) : null;
  const weeklyPct = hasWeekly ? Math.max(0, Math.min(100, Number(p.weeklyRemainingPct))) : null;

  const primaryPct = fiveHourPct !== null ? fiveHourPct : weeklyPct !== null ? weeklyPct : 0;
  const primaryWindow = fiveHourPct !== null ? '5h' : weeklyPct !== null ? 'weekly' : 'none';

  return {
    poolKey: String(p.poolKey || ''),
    poolName: String(p.poolName || p.poolLabel || p.poolKey || 'Unknown Pool'),
    isActive: Boolean(p.isActive || (activePoolKey && p.poolKey === activePoolKey)),
    has5h,
    fiveHourPct,
    resetTime: p.resetTime || '',
    hasWeekly,
    weeklyPct,
    weeklyResetTime: p.weeklyResetTime || '',
    primaryPct,
    primaryWindow,
  };
}

/**
 * Normalizes `quotas.weekly` summary (official weekly window or custom local weekly budget).
 *
 * @param {object|null|undefined} weekly
 */
export function normalizeWeeklyQuotaView(weekly) {
  if (!weekly || typeof weekly !== 'object') return null;
  const hasRemaining =
    weekly.remainingPct !== null &&
    weekly.remainingPct !== undefined &&
    Number.isFinite(Number(weekly.remainingPct));
  const remainingPct = hasRemaining
    ? Math.max(0, Math.min(100, Number(weekly.remainingPct)))
    : null;
  const usedPct =
    weekly.usedPct !== null &&
    weekly.usedPct !== undefined &&
    Number.isFinite(Number(weekly.usedPct))
      ? Math.max(0, Math.min(100, Number(weekly.usedPct)))
      : null;
  return {
    title: String(weekly.title || 'Weekly Limit'),
    isOfficial: Boolean(weekly.isOfficial),
    remainingPct,
    usedPct,
    calls: Number(weekly.calls || 0) || 0,
    tokens: Number(weekly.tokens || 0) || 0,
    costUsd: Number(weekly.costUsd || 0) || 0,
    resetTime: weekly.resetTime || '',
  };
}

/**
 * Returns normalized agent views from `activeConversation.agents`.
 *
 * @param {object|null|undefined} activeConversation
 * @returns {object[]}
 */
export function getAgentViews(activeConversation) {
  const agents = activeConversation?.agents;
  return Array.isArray(agents) ? agents : [];
}

function getAgentSteps(activeConversation, agent) {
  if (Array.isArray(agent?.recentSteps)) {
    return agent.recentSteps;
  }
  if (agent?.isMain || agent?.agentId === 'main') {
    return Array.isArray(activeConversation?.recentSteps) ? activeConversation.recentSteps : [];
  }
  return [];
}

function normalizeStepAgentFields(st, agent) {
  return {
    ...st,
    agentId: st.agentId || agent?.agentId || 'main',
    agentBadge: st.agentBadge || agent?.badgeText || 'M',
    agentLabel: st.agentLabel || agent?.shortLabel || agent?.role || 'Main Agent',
  };
}

/**
 * Collects newest-first steps across one or all agents, reading main-agent steps from
 * `activeConversation.recentSteps` when `agents[0]` omits `recentSteps`.
 *
 * @param {object|null|undefined} activeConversation
 * @param {string} [filterAgentId='all']
 * @param {number} [maxItems=200]
 * @returns {object[]}
 */
export function collectOrderedAgentSteps(
  activeConversation,
  filterAgentId = 'all',
  maxItems = 200
) {
  const ac = activeConversation && typeof activeConversation === 'object' ? activeConversation : {};
  const agents = getAgentViews(ac);
  const limit = Math.max(1, Number(maxItems) || 200);

  if (filterAgentId && filterAgentId !== 'all') {
    const target = agents.find((a) => a.agentId === filterAgentId) || null;
    const rawList = target
      ? getAgentSteps(ac, target)
      : filterAgentId === 'main' && Array.isArray(ac.recentSteps)
        ? ac.recentSteps
        : [];
    const fallbackAgent = target || { agentId: 'main', badgeText: 'M', shortLabel: 'Main Agent' };
    return rawList.slice(0, limit).map((st) => normalizeStepAgentFields(st, fallbackAgent));
  }

  if (agents.length === 0) {
    const fallback = Array.isArray(ac.recentSteps) ? ac.recentSteps : [];
    return fallback.slice(0, limit);
  }

  const combined = [];
  let includedMain = false;
  for (const agent of agents) {
    if (agent?.isMain || agent?.agentId === 'main') {
      includedMain = true;
    }
    const steps = getAgentSteps(ac, agent);
    for (const st of steps) {
      combined.push(normalizeStepAgentFields(st, agent));
    }
  }
  if (!includedMain && Array.isArray(ac.recentSteps) && ac.recentSteps.length > 0) {
    for (const st of ac.recentSteps) {
      combined.push(
        normalizeStepAgentFields(st, { agentId: 'main', badgeText: 'M', shortLabel: 'Main Agent' })
      );
    }
  }
  combined.sort(
    (a, b) =>
      (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0) ||
      (Number(b.stepIndex) || 0) - (Number(a.stepIndex) || 0)
  );
  return combined.slice(0, limit);
}

/**
 * Extracts summary usage metrics from `consumption.account`.
 *
 * @param {object|null|undefined} consumption
 */
export function extractUsageSummaryView(consumption) {
  const acct = consumption?.account && typeof consumption.account === 'object'
    ? consumption.account
    : {};
  const inputTokens = Number(acct.inputTokens || 0) || 0;
  const cacheReadTokens = Number(acct.cacheReadTokens || 0) || 0;
  const outputTokens = Number(acct.outputTokens || 0) || 0;
  const thinkingTokens = Number(acct.thinkingTokens || 0) || 0;
  const responseTokens =
    acct.responseTokens !== undefined && acct.responseTokens !== null
      ? Number(acct.responseTokens) || 0
      : Math.max(0, outputTokens - thinkingTokens);
  return {
    totalTokens: Number(acct.totalTokens || 0) || 0,
    calls: Number(acct.calls ?? acct.stepCount ?? 0) || 0,
    conversationsCount: Number(acct.conversationsCount ?? acct.conversationCount ?? 0) || 0,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    costUsd: Number(acct.costUsd ?? acct.totalCostUsd ?? 0) || 0,
    cacheHitPct: Number(acct.cacheHitPct || 0) || 0,
  };
}

/**
 * Extracts trend chart bars from `consumption.trendSeries`.
 *
 * @param {object|null|undefined} consumption
 */
export function extractTrendBars(consumption) {
  const series = Array.isArray(consumption?.trendSeries) ? consumption.trendSeries : [];
  return series.map((b) => ({
    label: b.label || '',
    fullLabel: b.fullLabel || b.label || '',
    tokens: Number(b.tokens ?? b.totalTokens ?? 0) || 0,
    costUsd: Number(b.costUsd ?? b.totalCostUsd ?? 0) || 0,
  }));
}

/**
 * Extracts model breakdown rows from `payload.modelBreakdown`.
 *
 * @param {object|null|undefined} payload
 */
export function extractModelBreakdownRows(payload) {
  const models = Array.isArray(payload?.modelBreakdown) ? payload.modelBreakdown : [];
  return models.map((m) => ({
    label: m.label || m.shortName || m.upstreamName || m.modelKey || 'Unknown',
    calls: Number(m.calls ?? m.stepCount ?? 0) || 0,
    totalTokens: Number(m.totalTokens || 0) || 0,
    costUsd: Number(m.costUsd ?? m.totalCostUsd ?? 0) || 0,
  }));
}

/**
 * Extracts workspace ranking rows from `consumption.topWorkspaces`.
 *
 * @param {object|null|undefined} consumption
 */
export function extractWorkspaceRows(consumption) {
  const workspaces = Array.isArray(consumption?.topWorkspaces) ? consumption.topWorkspaces : [];
  return workspaces.map((w) => ({
    label: w.label || w.workspacePath || 'Unknown',
    sessionCount: Number(w.sessionCount ?? w.conversationCount ?? 0) || 0,
    totalTokens: Number(w.totalTokens || 0) || 0,
    costUsd: Number(w.costUsd ?? w.totalCostUsd ?? 0) || 0,
  }));
}

const AUTH_RELOAD_PREFIX = 'ag_mon_auth_reload:';

/**
 * Decides whether a 401 response after a rolling server restart should trigger a one-shot
 * page reload (to fetch the new per-process token from `GET /`), with cooldown and unsaved-draft guards.
 *
 * @param {string} windowName
 * @param {number} [nowMs=Date.now()]
 * @param {number} [cooldownMs=10000]
 * @param {boolean} [hasUnsavedDraft=false]
 * @returns {{ shouldReload: boolean, reason: 'ok' | 'cooldown' | 'unsaved-draft', nextWindowName: string }}
 */
export function shouldAutoReloadOn401(
  windowName,
  nowMs = Date.now(),
  cooldownMs = 10000,
  hasUnsavedDraft = false
) {
  const raw = String(windowName || '');
  if (hasUnsavedDraft) {
    return { shouldReload: false, reason: 'unsaved-draft', nextWindowName: raw };
  }
  const prevMs = raw.startsWith(AUTH_RELOAD_PREFIX)
    ? Number(raw.slice(AUTH_RELOAD_PREFIX.length))
    : 0;
  if (Number.isFinite(prevMs) && prevMs > 0 && nowMs - prevMs <= cooldownMs) {
    return { shouldReload: false, reason: 'cooldown', nextWindowName: raw };
  }
  return {
    shouldReload: true,
    reason: 'ok',
    nextWindowName: `${AUTH_RELOAD_PREFIX}${nowMs}`,
  };
}
