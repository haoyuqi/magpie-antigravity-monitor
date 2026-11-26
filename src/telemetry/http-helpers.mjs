/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Zero-state static asset reader and localhost loopback request origin validator.
 *
 * Decoupled from `./config.mjs` and `./api-actions.mjs` so the host entrypoint `main.mjs` does not need to load the full backend graph and trajectory cache in production.
 */

import { readFileSync, promises as fsPromises } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveHttpHelperPanelDir() {
  const modDir = dirname(fileURLToPath(import.meta.url));
  return /[\\/]backend$/i.test(modDir) ? dirname(modDir) : modDir;
}

/**
 * Check whether the input value is a non-array plain object.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Asynchronously read a static asset file under `sidecars/panel` (compatible with synchronous unit-test sandboxes).
 *
 * @param {string} relPath Relative path
 * @returns {Promise<string>}
 */
export const readLocalAsync = async (relPath) => {
  const fullPath = join(resolveHttpHelperPanelDir(), relPath);
  if (typeof fsPromises !== 'undefined' && fsPromises?.readFile) {
    return fsPromises.readFile(fullPath, 'utf8');
  }
  return readFileSync(fullPath, 'utf8');
};

/**
 * Verify that the request originates from a local loopback address on the same port (`127.0.0.1` / `localhost` / `[::1]`) or a trusted Webview origin,
 * blocking cross-port local services (such as dev servers on other local ports) or cross-site DNS rebinding attacks against the API.
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) {
    return false;
  }
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^vscode-webview:\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  if (origin) {
    const originMatch = origin.match(
      /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/
    );
    if (!originMatch) {
      return false;
    }
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) {
        return false;
      }
    }
  }
  return true;
}
