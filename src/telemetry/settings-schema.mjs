/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Full user preferences schema, default object factory, and full-object normalizer with context-window validation.
 *
 * All cross-platform enums and single-field pure normalization rules come from `../shared/settings-normalization.mjs`.
 */

const isContextWindowSettingId = () => false;
const isContextWindowOption = () => false;
import {
  ACCOUNT_QUOTA_REFRESH_MINUTES,
  CLI_STATUSLINE_PRESETS,
  CONTEXT_AGENT_MODES,
  DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
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
  POPOVER_WIDTH_MODES,
  STEP_TABLE_COLUMN_KEYS,
  STEP_TOKEN_SEGMENT_ALIASES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  normalizeAccountQuotaRefreshMinutes,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeExperimentalModernUi,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
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
} from './settings-normalization.mjs';

export {
  ACCOUNT_QUOTA_REFRESH_MINUTES,
  CLI_STATUSLINE_PRESETS,
  CONTEXT_AGENT_MODES,
  DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
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
  POPOVER_WIDTH_MODES,
  STEP_TABLE_COLUMN_KEYS,
  STEP_TOKEN_SEGMENT_ALIASES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  normalizeAccountQuotaRefreshMinutes,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeExperimentalModernUi,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
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
};

function isSchemaPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function schemaSanitizePositiveNum(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function normalizeModelContextWindows(value) {
  return Object.fromEntries(
    Object.entries(isSchemaPlainObject(value) ? value : {}).filter(
      ([id, option]) => isContextWindowSettingId(id) && isContextWindowOption(option)
    )
  );
}

export const DEFAULT_SETTINGS_SCHEMA = Object.freeze({
  language: 'auto',
  themeAccent: 'host',
  fontScale: 'md',
  modernUi: true,
  experimentalModernUi: true,
  weeklyTokenBudget: 150000000,
  weeklyCostBudget: 100,
  weeklyLimitMode: 'official',
  modelDisplayMode: 'short',
  showUpstreamModel: false,
  orchestratorIdMode: 'compact',
  pluginUpdateMode: 'manual',
  autoUpdatePlugin: false,
  windowMountMode: 'sidebar',
  enableWindowOverlay: false,
  popoverWidthMode: 'auto',
  popoverWidth: DEFAULT_POPOVER_WIDTH,
  enableCliStatusLine: false,
  cliStatusLineSlots: null,
  standalonePort: 0,
  showTopbarMultiSession: true,
  contextAgentMode: DEFAULT_CONTEXT_AGENT_MODE,
  topbarCapsuleSlots: DEFAULT_TOPBAR_SLOTS,
  hoverModules: DEFAULT_HOVER_MODULES,
  overviewModules: DEFAULT_OVERVIEW_MODULES,
  overviewMetrics: DEFAULT_OVERVIEW_METRICS,
  showStepTurnRail: false,
  showStepAgentBadge: true,
  showStepSpeedColor: false,
  showStepFilterToolbar: false,
  stepTokenComboFormat: DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  stepTableColumns: DEFAULT_STEP_TABLE_COLUMNS,
  experimentalQuotaReservation: true,
  accountQuotaRefreshMinutes: DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  accountSwitchRiskAccepted: false,
  contextWindowRiskAccepted: false,
  contextWindowMainEnabled: true,
  contextWindowSwarmEnabled: false,
  modelContextWindows: Object.freeze({}),
});

/**
 * Create a deep-copied fresh default preferences object.
 */
export function createDefaultSettingsObject() {
  return {
    ...DEFAULT_SETTINGS_SCHEMA,
    topbarCapsuleSlots: [...DEFAULT_TOPBAR_SLOTS],
    hoverModules: [...DEFAULT_HOVER_MODULES],
    overviewModules: [...DEFAULT_OVERVIEW_MODULES],
    overviewMetrics: [...DEFAULT_OVERVIEW_METRICS],
    stepTableColumns: [...DEFAULT_STEP_TABLE_COLUMNS],
    modelContextWindows: {},
  };
}

/**
 * Fully normalize a raw persisted object or incremental merge result into a valid preferences object.
 *
 * @param {unknown} rawInput
 */
export function normalizeFullSettings(rawInput) {
  const safeRaw = isSchemaPlainObject(rawInput) ? rawInput : {};
  const pluginUpdateMode = normalizePluginUpdateMode(
    safeRaw.pluginUpdateMode,
    safeRaw.autoUpdatePlugin
  );
  const windowMountMode = normalizeWindowMountMode(
    safeRaw.windowMountMode,
    safeRaw.enableWindowOverlay
  );
  const modelDisplayMode = normalizeModelDisplayMode(
    safeRaw.modelDisplayMode,
    safeRaw.showUpstreamModel
  );
  const modernUi =
    safeRaw.modernUi !== undefined ? normalizeModernUi(safeRaw.modernUi) : true;
  return {
    language: normalizeLanguageSetting(safeRaw.language),
    themeAccent: normalizeThemeAccent(safeRaw.themeAccent),
    fontScale: normalizeFontScale(safeRaw.fontScale),
    modernUi,
    experimentalModernUi: modernUi,
    weeklyTokenBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyTokenBudget ?? safeRaw.weeklyTokenLimit,
      DEFAULT_SETTINGS_SCHEMA.weeklyTokenBudget
    ),
    weeklyCostBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyCostBudget,
      DEFAULT_SETTINGS_SCHEMA.weeklyCostBudget
    ),
    weeklyLimitMode: normalizeWeeklyLimitMode(safeRaw.weeklyLimitMode),
    modelDisplayMode,
    showUpstreamModel: modelDisplayMode !== 'short',
    orchestratorIdMode: normalizeOrchestratorIdMode(safeRaw.orchestratorIdMode),
    pluginUpdateMode: 'manual',
    autoUpdatePlugin: false,
    windowMountMode: 'sidebar',
    enableWindowOverlay: false,
    popoverWidthMode: normalizePopoverWidthMode(safeRaw.popoverWidthMode),
    popoverWidth: normalizePopoverWidth(safeRaw.popoverWidth),
    enableCliStatusLine: false,
    cliStatusLineSlots: normalizeCliStatusLineSlots(safeRaw.cliStatusLineSlots),
    standalonePort: normalizeStandalonePort(safeRaw.standalonePort),
    showTopbarMultiSession: safeRaw.showTopbarMultiSession !== false,
    contextAgentMode: normalizeContextAgentMode(safeRaw.contextAgentMode),
    topbarCapsuleSlots: normalizeTopbarCapsuleSlots(safeRaw.topbarCapsuleSlots),
    hoverModules: normalizeHoverModules(safeRaw.hoverModules),
    overviewModules: normalizeOverviewModules(safeRaw.overviewModules),
    overviewMetrics: normalizeOverviewMetrics(safeRaw.overviewMetrics),
    showStepTurnRail: safeRaw.showStepTurnRail === true,
    showStepAgentBadge: safeRaw.showStepAgentBadge !== false,
    showStepSpeedColor: safeRaw.showStepSpeedColor === true,
    showStepFilterToolbar: safeRaw.showStepFilterToolbar === true,
    stepTokenComboFormat: normalizeStepTokenComboFormat(safeRaw.stepTokenComboFormat),
    stepTableColumns: normalizeStepTableColumns(safeRaw.stepTableColumns),
    experimentalQuotaReservation: normalizeExperimentalQuotaReservation(
      safeRaw.experimentalQuotaReservation
    ),
    accountQuotaRefreshMinutes: normalizeAccountQuotaRefreshMinutes(
      safeRaw.accountQuotaRefreshMinutes
    ),
    accountSwitchRiskAccepted: safeRaw.accountSwitchRiskAccepted === true,
    contextWindowRiskAccepted: safeRaw.contextWindowRiskAccepted === true,
    contextWindowMainEnabled: safeRaw.contextWindowMainEnabled !== false,
    contextWindowSwarmEnabled: safeRaw.contextWindowSwarmEnabled === true,
    modelContextWindows: normalizeModelContextWindows(safeRaw.modelContextWindows),
  };
}
