/*
 * Copyright (C) 2026 haoyuqi and contributors
 * Based on yuhuan-dev/antigravity-usage-monitor (GNU GPL v3.0).
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
 * Lightweight pricing catalog sync (without any plugin self-update or process restart logic).
 */

import {
  CLOUD_CATALOG_URLS,
  CLOUD_SYNC_RETRY_COOLDOWN_MS,
  CLOUD_SYNC_TTL_MS,
  REMOTE_CATALOG_CACHE_FILE,
  cloudSyncState,
  loadJson,
  saveJson,
} from './paths.mjs';
import {
  getCloudStatus,
  rebuildActiveCatalog,
  sanitizeCatalogPayload,
} from '../telemetry/pricing-catalog.mjs';

function validateCatalogPayload(obj) {
  const sanitized = sanitizeCatalogPayload(obj);
  if (!sanitized || Object.keys(sanitized.pricing).length === 0) {
    return null;
  }
  return sanitized;
}

/**
 * Syncs `pricing-catalog.json` from the official catalog URL into `REMOTE_CATALOG_CACHE_FILE`.
 *
 * @param {{ force?: boolean, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<ReturnType<typeof getCloudStatus>>}
 */
export async function syncCloudCatalog({ force = false, fetchFn = fetch } = {}) {
  if (cloudSyncState.inFlight) {
    return cloudSyncState.inFlight;
  }
  const now = Date.now();
  if (!force) {
    const cached = loadJson(REMOTE_CATALOG_CACHE_FILE, null);
    const fetchedAtMs = Number(cached?.fetchedAtMs) || Date.parse(cached?.fetchedAt || '');
    if (
      validateCatalogPayload(cached) &&
      Number.isFinite(fetchedAtMs) &&
      now - fetchedAtMs < CLOUD_SYNC_TTL_MS
    ) {
      return getCloudStatus();
    }
    if (
      cloudSyncState.lastAttemptMs > 0 &&
      now - cloudSyncState.lastAttemptMs < CLOUD_SYNC_RETRY_COOLDOWN_MS
    ) {
      return getCloudStatus();
    }
  }

  cloudSyncState.lastAttemptMs = now;
  cloudSyncState.inFlight = (async () => {
    let lastErr = 'Empty catalog response';
    for (const url of CLOUD_CATALOG_URLS) {
      try {
        const res = await fetchFn(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }
        const parsed = await res.json();
        if (!validateCatalogPayload(parsed)) {
          lastErr = 'Invalid pricing catalog schema';
          continue;
        }
        const nowMs = Date.now();
        const payload = {
          ...parsed,
          fetchedAt: new Date(nowMs).toISOString(),
          fetchedAtMs: nowMs,
          sourceUrl: url,
        };
        saveJson(REMOTE_CATALOG_CACHE_FILE, payload);
        rebuildActiveCatalog();
        cloudSyncState.lastSuccessMs = nowMs;
        cloudSyncState.lastError = null;
        return getCloudStatus();
      } catch (err) {
        lastErr = err?.message || String(err);
      }
    }
    cloudSyncState.lastError = lastErr;
    return getCloudStatus();
  })().finally(() => {
    cloudSyncState.inFlight = null;
  });

  return cloudSyncState.inFlight;
}
