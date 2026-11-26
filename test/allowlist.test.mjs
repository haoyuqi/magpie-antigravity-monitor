import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALLOWED_API_ROUTES,
  hasBlockedSettingsAction,
  isAllowedApiRoute,
  sanitizeSettingsPatch,
} from '../src/telemetry/allowlist.mjs';

describe('read-only API allowlist', () => {
  it('allows only the declared read-only monitor routes', () => {
    assert.equal(ALLOWED_API_ROUTES.length, 6);
    assert.equal(isAllowedApiRoute('GET', '/api/telemetry'), true);
    assert.equal(isAllowedApiRoute('post', '/api/settings'), true);
    assert.equal(isAllowedApiRoute('POST', '/api/settings/reset'), true);
    assert.equal(isAllowedApiRoute('POST', '/api/cache/rebuild'), true);
    assert.equal(isAllowedApiRoute('POST', '/api/cloud-sync'), true);
    assert.equal(isAllowedApiRoute('GET', '/api/quota-reservation/log'), true);
  });

  it('rejects host-invasive routes, wrong methods, and unknown paths', () => {
    const blocked = [
      ['GET', '/api/accounts'],
      ['POST', '/api/accounts/update'],
      ['POST', '/api/context-window'],
      ['POST', '/api/plugin-update'],
      ['POST', '/api/bridge/relaunch'],
      ['GET', '/api/host-i18n'],
      ['POST', '/api/host-i18n'],
      ['GET', '/api/session-migration/catalog'],
      ['POST', '/api/session-migration/migrate'],
      ['POST', '/api/export-file'],
      ['POST', '/api/reveal-file'],
      ['POST', '/api/telemetry'],
      ['GET', '/api/settings'],
      ['GET', '/api/unknown'],
    ];
    for (const [method, path] of blocked) {
      assert.equal(isAllowedApiRoute(method, path), false, `${method} ${path} must be blocked`);
    }
  });

  it('detects blocked settings sub-actions', () => {
    assert.equal(hasBlockedSettingsAction({ __bridgeAction: 'relaunch' }), true);
    assert.equal(hasBlockedSettingsAction({ __cliStatusLineAction: 'force_install' }), true);
    assert.equal(hasBlockedSettingsAction({ __hostI18nAction: 'get' }), true);
    assert.equal(hasBlockedSettingsAction({ __sessionMigrationAction: 'catalog' }), true);
    assert.equal(hasBlockedSettingsAction({ __exportFileAction: 'save' }), true);
    assert.equal(hasBlockedSettingsAction({ language: 'en-US', themeAccent: 'blue' }), false);
  });

  it('strips host-invasive fields while preserving display preferences', () => {
    const sanitized = sanitizeSettingsPatch({
      language: 'en-US',
      themeAccent: 'emerald',
      weeklyTokenBudget: 5_000_000,
      enableWindowOverlay: true,
      windowMountMode: 'dual',
      enableCliStatusLine: true,
      contextWindowMainEnabled: true,
      contextWindowSwarmEnabled: true,
      modelContextWindows: { 'gemini-2.5-pro': 200000 },
      pluginUpdateMode: 'auto',
      standalonePort: 9999,
      accountSwitchRiskAccepted: true,
      __customAction: 'nope',
    });

    assert.deepEqual(sanitized, {
      language: 'en-US',
      themeAccent: 'emerald',
      weeklyTokenBudget: 5_000_000,
    });
  });
});
