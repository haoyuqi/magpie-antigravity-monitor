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
 * Fail-closed read-only API route allowlist and settings payload sanitizer.
 */

export const ALLOWED_API_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/api/telemetry' }),
  Object.freeze({ method: 'POST', path: '/api/settings' }),
  Object.freeze({ method: 'POST', path: '/api/settings/reset' }),
  Object.freeze({ method: 'POST', path: '/api/cache/rebuild' }),
  Object.freeze({ method: 'POST', path: '/api/cloud-sync' }),
]);

const ALLOWED_ROUTE_SET = new Set(ALLOWED_API_ROUTES.map((r) => `${r.method}:${r.path}`));

const BLOCKED_SETTINGS_ACTION_KEYS = Object.freeze([
  '__bridgeAction',
  '__cliStatusLineAction',
  '__hostI18nAction',
  '__sessionMigrationAction',
  '__exportFileAction',
]);

const BLOCKED_SETTINGS_FIELDS = new Set([
  'enableWindowOverlay',
  'windowMountMode',
  'enableCliStatusLine',
  'cliStatusLinePreset',
  'cliStatusLineStyle',
  'cliStatusLineSlots',
  'contextWindowMainEnabled',
  'contextWindowSwarmEnabled',
  'modelContextWindows',
  'pluginUpdateMode',
  'autoUpdatePlugin',
  'standalonePort',
  'accountSwitchRiskAccepted',
]);

/**
 * Returns true only when `(method, pathname)` matches the read-only allowlist.
 *
 * @param {string} method
 * @param {string} pathname
 * @returns {boolean}
 */
export function isAllowedApiRoute(method, pathname) {
  const m = String(method || '').trim().toUpperCase();
  const p = String(pathname || '').trim();
  return ALLOWED_ROUTE_SET.has(`${m}:${p}`);
}

/**
 * Returns true if a `/api/settings` payload attempts to invoke a host-mutating sub-action.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
export function hasBlockedSettingsAction(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  return BLOCKED_SETTINGS_ACTION_KEYS.some((key) =>
    Object.prototype.hasOwnProperty.call(payload, key)
  );
}

/**
 * Strips all host-invasive keys and `__*` action keys from a settings update payload.
 *
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
export function sanitizeSettingsPatch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key.startsWith('__')) continue;
    if (BLOCKED_SETTINGS_FIELDS.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}
