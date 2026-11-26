import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mon-kernel-'));
const tempDataDir = join(tempRoot, 'data');
const tempGeminiDir = join(tempRoot, 'gemini');

process.env.USAGE_MONITOR_DATA_DIR = tempDataDir;
process.env.ANTIGRAVITY_GEMINI_DIR = tempGeminiDir;
process.env.ANTIGRAVITY_LS_ADDRESS = 'test.invalid';

const { after, describe, it } = await import('node:test');
const {
  installBunSqliteShim,
  buildTelemetryPayload,
  loadSettings,
} = await import('../src/telemetry/index.mjs');
const { parseLsArgsFromCommandLine, parseLinuxProcNetTcpPorts } = await import(
  '../src/telemetry/ls-discovery.mjs'
);
const { MODEL_PRICING } = await import('../src/telemetry/pricing-catalog.mjs');
const { resolvePricingAt } = await import('../src/telemetry/model-pricing.mjs');

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('read-only telemetry kernel', () => {
  it('builds offline telemetry payload without touching live network or geminiDir', async () => {
    await installBunSqliteShim();
    const payload = await buildTelemetryPayload('', false, { range: 'all' });

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
});
