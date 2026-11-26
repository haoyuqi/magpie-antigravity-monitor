import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mon-lifecycle-'));
process.env.USAGE_MONITOR_DATA_DIR = join(tempRoot, 'data');
process.env.ANTIGRAVITY_GEMINI_DIR = join(tempRoot, 'gemini');
delete process.env.ANTIGRAVITY_APP_DATA_DIR;
delete process.env.USAGE_MONITOR_APP_DATA_DIR;

const { after, describe, it } = await import('node:test');
const { startMonitorHttpServer } = await import('../src/server/http-server.mjs');
const { default: pluginMod, resolvePluginDataDir } = await import('../index.mjs');

const REPO_ROOT = join(import.meta.dirname, '..');

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('plugin manifest, sandbox launcher, and EADDRINUSE lifecycle', () => {
  it('validates package.json Magpie manifest and index.mjs OpenCode v1 export', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, './index.mjs');
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.magpie?.page?.file, 'page/index.html');
    assert.equal(pkg.magpie?.page?.icon, 'page/icon.svg');
    assert.equal(pkg.magpie?.page?.service?.option, 'port');
    assert.equal(pkg.magpie?.page?.service?.port, pkg.magpie?.options?.port);

    assert.equal(pluginMod.id, 'magpie-antigravity-monitor');
    assert.equal(typeof pluginMod.server, 'function');

    // input.directory must take precedence over inherited USAGE_MONITOR_DATA_DIR
    assert.equal(
      resolvePluginDataDir(
        { directory: '/tmp/magpie-plugin-dir' },
        { USAGE_MONITOR_DATA_DIR: '/tmp/inherited-env-dir' }
      ),
      join('/tmp/magpie-plugin-dir', '.antigravity-monitor')
    );

    // Empty input.directory without env must fall back to os.tmpdir(), never REPO_ROOT/.data
    const fallbackDir = resolvePluginDataDir({}, {});
    assert.equal(fallbackDir.startsWith(REPO_ROOT), false);

    // index.mjs must install bun-sqlite-shim BEFORE importing http-server/telemetry/paths
    const indexSrc = readFileSync(join(REPO_ROOT, 'index.mjs'), 'utf8');
    const shimIdx = indexSrc.indexOf("import('./src/runtime/bun-sqlite-shim.mjs')");
    const serverIdx = indexSrc.indexOf("import('./src/server/http-server.mjs')");
    assert.ok(shimIdx > 0);
    assert.ok(serverIdx > shimIdx);
    assert.equal(indexSrc.includes("import('./src/telemetry/index.mjs')"), false);
  });

  it('enforces Magpie sandbox invariants on page/index.html and page/boot.js', () => {
    const html = readFileSync(join(REPO_ROOT, 'page/index.html'), 'utf8');
    const boot = readFileSync(join(REPO_ROOT, 'page/boot.js'), 'utf8');

    assert.ok(html.includes('<script src="_magpie/bridge.js"></script>'));
    assert.ok(html.includes('<script src="boot.js"></script>'));
    // Must not contain inline script bodies
    const scriptTags = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const tag of scriptTags) {
      const inner = tag.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
      assert.equal(inner, '', 'page/index.html must not contain inline scripts');
    }

    const bootCode = boot.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/\bfetch\s*\(/i.test(bootCode), false);
    assert.equal(/XMLHttpRequest/i.test(bootCode), false);
    assert.equal(/\bWebSocket\b/i.test(bootCode), false);
    assert.equal(/localStorage/i.test(bootCode), false);
    assert.equal(/document\.cookie/i.test(bootCode), false);
    assert.ok(bootCode.includes('location.replace('));
  });

  it('retries EADDRINUSE in the background with default bindTries without blocking startup', async () => {
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('old-host');
    });
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = blocker.address().port;

    let monitor = null;
    try {
      const startMs = Date.now();
      monitor = await startMonitorHttpServer({
        port: busyPort,
        bgRetryIntervalMs: 40,
      });
      const elapsedMs = Date.now() - startMs;

      assert.equal(monitor.listening, false);
      assert.equal(monitor.port, busyPort);
      assert.ok(elapsedMs < 300, `Expected non-blocking startup, took ${elapsedMs}ms`);

      await new Promise((resolve) => blocker.close(resolve));
      const boundPort = await monitor.ready;
      assert.equal(boundPort, busyPort);

      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: busyPort,
            method: 'GET',
            path: '/',
            headers: {
              Host: `127.0.0.1:${busyPort}`,
              'Sec-Fetch-Mode': 'navigate',
            },
          },
          (r) => {
            r.resume();
            r.on('end', () => resolve({ status: r.statusCode }));
          }
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(res.status, 200);
    } finally {
      if (monitor) await monitor.close();
      if (blocker.listening) {
        await new Promise((resolve) => blocker.close(resolve));
      }
    }
  });
});
