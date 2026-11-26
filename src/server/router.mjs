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
 * Fail-closed read-only API router for the Magpie monitor HTTP service.
 */

import { isPlainObject } from '../telemetry/http-helpers.mjs';
import * as defaultTelemetryDeps from '../telemetry/index.mjs';

function parseFiniteMs(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/**
 * Dispatches an authenticated `/api/*` request through the read-only allowlist.
 *
 * @param {{
 *   method: string,
 *   pathname: string,
 *   searchParams?: URLSearchParams,
 *   body?: unknown,
 *   deps?: typeof defaultTelemetryDeps
 * }} input
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export async function handleApiRoute({
  method,
  pathname,
  searchParams = new URLSearchParams(),
  body = null,
  deps = defaultTelemetryDeps,
}) {
  const normMethod = String(method || '').trim().toUpperCase();
  const normPath = String(pathname || '').trim();

  if (!deps.isAllowedApiRoute(normMethod, normPath)) {
    return {
      status: 403,
      body: { error: 'Route not allowed in read-only mode' },
    };
  }

  if (normMethod === 'GET' && normPath === '/api/telemetry') {
    const requestedConvId = String(
      searchParams.get('conversationId') || searchParams.get('convId') || ''
    ).trim();
    const forceParam = String(
      searchParams.get('force') || searchParams.get('forceQuotaRefresh') || ''
    )
      .trim()
      .toLowerCase();
    const forceRefresh = forceParam === '1' || forceParam === 'true';
    const filterOpts = {};
    const range = String(searchParams.get('range') || '').trim();
    const pool = String(searchParams.get('pool') || '').trim();
    const scope = String(searchParams.get('scope') || '').trim();
    const startMs = parseFiniteMs(searchParams.get('startMs'));
    const endMs = parseFiniteMs(searchParams.get('endMs'));
    if (range) filterOpts.range = range;
    if (pool) filterOpts.pool = pool;
    if (scope) filterOpts.scope = scope;
    if (startMs > 0) filterOpts.startMs = startMs;
    if (endMs > 0) filterOpts.endMs = endMs;

    const payload = await deps.buildTelemetryPayload(requestedConvId, forceRefresh, filterOpts);
    return { status: 200, body: payload };
  }

  if (normMethod === 'POST' && normPath === '/api/settings') {
    if (!isPlainObject(body)) {
      return { status: 400, body: { error: 'Expected JSON object payload' } };
    }
    if (deps.hasBlockedSettingsAction(body)) {
      return {
        status: 403,
        body: { error: 'Blocked host-mutating settings action in read-only mode' },
      };
    }
    const patch = deps.sanitizeSettingsPatch(body);
    const current = deps.loadSettings();
    const next = deps.normalizeFullSettings({ ...current, ...patch });
    if (!deps.saveJson(deps.SETTINGS_FILE, next)) {
      return { status: 500, body: { error: 'Failed to persist settings' } };
    }
    deps.clearTelemetryBuilderMemo();
    return { status: 200, body: { ok: true, settings: next } };
  }

  if (normMethod === 'POST' && normPath === '/api/settings/reset') {
    const defaults = deps.createDefaultSettingsObject();
    if (!deps.saveJson(deps.SETTINGS_FILE, defaults)) {
      return { status: 500, body: { error: 'Failed to persist default settings' } };
    }
    deps.clearTelemetryBuilderMemo();
    return { status: 200, body: { ok: true, settings: defaults } };
  }

  if (normMethod === 'POST' && normPath === '/api/cache/rebuild') {
    deps.clearRuntimeCaches();
    deps.clearTelemetryBuilderMemo();
    return { status: 200, body: { ok: true } };
  }

  if (normMethod === 'POST' && normPath === '/api/cloud-sync') {
    const cloudStatus = await deps.syncCloudCatalog({ force: true });
    return { status: 200, body: { ok: true, cloudStatus } };
  }

  return { status: 404, body: { error: 'Not found' } };
}
