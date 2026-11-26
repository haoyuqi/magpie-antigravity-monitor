import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'ag-mon-http-'));
process.env.USAGE_MONITOR_DATA_DIR = join(tempRoot, 'data');
process.env.ANTIGRAVITY_GEMINI_DIR = join(tempRoot, 'gemini');
process.env.ANTIGRAVITY_LS_ADDRESS = 'test.invalid';

const { after, before, describe, it } = await import('node:test');
const { installBunSqliteShim } = await import('../src/telemetry/index.mjs');
const { startMonitorHttpServer, TOKEN_HEADER } = await import('../src/server/http-server.mjs');

function rawHttpRequest(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('monitor HTTP server & security', () => {
  let srv = null;

  before(async () => {
    await installBunSqliteShim();
    srv = await startMonitorHttpServer({ port: 0 });
  });

  after(async () => {
    if (srv) await srv.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('serves index.html with injected token only on Sec-Fetch-Mode: navigate and without cookies or CORS', async () => {
    const navRes = await rawHttpRequest(srv.port, {
      path: '/',
      headers: { 'Sec-Fetch-Mode': 'navigate' },
    });
    assert.equal(navRes.status, 200);
    assert.match(navRes.headers['content-type'], /^text\/html/);
    assert.match(navRes.headers['cache-control'], /no-store/);
    assert.equal(navRes.headers['set-cookie'], undefined);
    assert.equal(navRes.headers['access-control-allow-origin'], undefined);
    assert.ok(navRes.body.includes(`<meta name="usage-monitor-token" content="${srv.token}">`));

    const nonNavRes = await rawHttpRequest(srv.port, {
      path: '/',
      headers: { 'Sec-Fetch-Mode': 'cors' },
    });
    assert.equal(nonNavRes.status, 403);

    const missingModeRes = await rawHttpRequest(srv.port, { path: '/' });
    assert.equal(missingModeRes.status, 403);

    // magpie web --lan over plain HTTP omits Sec-Fetch-Mode but sends Accept: text/html without Origin
    const lanHtmlNavRes = await rawHttpRequest(srv.port, {
      path: '/',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(lanHtmlNavRes.status, 200);
    assert.equal(lanHtmlNavRes.headers['set-cookie'], undefined);
    assert.equal(lanHtmlNavRes.headers['access-control-allow-origin'], undefined);
    assert.ok(lanHtmlNavRes.body.includes(`<meta name="usage-monitor-token" content="${srv.token}">`));

    // Missing Sec-Fetch-Mode WITH Origin: null (sandboxed fetch) must still be rejected
    const missingModeWithOrigin = await rawHttpRequest(srv.port, {
      path: '/',
      headers: { Accept: 'text/html', Origin: 'null' },
    });
    assert.equal(missingModeWithOrigin.status, 403);
  });

  it('rejects DNS-rebinding Host and disallowed Origin headers while allowing null and same-origin', async () => {
    const badHost = await rawHttpRequest(srv.port, {
      path: '/styles.css',
      headers: { Host: 'evil.example:80' },
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await rawHttpRequest(srv.port, {
      path: '/api/telemetry',
      headers: {
        Origin: 'https://evil.example',
        [TOKEN_HEADER]: srv.token,
      },
    });
    assert.equal(badOrigin.status, 403);

    const nullOrigin = await rawHttpRequest(srv.port, {
      path: '/api/quota-reservation/log',
      headers: {
        Origin: 'null',
        [TOKEN_HEADER]: srv.token,
      },
    });
    assert.equal(nullOrigin.status, 200);
    assert.equal(nullOrigin.headers['access-control-allow-origin'], 'null');

    const sameOrigin = await rawHttpRequest(srv.port, {
      path: '/api/quota-reservation/log',
      headers: {
        Origin: `http://localhost:${srv.port}`,
        [TOKEN_HEADER]: srv.token,
      },
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers['access-control-allow-origin'], `http://localhost:${srv.port}`);
  });

  it('requires valid X-Usage-Monitor-Token on /api/* and serves read-only telemetry', async () => {
    const noToken = await rawHttpRequest(srv.port, { path: '/api/telemetry' });
    assert.equal(noToken.status, 401);

    const badToken = await rawHttpRequest(srv.port, {
      path: '/api/telemetry',
      headers: { [TOKEN_HEADER]: 'wrong-token' },
    });
    assert.equal(badToken.status, 401);

    const okRes = await rawHttpRequest(srv.port, {
      path: '/api/telemetry?range=all',
      headers: { [TOKEN_HEADER]: srv.token },
    });
    assert.equal(okRes.status, 200);
    const data = JSON.parse(okRes.body);
    assert.equal(typeof data, 'object');
    assert.ok(data.activeConversation);
    assert.equal(typeof data.quotas, 'object');
    assert.equal(typeof data.consumption, 'object');
  });

  it('blocks host-invasive routes and settings sub-actions while persisting safe display settings', async () => {
    for (const route of [
      '/api/account-switch',
      '/api/window-bridge',
      '/api/host-i18n',
      '/api/plugin-update',
      '/api/unknown',
    ]) {
      const res = await rawHttpRequest(srv.port, {
        method: 'POST',
        path: route,
        headers: {
          [TOKEN_HEADER]: srv.token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 403, `Expected 403 for ${route}`);
    }

    const blockedAction = await rawHttpRequest(srv.port, {
      method: 'POST',
      path: '/api/settings',
      headers: {
        [TOKEN_HEADER]: srv.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ __bridgeAction: 'enable' }),
    });
    assert.equal(blockedAction.status, 403);

    const patchRes = await rawHttpRequest(srv.port, {
      method: 'POST',
      path: '/api/settings',
      headers: {
        [TOKEN_HEADER]: srv.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        themeAccent: 'emerald',
        fontScale: 'sm',
        enableWindowOverlay: true,
        enableCliStatusLine: true,
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = JSON.parse(patchRes.body);
    assert.equal(patched.ok, true);
    assert.equal(patched.settings.themeAccent, 'emerald');
    assert.equal(patched.settings.fontScale, 'sm');
    assert.equal(patched.settings.enableWindowOverlay, false);
    assert.equal(patched.settings.enableCliStatusLine, false);

    const resetRes = await rawHttpRequest(srv.port, {
      method: 'POST',
      path: '/api/settings/reset',
      headers: {
        [TOKEN_HEADER]: srv.token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(resetRes.status, 200);
    const resetData = JSON.parse(resetRes.body);
    assert.equal(resetData.ok, true);

    const rebuildRes = await rawHttpRequest(srv.port, {
      method: 'POST',
      path: '/api/cache/rebuild',
      headers: {
        [TOKEN_HEADER]: srv.token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(rebuildRes.status, 200);

    // Concurrent GET started before POST /api/settings must not be reused by GET after save
    const preSaveGet = rawHttpRequest(srv.port, {
      path: '/api/telemetry?range=all',
      headers: { [TOKEN_HEADER]: srv.token },
    });
    const saveBudgetRes = await rawHttpRequest(srv.port, {
      method: 'POST',
      path: '/api/settings',
      headers: {
        [TOKEN_HEADER]: srv.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        weeklyLimitMode: 'custom_tokens',
        weeklyTokenBudget: 123456,
      }),
    });
    assert.equal(saveBudgetRes.status, 200);
    await preSaveGet;

    const postSaveGet = await rawHttpRequest(srv.port, {
      path: '/api/telemetry?range=all',
      headers: { [TOKEN_HEADER]: srv.token },
    });
    assert.equal(postSaveGet.status, 200);
    const postPayload = JSON.parse(postSaveGet.body);
    assert.equal(postPayload.settings.weeklyLimitMode, 'custom_tokens');
    assert.equal(postPayload.settings.weeklyTokenBudget, 123456);
    assert.equal(postPayload.quotas.weekly.title, 'Weekly Limit (Custom Local)');

    await rawHttpRequest(srv.port, {
      method: 'POST',
      path: '/api/settings/reset',
      headers: {
        [TOKEN_HEADER]: srv.token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  });

  it('handles OPTIONS preflight and serves static UI assets including view-model.mjs', async () => {
    const preflight = await rawHttpRequest(srv.port, {
      method: 'OPTIONS',
      path: '/api/telemetry',
      headers: {
        Origin: 'null',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Usage-Monitor-Token',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'null');
    assert.match(preflight.headers['access-control-allow-headers'], /X-Usage-Monitor-Token/i);

    for (const [path, ct] of [
      ['/preload.js', /^text\/javascript/],
      ['/styles.css', /^text\/css/],
      ['/app.js', /^text\/javascript/],
      ['/view-model.mjs', /^text\/javascript/],
    ]) {
      const res = await rawHttpRequest(srv.port, { path, headers: { Origin: 'null' } });
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], ct);
      assert.equal(res.headers['access-control-allow-origin'], 'null');
    }

    const preloadRes = await rawHttpRequest(srv.port, { path: '/preload.js' });
    assert.ok(preloadRes.body.includes('window.sidecar'));
    assert.ok(preloadRes.body.includes('X-Usage-Monitor-Token'));

    const traversal = await rawHttpRequest(srv.port, { path: '/../package.json' });
    assert.equal(traversal.status, 404);
  });
});
