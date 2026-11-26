import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectOrderedAgentSteps,
  extractContextChannels,
  extractModelBreakdownRows,
  extractTrendBars,
  extractUsageSummaryView,
  extractWorkspaceRows,
  getAgentViews,
  normalizeQuotaPoolView,
  normalizeWeeklyQuotaView,
  shouldAutoReloadOn401,
} from '../src/ui/view-model.mjs';

describe('UI telemetry view-model', () => {
  it('normalizes 5h+weekly and weekly-only quota pools using backend fields', () => {
    const dualPool = normalizeQuotaPoolView(
      {
        poolKey: 'Gemini',
        poolName: 'Gemini Model Pool',
        has5h: true,
        remainingPct: 64.2,
        resetTime: '2099-01-01T05:00:00Z',
        hasWeekly: true,
        weeklyRemainingPct: 88.5,
        weeklyResetTime: '2099-01-07T00:00:00Z',
      },
      'Gemini'
    );
    assert.equal(dualPool.isActive, true);
    assert.equal(dualPool.has5h, true);
    assert.equal(dualPool.fiveHourPct, 64.2);
    assert.equal(dualPool.hasWeekly, true);
    assert.equal(dualPool.weeklyPct, 88.5);
    assert.equal(dualPool.primaryWindow, '5h');
    assert.equal(dualPool.primaryPct, 64.2);

    const weeklyOnlyPool = normalizeQuotaPoolView(
      {
        poolKey: 'Claude & GPT',
        poolName: 'Claude & GPT Model Pool',
        has5h: false,
        remainingPct: null,
        resetTime: null,
        hasWeekly: true,
        weeklyRemainingPct: 82.5,
        weeklyResetTime: '2099-01-07T00:00:00Z',
      },
      'Gemini'
    );
    assert.equal(weeklyOnlyPool.isActive, false);
    assert.equal(weeklyOnlyPool.has5h, false);
    assert.equal(weeklyOnlyPool.fiveHourPct, null);
    assert.equal(weeklyOnlyPool.hasWeekly, true);
    assert.equal(weeklyOnlyPool.weeklyPct, 82.5);
    assert.equal(weeklyOnlyPool.primaryWindow, 'weekly');
    assert.equal(weeklyOnlyPool.primaryPct, 82.5);

    const customWeekly = normalizeWeeklyQuotaView({
      isOfficial: false,
      title: 'Weekly Limit (Custom Local)',
      calls: 12,
      tokens: 45000,
      costUsd: 0.75,
      usedPct: 25,
      remainingPct: 75,
      resetTime: '2099-01-07T00:00:00Z',
    });
    assert.equal(customWeekly.isOfficial, false);
    assert.equal(customWeekly.title, 'Weekly Limit (Custom Local)');
    assert.equal(customWeekly.remainingPct, 75);
    assert.equal(customWeekly.calls, 12);
    assert.equal(customWeekly.tokens, 45000);
    assert.equal(customWeekly.costUsd, 0.75);
  });

  it('extracts all 10 flat context channels from telemetry-builder context object', () => {
    const res = extractContextChannels({
      totalTokens: 1500,
      userInputTokens: 100,
      assistantTokens: 200,
      toolResultsTokens: 300,
      subagentTokens: 50,
      checkpointTokens: 25,
      systemToolsTokens: 125,
      mcpToolsTokens: 75,
      skillsTokens: 40,
      systemPromptTokens: 400,
      userRulesTokens: 185,
      cachedTokens: 900,
      freshInputTokens: 600,
    });
    assert.equal(res.channels.length, 10);
    assert.equal(res.totalChannelTokens, 1500);
    assert.equal(res.channels[0].key, 'userInputTokens');
    assert.equal(res.channels[0].tokens, 100);
    assert.equal(res.channels[9].key, 'userRulesTokens');
    assert.equal(res.channels[9].tokens, 185);
    assert.equal(res.cachedTokens, 900);
    assert.equal(res.freshInputTokens, 600);
  });

  it('collects newest-first steps from activeConversation.recentSteps and subagent agents[]', () => {
    const mainSteps = [];
    for (let i = 220; i >= 1; i--) {
      mainSteps.push({
        stepIndex: i,
        createdAtMs: 1000 + i * 10,
        agentId: 'main',
        agentBadge: 'M',
        modelShort: '2.5 Pro',
      });
    }
    const subSteps = [
      {
        stepIndex: 5,
        createdAtMs: 1000 + 221 * 10,
        agentId: 'subagent-1',
        agentBadge: 'S1',
        modelShort: '2.5 Flash',
      },
      {
        stepIndex: 4,
        createdAtMs: 1000 + 205 * 10,
        agentId: 'subagent-1',
        agentBadge: 'S1',
        modelShort: '2.5 Flash',
      },
    ];

    // Single-agent backend shape: agents[0] omits recentSteps, main steps live on activeConversation.recentSteps
    const singleAgentConv = {
      recentSteps: mainSteps,
      agents: [{ agentId: 'main', isMain: true, shortLabel: 'Main Agent', badgeText: 'M' }],
    };
    const singleAll = collectOrderedAgentSteps(singleAgentConv, 'all', 200);
    const singleMain = collectOrderedAgentSteps(singleAgentConv, 'main', 200);
    assert.equal(singleAll.length, 200);
    assert.equal(singleAll[0].stepIndex, 220);
    assert.equal(singleMain.length, 200);
    assert.equal(singleMain[0].stepIndex, 220);

    // Multi-agent backend shape: main steps on activeConversation.recentSteps, subagent steps on agents[1].recentSteps
    const activeConversation = {
      recentSteps: mainSteps,
      agents: [
        { agentId: 'main', isMain: true, shortLabel: 'Main Agent', badgeText: 'M' },
        { agentId: 'subagent-1', isMain: false, shortLabel: 'Subagent #1', badgeText: 'S1', recentSteps: subSteps },
      ],
    };

    assert.equal(getAgentViews(activeConversation).length, 2);

    const allTop = collectOrderedAgentSteps(activeConversation, 'all', 200);
    assert.equal(allTop.length, 200);
    assert.equal(allTop[0].agentId, 'subagent-1');
    assert.equal(allTop[0].stepIndex, 5);
    assert.equal(allTop[1].agentId, 'main');
    assert.equal(allTop[1].stepIndex, 220);

    const mainOnly = collectOrderedAgentSteps(activeConversation, 'main', 200);
    assert.equal(mainOnly.length, 200);
    assert.equal(mainOnly[0].stepIndex, 220);

    const subOnly = collectOrderedAgentSteps(activeConversation, 'subagent-1', 200);
    assert.equal(subOnly.length, 2);
    assert.equal(subOnly[0].stepIndex, 5);
  });

  it('maps usage summary, trend series, model breakdown, and top workspaces from backend fields', () => {
    const consumption = {
      account: {
        calls: 42,
        conversationsCount: 6,
        inputTokens: 1200,
        cacheReadTokens: 8800,
        outputTokens: 2000,
        thinkingTokens: 500,
        totalTokens: 12000,
        costUsd: 1.45,
        cacheHitPct: 88.0,
      },
      trendSeries: [
        { label: '10:00', fullLabel: 'Nov 26 10:00 - 11:00', tokens: 7000, costUsd: 0.9 },
      ],
      topWorkspaces: [
        { label: 'magpie-antigravity-monitor', sessionCount: 4, totalTokens: 9000, costUsd: 1.1 },
      ],
    };
    const payload = {
      modelBreakdown: [
        { label: 'Gemini 2.5 Pro', calls: 30, totalTokens: 10000, costUsd: 1.2 },
      ],
      consumption,
    };

    const summary = extractUsageSummaryView(consumption);
    assert.equal(summary.calls, 42);
    assert.equal(summary.conversationsCount, 6);
    assert.equal(summary.costUsd, 1.45);
    assert.equal(summary.totalTokens, 12000);
    assert.equal(summary.outputTokens, 2000);
    assert.equal(summary.thinkingTokens, 500);
    assert.equal(summary.responseTokens, 1500);

    const bars = extractTrendBars(consumption);
    assert.deepEqual(bars, [
      { label: '10:00', fullLabel: 'Nov 26 10:00 - 11:00', tokens: 7000, costUsd: 0.9 },
    ]);

    const models = extractModelBreakdownRows(payload);
    assert.deepEqual(models, [
      { label: 'Gemini 2.5 Pro', calls: 30, totalTokens: 10000, costUsd: 1.2 },
    ]);

    const workspaces = extractWorkspaceRows(consumption);
    assert.deepEqual(workspaces, [
      { label: 'magpie-antigravity-monitor', sessionCount: 4, totalTokens: 9000, costUsd: 1.1 },
    ]);
  });

  it('guards 401 auto-reload with a cooldown to recover once without reload loops', () => {
    const first = shouldAutoReloadOn401('', 100000, 10000);
    assert.equal(first.shouldReload, true);

    const withinCooldown = shouldAutoReloadOn401(first.nextWindowName, 105000, 10000);
    assert.equal(withinCooldown.shouldReload, false);

    const afterCooldown = shouldAutoReloadOn401(first.nextWindowName, 115000, 10000);
    assert.equal(afterCooldown.shouldReload, true);
  });
});
