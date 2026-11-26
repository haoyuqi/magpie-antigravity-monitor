import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mon-kernel-'));
const tempDataDir = join(tempRoot, 'data');
const tempGeminiDir = join(tempRoot, 'gemini');

process.env.USAGE_MONITOR_DATA_DIR = tempDataDir;
process.env.ANTIGRAVITY_GEMINI_DIR = tempGeminiDir;
process.env.USAGE_MONITOR_DISABLE_THROTTLE = '1';
delete process.env.ANTIGRAVITY_APP_DATA_DIR;
delete process.env.USAGE_MONITOR_APP_DATA_DIR;

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  fetchCalls += 1;
  throw new Error(`Unexpected network fetch in local-disk-only test: ${String(input)}`);
};

const { after, describe, it } = await import('node:test');
const { loadSettings } = await import('../src/runtime/paths.mjs');
const {
  installBunSqliteShim,
  buildTelemetryPayload,
  clearTelemetryBuilderMemo,
  createDefaultSettingsObject,
  saveJson,
  setBeforeTelemetryReadHookForTest,
  SETTINGS_FILE,
} = await import('../src/telemetry/index.mjs');
const { MODEL_PRICING } = await import('../src/telemetry/pricing-catalog.mjs');
const { resolvePricingAt } = await import('../src/telemetry/model-pricing.mjs');

after(() => {
  setBeforeTelemetryReadHookForTest(null);
  globalThis.fetch = originalFetch;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('local-disk-only telemetry kernel', () => {
  it('builds local-disk-only telemetry payload with zero fetch calls and untouched geminiDir', async () => {
    await installBunSqliteShim();
    fetchCalls = 0;
    const payload = await buildTelemetryPayload('', false, { range: 'all' });

    assert.equal(fetchCalls, 0);
    assert.equal(typeof payload, 'object');
    assert.ok(payload.activeConversation);
    assert.equal(typeof payload.quotas, 'object');
    assert.deepEqual(payload.quotas.pools, []);
    assert.equal(payload.quotas.meta.hasOfficialData, false);
    assert.equal(payload.quotas.meta.disabledReason, 'local_disk_only');
    assert.equal(payload.account.status, 'local');
    assert.equal(typeof payload.consumption, 'object');
    assert.deepEqual(payload.windowBridge, { active: false, supported: false, mode: 'magpie' });
    assert.deepEqual(payload.cloudCodeProxy, { active: false, supported: false });
    assert.deepEqual(payload.cliStatusLine, { configured: false, supported: false });
    assert.deepEqual(payload.contextWindowModels, []);

    const settings = loadSettings();
    assert.equal(typeof settings.language, 'string');

    let geminiEntries = [];
    try {
      geminiEntries = readdirSync(tempGeminiDir);
    } catch {
      geminiEntries = [];
    }
    assert.deepEqual(geminiEntries, []);
  });

  it('resolves model pricing from local data/pricing-catalog.json', () => {
    const entry = MODEL_PRICING['gemini-2.5-pro'];
    const pricing = resolvePricingAt(entry, Date.now());
    assert.ok(pricing && typeof pricing.input === 'number' && typeof pricing.output === 'number');
  });

  it('invalidates overlapping in-flight telemetry and keeps cold consumption-presets non-null', async () => {
    let releasePreSaveGate = null;
    let preSaveEnteredResolve = null;
    const preSaveEntered = new Promise((r) => {
      preSaveEnteredResolve = r;
    });
    let pauseFirstCall = true;
    let readHookCalls = 0;

    try {
      setBeforeTelemetryReadHookForTest(async () => {
        readHookCalls += 1;
        if (pauseFirstCall) {
          pauseFirstCall = false;
          preSaveEnteredResolve();
          await new Promise((r) => {
            releasePreSaveGate = r;
          });
        }
      });

      // 1. Start pre-save build and hold it inside local read hook
      clearTelemetryBuilderMemo();
      const preSavePromise = buildTelemetryPayload('', false, { range: 'all' });
      await preSaveEntered;

      // 2. While preSavePromise is in flight, update settings and invalidate memo
      saveJson(SETTINGS_FILE, {
        ...createDefaultSettingsObject(),
        weeklyLimitMode: 'custom_tokens',
        weeklyTokenBudget: 765432,
      });
      clearTelemetryBuilderMemo();

      // 3. Post-save GET must NOT reuse preSavePromise and must observe updated settings
      const postSavePromise = buildTelemetryPayload('', false, { range: 'all' });
      assert.notEqual(postSavePromise, preSavePromise);
      const postSavePayload = await postSavePromise;
      assert.equal(postSavePayload.settings.weeklyLimitMode, 'custom_tokens');
      assert.equal(postSavePayload.settings.weeklyTokenBudget, 765432);

      // 4. Release pre-save build and confirm it does not pollute snapshot cache (0 reads)
      releasePreSaveGate();
      await preSavePromise;

      const callsBeforeFastPresets = readHookCalls;
      const fastPresets = await buildTelemetryPayload('', false, {
        scope: 'consumption-presets',
      });
      assert.equal(fastPresets?.scope, 'consumption-presets');
      assert.equal(readHookCalls, callsBeforeFastPresets);

      const afterPreSavePayload = await buildTelemetryPayload('', false, { range: 'all' });
      assert.equal(afterPreSavePayload.settings.weeklyTokenBudget, 765432);

      // 5. Cold consumption-presets overlapping double clearTelemetryBuilderMemo() must never return null
      clearTelemetryBuilderMemo();
      let coldReadCount = 0;
      const presetsGates = [];
      const presetsEnteredPromises = [0, 1].map(() => {
        let resolveEntered;
        const promise = new Promise((r) => {
          resolveEntered = r;
        });
        return { promise, resolveEntered };
      });
      setBeforeTelemetryReadHookForTest(async () => {
        if (coldReadCount < 2) {
          const idx = coldReadCount++;
          presetsEnteredPromises[idx].resolveEntered();
          await new Promise((r) => {
            presetsGates[idx] = r;
          });
        }
      });

      const coldPresetsPromise = buildTelemetryPayload('', false, {
        scope: 'consumption-presets',
      });
      await presetsEnteredPromises[0].promise;
      clearTelemetryBuilderMemo();
      presetsGates[0]();

      await presetsEnteredPromises[1].promise;
      clearTelemetryBuilderMemo();
      presetsGates[1]();

      const presetsPayload = await coldPresetsPromise;
      assert.ok(presetsPayload && typeof presetsPayload === 'object');
      assert.equal(presetsPayload.scope, 'consumption-presets');
      assert.equal(typeof presetsPayload.ranges, 'object');
      assert.equal(coldReadCount, 2);
      assert.equal(fetchCalls, 0);
    } finally {
      if (releasePreSaveGate) releasePreSaveGate();
      setBeforeTelemetryReadHookForTest(null);
      saveJson(SETTINGS_FILE, createDefaultSettingsObject());
      clearTelemetryBuilderMemo();
    }
  });
});
