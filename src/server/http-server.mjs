/*
 * Copyright (C) 2026 haoyuqi and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Local loopback HTTP server for the Magpie Antigravity Monitor page service.
 *
 * Security invariants:
 * - Binds strictly to `127.0.0.1`
 * - Enforces loopback client address, `Host`, and `Origin` checks
 * - Requires `Sec-Fetch-Mode: navigate` on token-bearing `GET /` / `GET /index.html`
 * - Authenticates all `/api/*` calls via per-process `X-Usage-Monitor-Token`
 * - Handles rolling-restart `EADDRINUSE` via bounded synchronous tries + background polling
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPreloadScript } from './preload.mjs';
import { handleApiRoute } from './router.mjs';

export const TOKEN_HEADER = 'x-usage-monitor-token';
export const DEFAULT_PORT = 18787;

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const serverDir = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(serverDir, '..', 'ui');

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

function isLoopbackRemoteAddress(remoteAddress) {
  const addr = String(remoteAddress || '').trim().toLowerCase();
  if (!addr) return true;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
    normalized
  );
}

function safeEqualToken(candidate, expected) {
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error('Payload too large');
        err.statusCode = 413;
        rejectBody(err);
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolveBody({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        rejectBody(err);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Starts the loopback HTTP service with rolling-restart `EADDRINUSE` resilience.
 *
 * @param {{
 *   port?: number,
 *   bindTries?: number,
 *   bindRetryDelayMs?: number,
 *   bgRetryIntervalMs?: number,
 *   apiDeps?: object
 * }} [options]
 */
export async function startMonitorHttpServer(options = {}) {
  const requestedPort = Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535
    ? options.port
    : DEFAULT_PORT;
  const bindTries = Math.max(1, Number(options.bindTries) || 1);
  const bindRetryDelayMs = Math.max(5, Number(options.bindRetryDelayMs) || 500);
  const bgRetryIntervalMs = Math.max(10, Number(options.bgRetryIntervalMs) || 1000);

  const token = randomBytes(32).toString('hex');
  let actualPort = requestedPort;
  let allowedHosts = new Set();
  let allowedOrigins = new Set();
  let closed = false;

  const updateAllowedEndpoints = (portNum) => {
    actualPort = portNum;
    allowedHosts = new Set([`127.0.0.1:${portNum}`, `localhost:${portNum}`]);
    allowedOrigins = new Set([`http://127.0.0.1:${portNum}`, `http://localhost:${portNum}`]);
  };
  updateAllowedEndpoints(requestedPort);

  const isHostAllowed = (req) => {
    const host = String(req.headers?.host || '').trim().toLowerCase();
    return Boolean(host) && allowedHosts.has(host);
  };

  const isOriginAllowed = (req) => {
    const origin = req.headers?.origin;
    if (origin === undefined) return true;
    if (origin === 'null') return true;
    return allowedOrigins.has(String(origin).trim().toLowerCase());
  };

  const buildCorsHeaders = (req) => {
    const origin = req.headers?.origin;
    const allowOrigin =
      origin === 'null'
        ? 'null'
        : origin && allowedOrigins.has(String(origin).trim().toLowerCase())
          ? String(origin).trim()
          : 'null';
    return {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, X-Usage-Monitor-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    };
  };

  const send = (res, status, contentType, body, extraHeaders = {}) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': payload.length,
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    res.end(payload);
  };

  const server = createServer(async (req, res) => {
    try {
      if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
        send(res, 403, 'text/plain; charset=utf-8', 'Forbidden non-loopback client');
        return;
      }
      if (!isHostAllowed(req) || !isOriginAllowed(req)) {
        send(res, 403, 'text/plain; charset=utf-8', 'Forbidden host or origin');
        return;
      }

      const method = String(req.method || 'GET').toUpperCase();
      const urlObj = new URL(String(req.url || '/'), `http://127.0.0.1:${actualPort || 80}`);
      const pathname = urlObj.pathname || '/';

      if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
        res.writeHead(204, {
          ...SECURITY_HEADERS,
          ...buildCorsHeaders(req),
        });
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) {
        const corsHeaders = buildCorsHeaders(req);
        const presented = req.headers?.[TOKEN_HEADER];
        if (!safeEqualToken(presented, token)) {
          send(res, 401, 'application/json; charset=utf-8', JSON.stringify({ error: 'Unauthorized' }), corsHeaders);
          return;
        }
        let body = null;
        if (method === 'POST') {
          try {
            body = await readJsonBody(req);
          } catch (bodyErr) {
            const status = Number(bodyErr?.statusCode) || 400;
            send(
              res,
              status,
              'application/json; charset=utf-8',
              JSON.stringify({ error: bodyErr?.message || 'Invalid body' }),
              corsHeaders
            );
            return;
          }
        }
        const routeResult = await handleApiRoute({
          method,
          pathname,
          searchParams: urlObj.searchParams,
          body,
          ...(options.apiDeps ? { deps: options.apiDeps } : {}),
        });
        send(
          res,
          routeResult.status,
          'application/json; charset=utf-8',
          JSON.stringify(routeResult.body),
          corsHeaders
        );
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
        const secFetchMode = String(req.headers?.['sec-fetch-mode'] || '').trim().toLowerCase();
        const accept = String(req.headers?.accept || '');
        const hasOrigin = req.headers?.origin !== undefined;
        const isPlainHtmlNav = secFetchMode === '' && !hasOrigin && /\btext\/html\b/i.test(accept);
        if (secFetchMode !== 'navigate' && !isPlainHtmlNav) {
          send(res, 403, 'text/plain; charset=utf-8', 'Navigation request required');
          return;
        }
        const rawHtml = await readFile(join(UI_ROOT, 'index.html'), 'utf8');
        const html = rawHtml.replace(
          '<head>',
          `<head>\n  <meta name="usage-monitor-token" content="${token}">`
        );
        if (method === 'HEAD') {
          const buf = Buffer.from(html, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': buf.length,
            ...SECURITY_HEADERS,
          });
          res.end();
          return;
        }
        send(res, 200, 'text/html; charset=utf-8', html);
        return;
      }

      if (method === 'GET' && pathname === '/preload.js') {
        send(res, 200, 'text/javascript; charset=utf-8', renderPreloadScript(), buildCorsHeaders(req));
        return;
      }

      if (method === 'GET' && pathname === '/styles.css') {
        const css = await readFile(join(UI_ROOT, 'styles.css'));
        send(res, 200, 'text/css; charset=utf-8', css, buildCorsHeaders(req));
        return;
      }

      if (method === 'GET' && pathname === '/app.js') {
        const js = await readFile(join(UI_ROOT, 'app.js'));
        send(res, 200, 'text/javascript; charset=utf-8', js, buildCorsHeaders(req));
        return;
      }

      if (method === 'GET' && pathname === '/view-model.mjs') {
        const js = await readFile(join(UI_ROOT, 'view-model.mjs'));
        send(res, 200, 'text/javascript; charset=utf-8', js, buildCorsHeaders(req));
        return;
      }

      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // Ignore already-closed stream errors
        }
        return;
      }
      send(
        res,
        500,
        'application/json; charset=utf-8',
        JSON.stringify({ error: err?.message || 'Internal server error' })
      );
    }
  });

  const bindOnce = (portToBind) =>
    new Promise((resolveBind, rejectBind) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        rejectBind(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        resolveBind(typeof addr === 'object' && addr ? addr.port : portToBind);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(portToBind, '127.0.0.1');
    });

  let bound = false;
  for (let attempt = 0; attempt < bindTries && !bound && !closed; attempt++) {
    try {
      const boundPort = await bindOnce(requestedPort);
      updateAllowedEndpoints(boundPort);
      bound = true;
    } catch (err) {
      if (err?.code !== 'EADDRINUSE' || requestedPort === 0) {
        throw err;
      }
      if (attempt + 1 < bindTries) {
        await delay(bindRetryDelayMs);
      }
    }
  }

  let ready;
  if (bound) {
    ready = Promise.resolve(actualPort);
  } else {
    ready = (async () => {
      while (!closed) {
        await delay(bgRetryIntervalMs);
        if (closed) break;
        try {
          const boundPort = await bindOnce(requestedPort);
          updateAllowedEndpoints(boundPort);
          return boundPort;
        } catch (err) {
          if (err?.code !== 'EADDRINUSE') {
            throw err;
          }
        }
      }
      return 0;
    })();
    ready.catch(() => {});
  }

  return {
    port: actualPort,
    listening: bound,
    ready,
    token,
    server,
    close: () =>
      new Promise((resolveClose) => {
        closed = true;
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close(() => resolveClose());
      }),
  };
}
