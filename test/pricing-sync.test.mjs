import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mon-pricing-'));
process.env.USAGE_MONITOR_DATA_DIR = tempRoot;
process.env.ANTIGRAVITY_LS_ADDRESS = 'test.invalid';

const { after, describe, it } = await import('node:test');
const { REMOTE_CATALOG_CACHE_FILE, cloudSyncState } = await import('../src/runtime/paths.mjs');
const { syncCloudCatalog } = await import('../src/runtime/pricing-sync.mjs');
const { MODEL_PRICING } = await import('../src/telemetry/pricing-catalog.mjs');

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('pricing-sync', () => {
  it('syncs upstream-format pricing catalog using "pricing" key and caches to disk', async () => {
    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          catalogVersion: '2026.11.26.test',
          updatedAt: '2099-01-01T00:00:00Z',
          pricing: {
            'test-cloud-model': {
              input: 1.25,
              cache: 0.12,
              output: 5.0,
              short: 'cloud-test',
              family: 'Gemini',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const status = await syncCloudCatalog({ force: true, fetchFn: mockFetch });
    assert.equal(fetchCalls, 1);
    assert.equal(status.lastSyncError, null);
    assert.equal(existsSync(REMOTE_CATALOG_CACHE_FILE), true);

    const cached = JSON.parse(readFileSync(REMOTE_CATALOG_CACHE_FILE, 'utf8'));
    assert.equal(cached.catalogVersion, '2026.11.26.test');
    assert.ok(typeof cached.fetchedAtMs === 'number' && cached.fetchedAtMs > 0);
    assert.ok(MODEL_PRICING['test-cloud-model']);
    assert.equal(MODEL_PRICING['test-cloud-model'].input, 1.25);

    // Non-forced call within TTL should hit local cache without calling fetchFn
    await syncCloudCatalog({ force: false, fetchFn: mockFetch });
    assert.equal(fetchCalls, 1);
  });

  it('rejects invalid catalog schema without writing cache file', async () => {
    rmSync(REMOTE_CATALOG_CACHE_FILE, { force: true });
    cloudSyncState.lastError = null;

    const badFetch = async () =>
      new Response(JSON.stringify({ schemaVersion: 1, models: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const status = await syncCloudCatalog({ force: true, fetchFn: badFetch });
    assert.equal(status.lastSyncError, 'Invalid pricing catalog schema');
    assert.equal(existsSync(REMOTE_CATALOG_CACHE_FILE), false);
  });

  it('reports sync failure when saveJson fails to write the cache file', async () => {
    rmSync(REMOTE_CATALOG_CACHE_FILE, { recursive: true, force: true });
    mkdirSync(REMOTE_CATALOG_CACHE_FILE, { recursive: true });
    const prevSuccessMs = cloudSyncState.lastSuccessMs;
    cloudSyncState.lastError = null;

    const validFetch = async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          catalogVersion: '2026.11.26.fail',
          pricing: {
            'test-write-fail-model': {
              input: 1.0,
              cache: 0.1,
              output: 2.0,
              short: 'fail-test',
              family: 'Gemini',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    try {
      const status = await syncCloudCatalog({ force: true, fetchFn: validFetch });
      assert.equal(status.lastSyncError, 'Failed to write pricing catalog cache');
      assert.equal(cloudSyncState.lastSuccessMs, prevSuccessMs);
    } finally {
      rmSync(REMOTE_CATALOG_CACHE_FILE, { recursive: true, force: true });
    }
  });
});
