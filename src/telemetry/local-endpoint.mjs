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
 * Local-only endpoint adapter replacing multi-endpoint CDP registry.
 */

import { trajectoryCacheStore } from '../runtime/paths.mjs';

export const LOCAL_ENDPOINT_ID = 'local';

const localQuotaCache = {
  payload: null,
  fetchedAtMs: 0,
  lastAttemptMs: 0,
  accountKey: '',
  inFlight: null,
};

export function getEndpointCacheStore() {
  return trajectoryCacheStore;
}

export function getEndpointQuotaCache() {
  return localQuotaCache;
}

export function getRegisteredRemoteEndpoint() {
  return null;
}

export function getRemoteWindowRpcInvoker() {
  return null;
}

export function shouldRemoteEndpointPreferTier2() {
  return false;
}

export function markRemoteEndpointPreferTier2() {
  return {};
}

export function flushAllEndpointCachesNow() {
  return trajectoryCacheStore.flushTrajectoryCacheNow();
}
