/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Antigravity Language Server Connect RPC client and official quota summary cache.
 *
 * Responsibilities:
 * 1. Issue CSRF-authenticated, timeout-protected Connect RPC calls (`callLsRpc`) to the Language Server corresponding to local or SSH remote windows;
 * 2. Use two-tier transport for remote SSH endpoints:
 *    - Tier-1: Direct HTTP/HTTPS connection strictly restricted to loopback addresses (`127.0.0.1`/`localhost`/`::1`) (HTTPS allows host self-signed certificates on loopback only);
 *    - Tier-2: When Tier-1 is unavailable or authentication depends on Electron Partition Cookies / 2.33.0+ omits `csrfToken`,
 *      automatically trip the circuit breaker and fall back to same-origin `window.fetch` / `/connect-websocket` inside the window (executed on demand via CDP);
 * 3. Fetch and cache `RetrieveUserQuotaSummary` official real-time quota summaries and the `GetAvailableModels` model catalog, isolated per endpoint.
 */

import { isStrictLoopbackUrl, lsRuntimeEndpoint } from '../runtime/paths.mjs';
import {
  getEndpointQuotaCache,
  getRemoteWindowRpcInvoker,
  markRemoteEndpointPreferTier2,
  shouldRemoteEndpointPreferTier2,
} from './local-endpoint.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';

const QUOTA_CACHE_TTL_MS = 10_000;
const QUOTA_RETRY_COOLDOWN_MS = 5_000;
const REMOTE_HTTPS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REMOTE_ALLOWED_LS_METHODS = new Set([
  'GetUserStatus',
  'GetAvailableModels',
  'GetAllCascadeTrajectories',
  'GetCascadeTrajectory',
  'RetrieveUserQuotaSummary',
]);

let contextModelCatalog = null;
let loopbackHttpsModulePromise = null;
let customLoopbackHttpsRequester = null;

export function setLoopbackHttpsRequester(requester) {
  customLoopbackHttpsRequester = typeof requester === 'function' ? requester : null;
}

async function getLoopbackHttpsRequestFn() {
  if (customLoopbackHttpsRequester) return customLoopbackHttpsRequester;
  if (typeof globalThis !== 'undefined' && typeof globalThis.__agLoopbackHttpsRequest === 'function') {
    return globalThis.__agLoopbackHttpsRequest;
  }
  if (!loopbackHttpsModulePromise) {
    loopbackHttpsModulePromise = import('node:https')
      .then((mod) => (mod.default || mod)?.request || null)
      .catch(() => null);
  }
  return loopbackHttpsModulePromise;
}

async function postLoopbackHttpsJson(urlStr, csrfToken, bodyText, timeoutMs) {
  const parsed = new URL(urlStr);
  if (!isStrictLoopbackUrl(urlStr) || parsed.protocol !== 'https:') {
    throw new Error('Refusing non-loopback HTTPS request');
  }
  const requestFn = await getLoopbackHttpsRequestFn();
  if (typeof requestFn !== 'function') {
    return fetch(urlStr, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
      },
      body: bodyText,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let wallTimer = null;
    const clearWallTimer = () => {
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearWallTimer();
      reject(err);
    };
    const bodyBuf = Buffer.from(bodyText, 'utf8');
    const req = requestFn(
      {
        hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: Number(parsed.port || 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          totalBytes += chunk.length;
          if (totalBytes > REMOTE_HTTPS_MAX_RESPONSE_BYTES) {
            const sizeErr = new Error('Remote LS response exceeded size limit');
            finishErr(sizeErr);
            req.destroy(sizeErr);
            return;
          }
          chunks.push(chunk);
        });
        res.on('aborted', () => {
          finishErr(new Error('Remote LS HTTPS response aborted'));
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearWallTimer();
          const status = Number(res.statusCode || 0);
          const rawText = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(rawText || '{}'),
            text: async () => rawText,
          });
        });
        res.on('error', finishErr);
      }
    );

    wallTimer = setTimeout(() => {
      const timeoutErr = new Error(`Remote LS HTTPS timeout (${timeoutMs}ms)`);
      finishErr(timeoutErr);
      req.destroy(timeoutErr);
    }, timeoutMs);
    wallTimer?.unref?.();

    req.setTimeout(timeoutMs, () => {
      const timeoutErr = new Error(`Remote LS HTTPS timeout (${timeoutMs}ms)`);
      finishErr(timeoutErr);
      req.destroy(timeoutErr);
    });
    req.on('error', finishErr);
    req.write(bodyBuf);
    req.end();
  });
}

export function getContextModelCatalog(endpoint = null) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  if (isRemote) {
    const baseUrl = endpoint.baseUrl || endpoint.origin || '';
    const csrfToken = endpoint.csrfToken || '';
    const cached = endpoint.contextModelCatalog;
    if (
      !cached ||
      cached.baseUrl !== baseUrl ||
      cached.csrfToken !== csrfToken ||
      Date.now() >= cached.expiresAt
    ) {
      endpoint.contextModelCatalog = {
        baseUrl,
        csrfToken,
        expiresAt: Date.now() + 30000,
        promise: callLsRpc('GetAvailableModels', {}, 2500, endpoint)
          .then((data) => data?.response?.models)
          .catch(() => null),
      };
    }
    return endpoint.contextModelCatalog.promise;
  }

  const { baseUrl, csrfToken } = lsRuntimeEndpoint;
  if (
    !contextModelCatalog ||
    contextModelCatalog.baseUrl !== baseUrl ||
    contextModelCatalog.csrfToken !== csrfToken ||
    Date.now() >= contextModelCatalog.expiresAt
  ) {
    contextModelCatalog = {
      baseUrl,
      csrfToken,
      expiresAt: Date.now() + 30000,
      promise: callLsRpc('GetAvailableModels', {}, 1500)
        .then((data) => data?.response?.models)
        .catch(() => null),
    };
  }
  return contextModelCatalog.promise;
}

async function postLsRpcOnce(baseUrl, csrfToken, method, body, timeoutMs) {
  if (!isStrictLoopbackUrl(baseUrl)) {
    throw new Error('Refusing non-loopback Language Server URL');
  }
  return fetch(`${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken || '',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const REMOTE_TIER2_MIN_REMAINING_MS = 1500;

async function callRemoteEndpointLsRpc(endpoint, method, body, timeoutMs) {
  if (!REMOTE_ALLOWED_LS_METHODS.has(method)) {
    throw new Error(`RPC method ${method} is not allowed on remote endpoints`);
  }
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 5000);
  const deadlineMs = Date.now() + safeTimeoutMs;
  const baseUrl = String(endpoint.baseUrl || endpoint.origin || '').trim().replace(/\/+$/, '');
  const csrfToken = String(endpoint.csrfToken || '').trim();
  const windowInvoker = getRemoteWindowRpcInvoker();
  const canTryTier1 =
    Boolean(baseUrl) &&
    isStrictLoopbackUrl(baseUrl) &&
    Boolean(csrfToken) &&
    !shouldRemoteEndpointPreferTier2(endpoint);

  let tier1Err = null;
  if (canTryTier1) {
    try {
      const urlStr = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
      const bodyText = JSON.stringify(body || {});
      const res = urlStr.startsWith('https://')
        ? await postLoopbackHttpsJson(urlStr, csrfToken, bodyText, safeTimeoutMs)
        : await postLsRpcOnce(baseUrl, csrfToken, method, body || {}, safeTimeoutMs);
      if (res?.ok) {
        return await res.json();
      }
      const status = Number(res?.status || 0);
      const text = await res?.text?.().catch(() => '') || '';
      tier1Err = new Error(`Remote RPC ${method} failed (${status}): ${text}`);
      const isTransportAuthOrRouteMiss =
        status === 0 ||
        status === 401 ||
        status === 403 ||
        (status === 404 && method !== 'GetCascadeTrajectory');
      if (isTransportAuthOrRouteMiss) {
        markRemoteEndpointPreferTier2(endpoint);
      } else {
        // Rethrow business-level 4xx errors (such as GetCascadeTrajectory 404 when a single session has been deleted) directly without tripping the circuit breaker
        throw tier1Err;
      }
    } catch (err) {
      if (err === tier1Err) {
        throw err;
      }
      tier1Err = err;
      markRemoteEndpointPreferTier2(endpoint);
    }
  }

  if (typeof windowInvoker === 'function') {
    const remainingMs = canTryTier1 ? deadlineMs - Date.now() : safeTimeoutMs;
    if (!canTryTier1 || remainingMs >= REMOTE_TIER2_MIN_REMAINING_MS) {
      return windowInvoker(
        endpoint,
        method,
        body || {},
        Math.max(1000, Math.min(safeTimeoutMs, remainingMs))
      );
    }
  }

  if (tier1Err) {
    throw tier1Err;
  }
  throw new Error(`Remote LS transport unavailable for endpoint ${endpoint.id}`);
}

/**
 * Call a specified RPC method on the local or remote SSH `LanguageServerService` (local supports on-demand discovery and reconnection after host restart).
 *
 * @param {string} method RPC method name (e.g. `'GetUserStatus'`, `'GetCascadeTrajectory'`)
 * @param {object} [body={}] Request JSON payload
 * @param {number} [timeoutMs=5000] Timeout in milliseconds
 * @param {object|null} [endpoint=null] Optional remote endpoint object; defaults to local LS
 * @returns {Promise<object>}
 */
export async function callLsRpc(method, body = {}, timeoutMs = 5000, endpoint = null) {
  if (endpoint && endpoint.isRemote) {
    return callRemoteEndpointLsRpc(endpoint, method, body, timeoutMs);
  }
  if (lsRuntimeEndpoint.addr === 'test.invalid') {
    throw new Error('Language Server RPC disabled in offline test mode');
  }

  if (!lsRuntimeEndpoint.baseUrl) {
    await ensureLsEndpointDiscovered({ force: false });
  }
  if (!lsRuntimeEndpoint.baseUrl) {
    throw new Error('Language Server address (ANTIGRAVITY_LS_ADDRESS) is not configured');
  }
  if (!isStrictLoopbackUrl(lsRuntimeEndpoint.baseUrl)) {
    throw new Error('Refusing non-loopback Language Server URL');
  }

  const prevAddr = lsRuntimeEndpoint.addr;
  const prevToken = lsRuntimeEndpoint.csrfToken;
  let res;
  try {
    res = await postLsRpcOnce(
      lsRuntimeEndpoint.baseUrl,
      lsRuntimeEndpoint.csrfToken,
      method,
      body,
      timeoutMs
    );
  } catch (netErr) {
    if (lsRuntimeEndpoint.addr !== 'test.invalid') {
      const refreshed = await ensureLsEndpointDiscovered({ force: true });
      if (
        refreshed &&
        (lsRuntimeEndpoint.addr !== prevAddr || lsRuntimeEndpoint.csrfToken !== prevToken)
      ) {
        res = await postLsRpcOnce(
          lsRuntimeEndpoint.baseUrl,
          lsRuntimeEndpoint.csrfToken,
          method,
          body,
          timeoutMs
        );
      } else {
        throw netErr;
      }
    } else {
      throw netErr;
    }
  }

  if (!res.ok && (res.status === 401 || res.status === 403) && lsRuntimeEndpoint.addr !== 'test.invalid') {
    const refreshed = await ensureLsEndpointDiscovered({ force: true });
    if (
      refreshed &&
      (lsRuntimeEndpoint.addr !== prevAddr || lsRuntimeEndpoint.csrfToken !== prevToken)
    ) {
      res = await postLsRpcOnce(
        lsRuntimeEndpoint.baseUrl,
        lsRuntimeEndpoint.csrfToken,
        method,
        body,
        timeoutMs
      );
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RPC ${method} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Fetch the official real-time quota summary (`RetrieveUserQuotaSummary`), short-term cached and isolated per endpoint and account.
 *
 * @param {boolean} [forceRefresh=false] Whether to bypass local cache and failure cooldown
 * @param {string} [accountName=''] Account reported by the host when querying, used to isolate the quota cache
 * @param {object|null} [endpoint=null] Optional remote endpoint object
 * @returns {Promise<{data: object|null, fetchedAtMs: number, isStale: boolean, refreshFailed: boolean, error: string|null, fromCache: boolean}>}
 */
export async function getOfficialQuotaSummary(forceRefresh = false, accountName = '', endpoint = null) {
  const qCache = getEndpointQuotaCache(endpoint);
  if (qCache.accountName !== accountName) {
    Object.assign(qCache, {
      accountName,
      accountGeneration: qCache.accountGeneration + 1,
      ts: 0,
      lastAttemptTs: 0,
      data: null,
      error: null,
    });
  }
  const generation = qCache.accountGeneration;
  const now = Date.now();
  if (!forceRefresh && qCache.data && now - qCache.ts < QUOTA_CACHE_TTL_MS) {
    return {
      data: qCache.data,
      fetchedAtMs: qCache.ts,
      isStale: false,
      refreshFailed: false,
      error: null,
      fromCache: true,
    };
  }
  if (
    !forceRefresh &&
    qCache.lastAttemptTs > 0 &&
    now - qCache.lastAttemptTs < QUOTA_RETRY_COOLDOWN_MS &&
    qCache.error
  ) {
    return {
      data: qCache.data,
      fetchedAtMs: qCache.ts || 0,
      isStale: Boolean(qCache.data),
      refreshFailed: true,
      error: qCache.error,
      fromCache: true,
    };
  }

  qCache.lastAttemptTs = now;
  try {
    const res = await callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: true }, 6000, endpoint);
    const { userStatus } = await callLsRpc('GetUserStatus', {}, 2500, endpoint);
    if ((userStatus?.email || userStatus?.name || '') !== accountName) return {};
    if (generation !== qCache.accountGeneration) return {};
    const payload = res?.response !== undefined ? res.response : res;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const normalized =
        Array.isArray(payload.groups) || Array.isArray(payload.buckets)
          ? payload
          : { ...payload, groups: [] };
      qCache.ts = now;
      qCache.data = normalized;
      qCache.error = null;
      return {
        data: normalized,
        fetchedAtMs: now,
        isStale: false,
        refreshFailed: false,
        error: null,
        fromCache: false,
      };
    }
    qCache.error = 'Quota summary empty';
  } catch (err) {
    if (generation !== qCache.accountGeneration) return {};
    console.error(`RetrieveUserQuotaSummary failed: ${err.message}`);
    qCache.error = err.message;
  }
  return {
    data: qCache.data,
    fetchedAtMs: qCache.ts || 0,
    isStale: Boolean(qCache.data),
    refreshFailed: true,
    error: qCache.error || 'Quota RPC unavailable',
    fromCache: false,
  };
}
