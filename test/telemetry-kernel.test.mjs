import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mon-kernel-'));
const tempDataDir = join(tempRoot, 'data');
const tempGeminiDir = join(tempRoot, 'gemini');

process.env.USAGE_MONITOR_DATA_DIR = tempDataDir;
process.env.ANTIGRAVITY_GEMINI_DIR = tempGeminiDir;
process.env.ANTIGRAVITY_LS_ADDRESS = 'test.invalid';

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  fetchCalls += 1;
  throw new Error(`Unexpected network fetch in offline test: ${String(input)}`);
};

const { after, describe, it } = await import('node:test');
const {
  isStrictLoopbackUrl,
  lsRuntimeEndpoint,
  setLsRuntimeEndpoint,
} = await import('../src/runtime/paths.mjs');
const {
  installBunSqliteShim,
  buildTelemetryPayload,
  clearTelemetryBuilderMemo,
  createDefaultSettingsObject,
  loadSettings,
  saveJson,
  SETTINGS_FILE,
} = await import('../src/telemetry/index.mjs');
const { callLsRpc } = await import('../src/telemetry/ls-rpc.mjs');
const {
  discoverAntigravityLsEndpoint,
  parseLsArgsFromCommandLine,
  parseLinuxProcNetTcpPorts,
  setLsDiscoveryOverride,
} = await import('../src/telemetry/ls-discovery.mjs');
const { MODEL_PRICING } = await import('../src/telemetry/pricing-catalog.mjs');
const { resolvePricingAt } = await import('../src/telemetry/model-pricing.mjs');

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('read-only telemetry kernel', () => {
  it('builds offline telemetry payload with zero fetch calls and untouched geminiDir', async () => {
    await installBunSqliteShim();
    fetchCalls = 0;
    const payload = await buildTelemetryPayload('', false, { range: 'all' });

    assert.equal(fetchCalls, 0);
    assert.equal(lsRuntimeEndpoint.baseUrl, '');
    assert.equal(typeof payload, 'object');
    assert.ok(payload.activeConversation);
    assert.equal(typeof payload.quotas, 'object');
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

  it('rejects non-loopback Language Server addresses before sending any RPC', async () => {
    assert.equal(isStrictLoopbackUrl('http://127.0.0.1:41234'), true);
    assert.equal(isStrictLoopbackUrl('https://localhost:443'), true);
    assert.equal(isStrictLoopbackUrl('http://[::1]:8080'), true);
    assert.equal(isStrictLoopbackUrl('http://example.com:8080'), false);
    assert.equal(isStrictLoopbackUrl('https://192.168.1.5:443'), false);
    assert.equal(isStrictLoopbackUrl('http://127.0.0.1.evil.com:8080'), false);
    assert.equal(isStrictLoopbackUrl('http://user:pass@127.0.0.1:8080'), false);

    const prevAddr = lsRuntimeEndpoint.addr;
    const prevBaseUrl = lsRuntimeEndpoint.baseUrl;
    const prevToken = lsRuntimeEndpoint.csrfToken;
    const prevDynamic = lsRuntimeEndpoint.isDynamic;
    try {
      setLsRuntimeEndpoint('https://evil.example.com:443', 'secret-token');
      assert.equal(lsRuntimeEndpoint.baseUrl, '');
      assert.equal(lsRuntimeEndpoint.csrfToken, '');

      // Even if lsRuntimeEndpoint.baseUrl is mutated directly, callLsRpc refuses it with 0 fetches.
      lsRuntimeEndpoint.addr = 'evil.example.com:8080';
      lsRuntimeEndpoint.baseUrl = 'http://evil.example.com:8080';
      await assert.rejects(
        () => callLsRpc('GetUserStatus'),
        /Refusing non-loopback Language Server URL/
      );
      assert.equal(fetchCalls, 0);
    } finally {
      lsRuntimeEndpoint.addr = prevAddr;
      lsRuntimeEndpoint.baseUrl = prevBaseUrl;
      lsRuntimeEndpoint.csrfToken = prevToken;
      lsRuntimeEndpoint.isDynamic = prevDynamic;
    }
  });

  it('sets redirect: "error" on loopback RPC and endpoint-discovery fetch calls', async () => {
    const prevFetch = globalThis.fetch;
    const prevAddr = lsRuntimeEndpoint.addr;
    const prevBaseUrl = lsRuntimeEndpoint.baseUrl;
    const prevToken = lsRuntimeEndpoint.csrfToken;
    const prevDynamic = lsRuntimeEndpoint.isDynamic;
    const daemonDir = join(tempRoot, 'daemon');
    mkdirSync(daemonDir, { recursive: true });
    writeFileSync(
      join(daemonDir, 'hub_12345.json'),
      JSON.stringify({ pid: 12345, httpPort: 41235, csrfToken: 'tok-probe' }),
      'utf8'
    );

    let listProcCalls = 0;
    try {
      setLsDiscoveryOverride({
        platform: 'linux',
        daemonDirs: [daemonDir],
        isPidAliveFn: () => true,
        listProcessesFn: async () => {
          listProcCalls += 1;
          return [];
        },
        execCmdFn: async () => {
          throw new Error('Should not execute OS command when listProcessesFn is stubbed');
        },
      });

      const rpcFetchCalls = [];
      globalThis.fetch = async (url, init = {}) => {
        rpcFetchCalls.push({ url: String(url), redirect: init.redirect });
        if (init.redirect === 'error') {
          throw new TypeError('redirect blocked');
        }
        return new Response('{}', { status: 200 });
      };

      lsRuntimeEndpoint.addr = '127.0.0.1:41234';
      lsRuntimeEndpoint.baseUrl = 'http://127.0.0.1:41234';
      lsRuntimeEndpoint.csrfToken = 'tok-rpc';
      await assert.rejects(() => callLsRpc('GetUserStatus'), /redirect blocked/);

      assert.ok(rpcFetchCalls.length >= 1);
      assert.equal(
        rpcFetchCalls[0].url,
        'http://127.0.0.1:41234/exa.language_server_pb.LanguageServerService/GetUserStatus'
      );
      for (const call of rpcFetchCalls) {
        assert.equal(call.redirect, 'error');
        assert.ok(
          call.url.startsWith('http://127.0.0.1:41234/') ||
            call.url.startsWith('http://127.0.0.1:41235/') ||
            call.url.startsWith('https://127.0.0.1:41235/'),
          `Unexpected rediscovery target: ${call.url}`
        );
      }
      assert.equal(listProcCalls, 1);

      const probeRedirects = [];
      const endpoint = await discoverAntigravityLsEndpoint({
        platform: 'linux',
        daemonDirs: [daemonDir],
        isPidAliveFn: () => true,
        listProcessesFn: async () => [],
        execCmdFn: async () => '',
        fetchFn: async (_url, init = {}) => {
          probeRedirects.push(init.redirect);
          return new Response('{}', { status: 200 });
        },
      });
      assert.ok(endpoint);
      assert.equal(endpoint.baseUrl, 'http://127.0.0.1:41235');
      assert.deepEqual(probeRedirects, ['error']);
    } finally {
      setLsDiscoveryOverride(null);
      globalThis.fetch = prevFetch;
      lsRuntimeEndpoint.addr = prevAddr;
      lsRuntimeEndpoint.baseUrl = prevBaseUrl;
      lsRuntimeEndpoint.csrfToken = prevToken;
      lsRuntimeEndpoint.isDynamic = prevDynamic;
      rmSync(daemonDir, { recursive: true, force: true });
    }
  });

  it('parses Language Server CLI arguments and Linux proc tcp listening ports', () => {
    const parsed = parseLsArgsFromCommandLine(
      '/usr/local/bin/agy --hub --hub-port=41234 --csrf-token="tok-abc"'
    );
    assert.equal(parsed.isHub, true);
    assert.equal(parsed.hubPort, 41234);
    assert.equal(parsed.csrfToken, 'tok-abc');

    const tcpTable = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:A112 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 998877 1 00000000 100 0 0 10 0',
    ].join('\n');
    const ports = parseLinuxProcNetTcpPorts(tcpTable, new Set(['998877']));
    assert.deepEqual(ports, [0xa112]);
  });

  it('resolves model pricing from local data/pricing-catalog.json', () => {
    const entry = MODEL_PRICING['gemini-2.5-pro'];
    const pricing = resolvePricingAt(entry, Date.now());
    assert.ok(pricing && typeof pricing.input === 'number' && typeof pricing.output === 'number');
  });

  it('invalidates overlapping in-flight telemetry and keeps cold consumption-presets non-null', async () => {
    const prevFetch = globalThis.fetch;
    const prevAddr = lsRuntimeEndpoint.addr;
    const prevBaseUrl = lsRuntimeEndpoint.baseUrl;
    const prevToken = lsRuntimeEndpoint.csrfToken;
    const prevDynamic = lsRuntimeEndpoint.isDynamic;

    let releasePreSaveGate = null;
    let preSaveEnteredResolve = null;
    const preSaveEntered = new Promise((r) => {
      preSaveEnteredResolve = r;
    });
    let pauseFirstCall = true;

    try {
      setLsDiscoveryOverride({
        daemonDirs: [],
        isPidAliveFn: () => false,
        listProcessesFn: async () => [],
        execCmdFn: async () => '',
      });
      lsRuntimeEndpoint.addr = '127.0.0.1:41234';
      lsRuntimeEndpoint.baseUrl = 'http://127.0.0.1:41234';
      lsRuntimeEndpoint.csrfToken = 'tok-concurrency';

      globalThis.fetch = async () => {
        if (pauseFirstCall) {
          pauseFirstCall = false;
          preSaveEnteredResolve();
          await new Promise((r) => {
            releasePreSaveGate = r;
          });
        }
        return new Response(JSON.stringify({ userStatus: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      // 1. Start pre-save build and hold it inside fetch
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

      // 4. Release pre-save build and confirm it does not pollute snapshot cache
      releasePreSaveGate();
      await preSavePromise;
      const afterPreSavePayload = await buildTelemetryPayload('', false, { range: 'all' });
      assert.equal(afterPreSavePayload.settings.weeklyTokenBudget, 765432);

      // 5. Cold consumption-presets overlapping clearTelemetryBuilderMemo() must never return null
      clearTelemetryBuilderMemo();
      let presetsGateRelease = null;
      let presetsEnteredResolve = null;
      const presetsEntered = new Promise((r) => {
        presetsEnteredResolve = r;
      });
      let pausePresetsFirst = true;
      globalThis.fetch = async () => {
        if (pausePresetsFirst) {
          pausePresetsFirst = false;
          presetsEnteredResolve();
          await new Promise((r) => {
            presetsGateRelease = r;
          });
        }
        return new Response(JSON.stringify({ userStatus: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const coldPresetsPromise = buildTelemetryPayload('', false, {
        scope: 'consumption-presets',
      });
      await presetsEntered;
      clearTelemetryBuilderMemo();
      presetsGateRelease();
      const presetsPayload = await coldPresetsPromise;
      assert.ok(presetsPayload && typeof presetsPayload === 'object');
      assert.equal(presetsPayload.scope, 'consumption-presets');
      assert.equal(typeof presetsPayload.ranges, 'object');
    } finally {
      if (releasePreSaveGate) releasePreSaveGate();
      setLsDiscoveryOverride(null);
      globalThis.fetch = prevFetch;
      lsRuntimeEndpoint.addr = prevAddr;
      lsRuntimeEndpoint.baseUrl = prevBaseUrl;
      lsRuntimeEndpoint.csrfToken = prevToken;
      lsRuntimeEndpoint.isDynamic = prevDynamic;
      saveJson(SETTINGS_FILE, createDefaultSettingsObject());
      clearTelemetryBuilderMemo();
    }
  });
});
