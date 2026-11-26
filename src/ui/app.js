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
} from './view-model.mjs';

(() => {
  const CHANNEL_COLORS = [
    '#3b82f6',
    '#06b6d4',
    '#8b5cf6',
    '#10b981',
    '#f59e0b',
    '#ec4899',
    '#6366f1',
    '#14b8a6',
    '#f97316',
    '#64748b',
  ];

  const RANGE_OPTIONS = [
    { key: '5h', label: '5h' },
    { key: 'today', label: 'Today' },
    { key: '24h', label: '24h' },
    { key: 'week', label: 'This Week' },
    { key: '7d', label: '7d' },
    { key: '14d', label: '14d' },
    { key: '30d', label: '30d' },
    { key: 'all', label: 'All Time' },
  ];

  const state = {
    activeTab: 'overview',
    selectedConvId: '',
    selectedAgentId: 'main',
    stepFilterAgent: 'all',
    selectedRange: 'all',
    payload: null,
    loading: false,
    error: '',
    statusMessage: '',
    pollTimer: null,
    inFlight: null,
    requestSeq: 0,
    activeRequestKey: '',
    abortController: null,
    settingsDirty: false,
    settingsEditVersion: 0,
    settingsRendered: false,
    authExpired: false,
  };

  function h(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'className') {
        node.className = String(v);
      } else if (k === 'textContent') {
        node.textContent = String(v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value') {
        node.value = String(v);
      } else if (k === 'selected' || k === 'disabled' || k === 'checked') {
        node[k] = Boolean(v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? document.createTextNode(String(child))
          : child
      );
    }
    return node;
  }

  function fmtInt(val) {
    const n = Number(val);
    return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '--';
  }

  function fmtTokens(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return '--';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function fmtUsd(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return '--';
    return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  }

  function fmtPct(val) {
    const n = Number(val);
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : '--';
  }

  function fmtSpeed(val) {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? `${n.toFixed(1)} tok/s` : '--';
  }

  function fmtSec(val) {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? `${n.toFixed(2)}s` : '--';
  }

  function fmtRemainingTime(iso) {
    if (!iso) return '--';
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '--';
    if (ms <= 0) return 'Resetting';
    const mins = Math.floor(ms / 60000);
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    if (hrs >= 24) {
      const days = Math.floor(hrs / 24);
      return `${days}d ${hrs % 24}h`;
    }
    return hrs > 0 ? `${hrs}h ${remM}m` : `${remM}m`;
  }

  async function apiFetch(path, init = {}) {
    const res = await window.sidecar.fetch(path, init);
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: text || `HTTP ${res.status}` };
    }
    if (!res.ok) {
      const err = new Error(json.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function handleUnauthorized() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    const hasUnsavedDraft = state.settingsDirty || isFocusInsideSettingsForm();
    const check = shouldAutoReloadOn401(window.name, Date.now(), 10000, hasUnsavedDraft);
    if (check.shouldReload) {
      window.name = check.nextWindowName;
      window.location.reload();
      return true;
    }
    state.authExpired = true;
    state.error =
      check.reason === 'unsaved-draft'
        ? 'Monitor service restarted with a new session token. Save or copy your unsaved Settings draft, then reload.'
        : 'Monitor service restarted with a new session token. Reload to reconnect.';
    renderBanner();
    return false;
  }

  function applySettingsAppearance(settings) {
    if (!settings || typeof settings !== 'object') return;
    const accent = String(settings.themeAccent || '').trim();
    if (accent) {
      document.documentElement.dataset.accent = accent;
    } else {
      delete document.documentElement.dataset.accent;
    }
    const scaleMap = { sm: '0.92', md: '1', lg: '1.08', xl: '1.16' };
    const scale = scaleMap[settings.fontScale] || '1';
    document.documentElement.style.setProperty('--scale', scale);
  }

  async function fetchTelemetry({ force = false, userTriggered = false } = {}) {
    const queryKey = `${state.selectedConvId || ''}::${state.selectedRange || 'all'}`;
    if (state.inFlight && !force && !userTriggered && state.activeRequestKey === queryKey) {
      return state.inFlight;
    }

    if (state.abortController) {
      try {
        state.abortController.abort();
      } catch {
        // Ignore abort errors
      }
    }

    const reqId = ++state.requestSeq;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.abortController = controller;
    state.activeRequestKey = queryKey;
    state.loading = true;
    renderHeader();

    const params = new URLSearchParams();
    if (state.selectedConvId) params.set('conversationId', state.selectedConvId);
    if (state.selectedRange) params.set('range', state.selectedRange);
    if (force) params.set('force', '1');

    const req = apiFetch(
      `./api/telemetry?${params.toString()}`,
      controller ? { signal: controller.signal } : {}
    )
      .then((payload) => {
        if (reqId !== state.requestSeq) return;
        state.authExpired = false;
        state.payload = payload;
        state.error = '';
        if (!state.selectedConvId && payload?.activeConversation?.cascadeId) {
          state.selectedConvId = payload.activeConversation.cascadeId;
        }
        applySettingsAppearance(payload?.settings);
        renderAll({ preserveSettingsForm: true });
      })
      .catch((err) => {
        if (reqId !== state.requestSeq || err?.name === 'AbortError') return;
        if (err?.status === 401) {
          handleUnauthorized();
          return;
        }
        state.error = err?.message || 'Failed to load telemetry';
        renderBanner();
      })
      .finally(() => {
        if (reqId !== state.requestSeq) return;
        state.loading = false;
        state.inFlight = null;
        state.abortController = null;
        renderHeader();
        schedulePoll();
      });

    state.inFlight = req;
    return req;
  }

  function schedulePoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (document.hidden || state.authExpired) return;
    const isRunning = Boolean(
      state.payload?.activeConversation?.isRunning ||
        (state.payload?.runningConversations || []).length > 0
    );
    const intervalMs = isRunning ? 5000 : 15000;
    state.pollTimer = setTimeout(() => {
      fetchTelemetry();
    }, intervalMs);
  }

  function renderHeader() {
    const accountPill = document.getElementById('account-pill');
    const lsPill = document.getElementById('ls-pill');
    const convSelect = document.getElementById('conv-select');
    const refreshBtn = document.getElementById('refresh-btn');

    const acct = state.payload?.account;
    if (acct?.email) {
      accountPill.textContent = `${acct.email}${acct.planName ? ` (${acct.planName})` : ''}`;
      accountPill.className = 'pill pill-ok';
    } else if (acct?.status === 'signedOut') {
      accountPill.textContent = 'Signed out';
      accountPill.className = 'pill pill-warn';
    } else {
      accountPill.textContent = state.payload ? 'Offline / Local' : 'Connecting...';
      accountPill.className = 'pill pill-muted';
    }

    const qMeta = state.payload?.quotas?.meta;
    if (qMeta?.hasOfficialData && !qMeta?.refreshFailed) {
      lsPill.textContent = qMeta.isStale ? 'Live LS (Cached)' : 'Live LS';
      lsPill.className = qMeta.isStale ? 'pill pill-warn' : 'pill pill-ok';
    } else {
      lsPill.textContent = 'Local SQLite Scan';
      lsPill.className = 'pill pill-muted';
    }

    const convs = state.payload?.conversations || [];
    convSelect.replaceChildren();
    if (convs.length === 0) {
      convSelect.appendChild(h('option', { value: '', textContent: 'No conversations found' }));
    } else {
      for (const c of convs) {
        const label = `${c.isRunning ? '[Running] ' : ''}${c.title || c.cascadeId.slice(0, 8)} (${c.totalStepCount || c.stepCount || 0} steps)`;
        convSelect.appendChild(
          h('option', {
            value: c.cascadeId,
            textContent: label,
            selected: c.cascadeId === state.selectedConvId,
          })
        );
      }
    }

    refreshBtn.disabled = state.loading;
    refreshBtn.textContent = state.loading ? 'Refreshing...' : 'Refresh';
  }

  function renderBanner() {
    const root = document.getElementById('banner-area');
    root.replaceChildren();
    if (state.error) {
      const banner = h('div', { className: 'banner banner-error' }, [
        h('span', { textContent: state.error }),
      ]);
      if (state.authExpired) {
        banner.appendChild(
          h('button', {
            type: 'button',
            className: 'btn btn-sm',
            style: 'margin-left:10px;',
            textContent: 'Reload Page',
            onClick: () => window.location.reload(),
          })
        );
      }
      root.appendChild(banner);
    } else if (state.statusMessage) {
      root.appendChild(h('div', { className: 'banner', textContent: state.statusMessage }));
    }
  }

  function getSelectedContextView() {
    const ac = state.payload?.activeConversation;
    if (!ac) return null;
    if (state.selectedAgentId === 'all' && ac.aggregated) {
      return ac.aggregated;
    }
    const views = getAgentViews(ac);
    return views.find((v) => v.agentId === state.selectedAgentId) || views[0] || ac;
  }

  function renderOverviewTab() {
    const root = document.getElementById('tab-overview');
    root.replaceChildren();
    const ac = state.payload?.activeConversation;
    const hasActiveConv = Boolean(ac && ac.cascadeId);

    if (hasActiveConv) {
      const view = getSelectedContextView() || ac;
      const ctx = view.context || ac.context || {};
      const limitTok = Number(ctx.compactionLimitTokens || ctx.limitTokens || 0);
      const totalTok = Number(ctx.totalTokens || 0);
      const fillPct = limitTok > 0 ? Math.min(100, (totalTok / limitTok) * 100) : null;

      root.appendChild(
        h('div', { className: 'grid-kpi' }, [
          kpiCard('Output Speed', fmtSpeed(view.latestTokPerSec), `Avg: ${fmtSpeed(view.avgTokPerSec)}`),
          kpiCard('TTFT', fmtSec(view.latestTtftSec), `Last known: ${fmtSec(view.lastKnownTtftSec)}`),
          kpiCard('Cache Hit Rate', fmtPct(view.latestCacheHitPct), `${fmtInt(view.stepCount)} steps`),
          kpiCard(
            'Session Cost',
            fmtUsd(view.sessionCostUsd),
            `Latest step: ${fmtUsd(view.latestStepCostUsd)}`
          ),
          kpiCard(
            'Context Fill',
            fillPct !== null ? fmtPct(fillPct) : fmtTokens(totalTok),
            limitTok > 0 ? `${fmtTokens(totalTok)} / ${fmtTokens(limitTok)}` : fmtTokens(totalTok)
          ),
        ])
      );
    } else {
      root.appendChild(
        h('div', {
          className: 'card empty-state',
          textContent: 'No Antigravity conversations detected yet.',
        })
      );
    }

    // Quota pools & weekly summary card (rendered even when no conversation is active)
    const pools = state.payload?.quotas?.pools || [];
    const weekly = normalizeWeeklyQuotaView(state.payload?.quotas?.weekly);
    const quotaCard = h('div', { className: 'card' });
    quotaCard.appendChild(
      h('div', { className: 'card-header' }, [
        h('h2', { className: 'card-title', textContent: 'Quota & Weekly Budget' }),
        h('span', {
          className: 'muted',
          textContent: state.payload?.quotas?.meta?.errorMessage || '5h & Weekly Windows',
        }),
      ])
    );

    if (weekly) {
      const wkPct = weekly.remainingPct;
      const wkFillCls =
        wkPct !== null && wkPct <= 15
          ? 'progress-fill is-danger'
          : wkPct !== null && wkPct <= 35
            ? 'progress-fill is-warn'
            : 'progress-fill';
      quotaCard.appendChild(
        h('div', { className: 'quota-item', style: 'margin-bottom:10px;' }, [
          h('div', { className: 'quota-row' }, [
            h('strong', { textContent: weekly.title }),
            h('span', {
              className: weekly.isOfficial ? 'pill pill-ok' : 'pill pill-accent',
              textContent:
                wkPct !== null
                  ? `${wkPct.toFixed(1)}% left`
                  : weekly.isOfficial
                    ? 'Official'
                    : 'Local',
            }),
          ]),
          ...(wkPct !== null
            ? [
                h('div', { className: 'progress-track' }, [
                  h('div', { className: wkFillCls, style: `width:${wkPct}%` }),
                ]),
              ]
            : []),
          h('div', { className: 'quota-row', style: 'margin-top:6px;margin-bottom:0;' }, [
            h('span', {
              className: 'muted',
              textContent: `${fmtTokens(weekly.tokens)} tokens · ${fmtInt(weekly.calls)} calls · ${fmtUsd(weekly.costUsd)}`,
            }),
            h('span', {
              className: 'muted',
              textContent: weekly.resetTime ? `Reset ${fmtRemainingTime(weekly.resetTime)}` : '',
            }),
          ]),
        ])
      );
    }

    if (pools.length === 0) {
      quotaCard.appendChild(
        h('div', {
          className: 'empty-state',
          textContent:
            'Official Language Server quota unavailable (running in offline SQLite scan mode).',
        })
      );
    } else {
      const activePoolKey = state.payload?.quotas?.activePool?.poolKey || '';
      const list = h('div', { className: 'quota-list' });
      for (const rawPool of pools) {
        const pool = normalizeQuotaPoolView(rawPool, activePoolKey);
        const pct = pool.primaryPct;
        const fillCls =
          pct <= 15 ? 'progress-fill is-danger' : pct <= 35 ? 'progress-fill is-warn' : 'progress-fill';
        const leftText = pool.has5h
          ? `5h: ${fmtPct(pool.fiveHourPct)} · Reset ${fmtRemainingTime(pool.resetTime)}`
          : pool.hasWeekly
            ? `Weekly: ${fmtPct(pool.weeklyPct)} · Reset ${fmtRemainingTime(pool.weeklyResetTime)}`
            : 'Unavailable';
        const rightText =
          pool.has5h && pool.hasWeekly
            ? `Weekly: ${fmtPct(pool.weeklyPct)} · Reset ${fmtRemainingTime(pool.weeklyResetTime)}`
            : '';
        list.appendChild(
          h('div', { className: 'quota-item' }, [
            h('div', { className: 'quota-row' }, [
              h('strong', { textContent: pool.poolName }),
              h('span', {
                className: pool.isActive ? 'pill pill-accent' : 'pill pill-muted',
                textContent: pool.isActive ? 'Active' : `${pct.toFixed(0)}% left`,
              }),
            ]),
            h('div', { className: 'progress-track' }, [
              h('div', { className: fillCls, style: `width:${pct}%` }),
            ]),
            h('div', { className: 'quota-row', style: 'margin-top:6px;margin-bottom:0;' }, [
              h('span', { className: 'muted', textContent: leftText }),
              h('span', { className: 'muted', textContent: rightText }),
            ]),
          ])
        );
      }
      quotaCard.appendChild(list);
    }
    root.appendChild(quotaCard);

    if (!hasActiveConv) {
      return;
    }

    const view = getSelectedContextView() || ac;
    const ctx = view.context || ac.context || {};

    // 10-channel context breakdown
    const ctxCard = h('div', { className: 'card' });
    const views = getAgentViews(ac);
    const switcher = h('div', { className: 'toolbar' });
    for (const v of views) {
      switcher.appendChild(
        h('button', {
          type: 'button',
          className: `btn btn-sm${state.selectedAgentId === v.agentId ? ' is-active' : ''}`,
          textContent: v.shortLabel || v.role || v.agentId,
          onClick: () => {
            state.selectedAgentId = v.agentId;
            renderOverviewTab();
          },
        })
      );
    }
    if (ac.aggregated && views.length > 1) {
      switcher.appendChild(
        h('button', {
          type: 'button',
          className: `btn btn-sm${state.selectedAgentId === 'all' ? ' is-active' : ''}`,
          textContent: 'All Combined',
          onClick: () => {
            state.selectedAgentId = 'all';
            renderOverviewTab();
          },
        })
      );
    }
    ctxCard.appendChild(
      h('div', { className: 'card-header' }, [
        h('h2', {
          className: 'card-title',
          textContent: `10-Channel Context Breakdown (${view.activeModelShort || ac.activeModelShort || 'Unknown'})`,
        }),
        switcher,
      ])
    );

    const { channels, totalChannelTokens } = extractContextChannels(ctx);
    if (totalChannelTokens <= 0) {
      ctxCard.appendChild(
        h('div', { className: 'empty-state', textContent: 'No context breakdown data for this view.' })
      );
    } else {
      const bar = h('div', { className: 'stacked-bar' });
      const legend = h('div', { className: 'channel-grid' });
      channels.forEach((ch, idx) => {
        const tok = ch.tokens;
        const pct = totalChannelTokens > 0 ? (tok / totalChannelTokens) * 100 : 0;
        const color = CHANNEL_COLORS[idx % CHANNEL_COLORS.length];
        if (tok > 0) {
          bar.appendChild(
            h('div', {
              className: 'stacked-seg',
              style: `width:${pct.toFixed(2)}%;background:${color}`,
              title: `${ch.label}: ${fmtTokens(tok)} (${pct.toFixed(1)}%)`,
            })
          );
        }
        legend.appendChild(
          h('div', { className: 'channel-row' }, [
            h('span', {}, [
              h('span', { className: 'swatch', style: `background:${color}` }),
              ch.label,
            ]),
            h('span', { className: 'mono muted', textContent: `${fmtTokens(tok)} (${pct.toFixed(1)}%)` }),
          ])
        );
      });
      ctxCard.appendChild(bar);
      ctxCard.appendChild(legend);
    }
    root.appendChild(ctxCard);
  }

  function kpiCard(label, value, sub) {
    return h('div', { className: 'card', style: 'margin-bottom:0;' }, [
      h('div', { className: 'kpi-label', textContent: label }),
      h('div', { className: 'kpi-value', textContent: value }),
      h('div', { className: 'kpi-sub', textContent: sub }),
    ]);
  }

  function renderStepsTab() {
    const root = document.getElementById('tab-steps');
    root.replaceChildren();
    const ac = state.payload?.activeConversation;
    const views = getAgentViews(ac);
    const allOrdered = collectOrderedAgentSteps(ac, 'all', 200);
    const filtered = collectOrderedAgentSteps(ac, state.stepFilterAgent, 200);

    const filterBar = h('div', { className: 'toolbar' }, [
      h('button', {
        type: 'button',
        className: `btn btn-sm${state.stepFilterAgent === 'all' ? ' is-active' : ''}`,
        textContent: `All (${ac?.totalStepsAllAgents ?? allOrdered.length})`,
        onClick: () => {
          state.stepFilterAgent = 'all';
          renderStepsTab();
        },
      }),
      ...views.map((v) =>
        h('button', {
          type: 'button',
          className: `btn btn-sm${state.stepFilterAgent === v.agentId ? ' is-active' : ''}`,
          textContent: v.shortLabel || v.role || v.agentId,
          onClick: () => {
            state.stepFilterAgent = v.agentId;
            renderStepsTab();
          },
        })
      ),
    ]);

    const card = h('div', { className: 'card' }, [
      h('div', { className: 'card-header' }, [
        h('h2', { className: 'card-title', textContent: `Step Telemetry (${filtered.length})` }),
        filterBar,
      ]),
    ]);

    if (filtered.length === 0) {
      card.appendChild(h('div', { className: 'empty-state', textContent: 'No recorded steps.' }));
      root.appendChild(card);
      return;
    }

    const tbody = h('tbody');
    for (const st of filtered) {
      tbody.appendChild(
        h('tr', {}, [
          h('td', { className: 'mono', textContent: `#${st.stepIndex ?? '--'}` }),
          h('td', { textContent: st.agentBadge || st.agentLabel || 'M' }),
          h('td', { textContent: st.modelShort || st.modelLabel || 'Unknown' }),
          h('td', { className: 'num', textContent: fmtTokens(st.contextTokens) }),
          h('td', { className: 'num', textContent: fmtTokens(st.inputTokens) }),
          h('td', { className: 'num', textContent: fmtTokens(st.cacheReadTokens) }),
          h('td', { className: 'num', textContent: fmtTokens(st.outputTokens) }),
          h('td', { className: 'num', textContent: fmtTokens(st.thinkingTokens) }),
          h('td', { className: 'num', textContent: fmtSpeed(st.tokPerSec) }),
          h('td', { className: 'num', textContent: fmtSec(st.ttftSec) }),
          h('td', { className: 'num', textContent: fmtPct(st.cacheHitPct) }),
          h('td', { className: 'num', textContent: fmtUsd(st.costUsd) }),
        ])
      );
    }

    card.appendChild(
      h('div', { className: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', { textContent: 'Step' }),
              h('th', { textContent: 'Agent' }),
              h('th', { textContent: 'Model' }),
              h('th', { className: 'num', textContent: 'Context' }),
              h('th', { className: 'num', textContent: 'Input' }),
              h('th', { className: 'num', textContent: 'Cache' }),
              h('th', { className: 'num', textContent: 'Output' }),
              h('th', { className: 'num', textContent: 'Think' }),
              h('th', { className: 'num', textContent: 'Speed' }),
              h('th', { className: 'num', textContent: 'TTFT' }),
              h('th', { className: 'num', textContent: 'Hit %' }),
              h('th', { className: 'num', textContent: 'Cost' }),
            ]),
          ]),
          tbody,
        ]),
      ])
    );
    root.appendChild(card);
  }

  function renderAnalyticsTab() {
    const root = document.getElementById('tab-analytics');
    root.replaceChildren();
    const cons = state.payload?.consumption || {};
    const acct = extractUsageSummaryView(cons);

    const rangeBar = h(
      'div',
      { className: 'toolbar' },
      RANGE_OPTIONS.map((opt) =>
        h('button', {
          type: 'button',
          className: `btn btn-sm${state.selectedRange === opt.key ? ' is-active' : ''}`,
          textContent: opt.label,
          onClick: () => {
            state.selectedRange = opt.key;
            renderAnalyticsTab();
            fetchTelemetry({ userTriggered: true });
          },
        })
      )
    );

    root.appendChild(
      h('div', { className: 'card' }, [
        h('div', { className: 'card-header' }, [
          h('h2', {
            className: 'card-title',
            textContent: `Usage Summary (${cons.selectedRange?.label || state.selectedRange})`,
          }),
          rangeBar,
        ]),
        h('div', { className: 'grid-kpi', style: 'margin-bottom:0;' }, [
          kpiCard('Total Tokens', fmtTokens(acct.totalTokens), `${fmtInt(acct.calls)} calls`),
          kpiCard('Input + Cache', fmtTokens(acct.inputTokens + acct.cacheReadTokens), `Cache hit: ${fmtPct(acct.cacheHitPct)}`),
          kpiCard('Output Tokens', fmtTokens(acct.outputTokens), `Response: ${fmtTokens(acct.responseTokens)} · Think: ${fmtTokens(acct.thinkingTokens)}`),
          kpiCard('Estimated Cost', fmtUsd(acct.costUsd), `${fmtInt(acct.conversationsCount)} sessions`),
        ]),
      ])
    );

    const series = extractTrendBars(cons);
    const trendCard = h('div', { className: 'card' }, [
      h('div', { className: 'card-header' }, [
        h('h2', { className: 'card-title', textContent: 'Token Trend' }),
      ]),
    ]);
    if (series.length === 0) {
      trendCard.appendChild(h('div', { className: 'empty-state', textContent: 'No trend data in range.' }));
    } else {
      const maxVal = Math.max(1, ...series.map((b) => b.tokens));
      const bars = h('div', { className: 'chart-bars' });
      for (const b of series) {
        const hPct = Math.max(2, Math.round((b.tokens / maxVal) * 100));
        bars.appendChild(
          h('div', { className: 'chart-col', title: `${b.fullLabel}: ${fmtTokens(b.tokens)} (${fmtUsd(b.costUsd)})` }, [
            h('div', { className: 'chart-bar', style: `height:${hPct}%` }),
            h('div', { className: 'chart-lbl', textContent: b.label }),
          ])
        );
      }
      trendCard.appendChild(bars);
    }
    root.appendChild(trendCard);

    const models = extractModelBreakdownRows(state.payload);
    const workspaces = extractWorkspaceRows(cons);
    root.appendChild(
      h('div', { className: 'grid-two' }, [
        renderSimpleTableCard('Model Breakdown', ['Model', 'Calls', 'Tokens', 'Cost'], models.map((m) => [
          m.label,
          fmtInt(m.calls),
          fmtTokens(m.totalTokens),
          fmtUsd(m.costUsd),
        ])),
        renderSimpleTableCard('Top Workspaces', ['Workspace', 'Sessions', 'Tokens', 'Cost'], workspaces.map((w) => [
          w.label,
          fmtInt(w.sessionCount),
          fmtTokens(w.totalTokens),
          fmtUsd(w.costUsd),
        ])),
      ])
    );
  }

  function renderSimpleTableCard(title, headers, rows) {
    const card = h('div', { className: 'card', style: 'margin-bottom:0;' }, [
      h('div', { className: 'card-header' }, [h('h2', { className: 'card-title', textContent: title })]),
    ]);
    if (!rows.length) {
      card.appendChild(h('div', { className: 'empty-state', textContent: 'No records.' }));
      return card;
    }
    const tbody = h('tbody');
    for (const r of rows.slice(0, 15)) {
      tbody.appendChild(
        h(
          'tr',
          {},
          r.map((cell, idx) => h('td', { className: idx > 0 ? 'num' : '', textContent: cell }))
        )
      );
    }
    card.appendChild(
      h('div', { className: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [
            h(
              'tr',
              {},
              headers.map((hd, idx) => h('th', { className: idx > 0 ? 'num' : '', textContent: hd }))
            ),
          ]),
          tbody,
        ]),
      ])
    );
    return card;
  }

  function renderSettingsTab() {
    const root = document.getElementById('tab-settings');
    root.replaceChildren();
    const settings = state.payload?.settings || {};

    const modeSelect = h('select', { className: 'select-input', id: 'set-weekly-mode' }, [
      h('option', { value: 'official', textContent: 'Official Quota', selected: settings.weeklyLimitMode === 'official' }),
      h('option', { value: 'custom_tokens', textContent: 'Custom Token Budget', selected: settings.weeklyLimitMode === 'custom_tokens' }),
      h('option', { value: 'custom_cost', textContent: 'Custom Cost Budget', selected: settings.weeklyLimitMode === 'custom_cost' }),
    ]);
    const tokenInput = h('input', {
      className: 'text-input',
      id: 'set-token-budget',
      type: 'number',
      min: '0',
      value: String(settings.weeklyTokenBudget ?? 0),
    });
    const costInput = h('input', {
      className: 'text-input',
      id: 'set-cost-budget',
      type: 'number',
      min: '0',
      step: '0.5',
      value: String(settings.weeklyCostBudget ?? 0),
    });
    const accentSelect = h('select', { className: 'select-input', id: 'set-accent' }, [
      h('option', { value: 'host', textContent: 'Host Theme', selected: !settings.themeAccent || settings.themeAccent === 'host' }),
      h('option', { value: 'blue', textContent: 'Blue', selected: settings.themeAccent === 'blue' }),
      h('option', { value: 'emerald', textContent: 'Emerald', selected: settings.themeAccent === 'emerald' }),
      h('option', { value: 'amber', textContent: 'Amber', selected: settings.themeAccent === 'amber' }),
      h('option', { value: 'violet', textContent: 'Violet', selected: settings.themeAccent === 'violet' }),
      h('option', { value: 'rose', textContent: 'Rose', selected: settings.themeAccent === 'rose' }),
    ]);
    const scaleSelect = h('select', { className: 'select-input', id: 'set-font-scale' }, [
      h('option', { value: 'sm', textContent: 'Compact (sm)', selected: settings.fontScale === 'sm' }),
      h('option', { value: 'md', textContent: 'Standard (md)', selected: !settings.fontScale || settings.fontScale === 'md' }),
      h('option', { value: 'lg', textContent: 'Large (lg)', selected: settings.fontScale === 'lg' }),
      h('option', { value: 'xl', textContent: 'Extra Large (xl)', selected: settings.fontScale === 'xl' }),
    ]);

    const markDirty = () => {
      state.settingsEditVersion += 1;
      state.settingsDirty = true;
    };
    for (const inputEl of [modeSelect, tokenInput, costInput, accentSelect, scaleSelect]) {
      inputEl.addEventListener('input', markDirty);
      inputEl.addEventListener('change', markDirty);
    }

    const saveBtn = h('button', {
      type: 'button',
      className: 'btn btn-primary',
      textContent: 'Save Preferences',
      onClick: async () => {
        const submittedVersion = state.settingsEditVersion;
        try {
          const res = await apiFetch('./api/settings', {
            method: 'POST',
            body: JSON.stringify({
              weeklyLimitMode: modeSelect.value,
              weeklyTokenBudget: Number(tokenInput.value) || 0,
              weeklyCostBudget: Number(costInput.value) || 0,
              themeAccent: accentSelect.value,
              fontScale: scaleSelect.value,
            }),
          });
          if (state.payload) state.payload.settings = res.settings;
          applySettingsAppearance(res.settings);
          state.statusMessage = 'Preferences saved.';
          renderBanner();
          if (state.settingsEditVersion === submittedVersion) {
            state.settingsDirty = false;
            renderSettingsTab();
          }
          fetchTelemetry({ userTriggered: true });
        } catch (err) {
          if (err?.status === 401) {
            handleUnauthorized();
            return;
          }
          state.error = err?.message || 'Failed to save preferences';
          renderBanner();
        }
      },
    });

    root.appendChild(
      h('div', { className: 'card' }, [
        h('div', { className: 'card-header' }, [
          h('h2', { className: 'card-title', textContent: 'Display & Budget Preferences (Read-Only Monitor)' }),
        ]),
        h('div', { className: 'form-grid' }, [
          h('div', { className: 'field' }, [h('label', { textContent: 'Weekly Limit Mode' }), modeSelect]),
          h('div', { className: 'field' }, [h('label', { textContent: 'Weekly Token Budget' }), tokenInput]),
          h('div', { className: 'field' }, [h('label', { textContent: 'Weekly Cost Budget (USD)' }), costInput]),
          h('div', { className: 'field' }, [h('label', { textContent: 'Accent Color' }), accentSelect]),
          h('div', { className: 'field' }, [h('label', { textContent: 'Font Scale' }), scaleSelect]),
        ]),
        h('div', { className: 'toolbar' }, [
          saveBtn,
          h('button', {
            type: 'button',
            className: 'btn',
            textContent: 'Reset Defaults',
            onClick: async () => {
              const submittedVersion = state.settingsEditVersion;
              try {
                const res = await apiFetch('./api/settings/reset', { method: 'POST', body: '{}' });
                if (state.payload) state.payload.settings = res.settings;
                applySettingsAppearance(res.settings);
                state.statusMessage = 'Preferences reset to defaults.';
                renderBanner();
                if (state.settingsEditVersion === submittedVersion) {
                  state.settingsDirty = false;
                  renderSettingsTab();
                }
                fetchTelemetry({ userTriggered: true });
              } catch (err) {
                if (err?.status === 401) {
                  handleUnauthorized();
                  return;
                }
                state.error = err?.message || 'Failed to reset preferences';
                renderBanner();
              }
            },
          }),
        ]),
      ])
    );

    root.appendChild(
      h('div', { className: 'card' }, [
        h('div', { className: 'card-header' }, [
          h('h2', { className: 'card-title', textContent: 'Maintenance & Diagnostics' }),
        ]),
        h('div', { className: 'toolbar' }, [
          h('button', {
            type: 'button',
            className: 'btn',
            textContent: 'Refresh Local Data',
            onClick: () => fetchTelemetry({ force: true, userTriggered: true }),
          }),
          h('button', {
            type: 'button',
            className: 'btn',
            textContent: 'Sync Pricing Catalog',
            onClick: async () => {
              try {
                const res = await apiFetch('./api/cloud-sync', { method: 'POST', body: '{}' });
                state.statusMessage = res?.cloudStatus?.lastSyncError
                  ? `Catalog sync failed: ${res.cloudStatus.lastSyncError}`
                  : 'Pricing catalog synced.';
                renderBanner();
              } catch (err) {
                state.error = err?.message || 'Failed to sync pricing catalog';
                renderBanner();
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'btn',
            textContent: 'Rebuild Local Cache',
            onClick: async () => {
              try {
                await apiFetch('./api/cache/rebuild', { method: 'POST', body: '{}' });
                state.statusMessage = 'Local cache rebuilt.';
                renderBanner();
                fetchTelemetry({ userTriggered: true });
              } catch (err) {
                state.error = err?.message || 'Failed to rebuild local cache';
                renderBanner();
              }
            },
          }),
        ]),
      ])
    );
    state.settingsRendered = true;
  }

  function isFocusInsideSettingsForm() {
    const settingsRoot = document.getElementById('tab-settings');
    return Boolean(settingsRoot && document.activeElement && settingsRoot.contains(document.activeElement));
  }

  function renderAll({ preserveSettingsForm = false } = {}) {
    renderHeader();
    renderBanner();
    renderOverviewTab();
    renderStepsTab();
    renderAnalyticsTab();
    if (!state.settingsRendered || !preserveSettingsForm || (!state.settingsDirty && !isFocusInsideSettingsForm())) {
      renderSettingsTab();
    }
  }

  function setupEvents() {
    for (const btn of document.querySelectorAll('.tab-btn')) {
      btn.addEventListener('click', () => {
        const nextTab = btn.getAttribute('data-tab') || 'overview';
        state.activeTab = nextTab;
        for (const b of document.querySelectorAll('.tab-btn')) {
          const active = b === btn;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-selected', String(active));
        }
        for (const panel of document.querySelectorAll('.tab-panel')) {
          panel.classList.toggle('is-active', panel.id === `tab-${nextTab}`);
        }
      });
    }

    document.getElementById('conv-select').addEventListener('change', (ev) => {
      state.selectedConvId = ev.target.value;
      state.selectedAgentId = 'main';
      state.stepFilterAgent = 'all';
      fetchTelemetry({ userTriggered: true });
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
      if (state.authExpired) {
        handleUnauthorized();
        return;
      }
      fetchTelemetry({ force: true, userTriggered: true });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.pollTimer) {
          clearTimeout(state.pollTimer);
          state.pollTimer = null;
        }
      } else {
        fetchTelemetry();
      }
    });
  }

  setupEvents();
  fetchTelemetry();
})();
