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
 * Clean public entrypoint for the read-only Antigravity telemetry kernel.
 */

export { installBunSqliteShim } from '../runtime/bun-sqlite-shim.mjs';
export {
  clearRuntimeCaches,
  loadSettings,
  saveJson,
  SETTINGS_FILE,
} from '../runtime/paths.mjs';
export { syncCloudCatalog } from '../runtime/pricing-sync.mjs';
export {
  ALLOWED_API_ROUTES,
  hasBlockedSettingsAction,
  isAllowedApiRoute,
  sanitizeSettingsPatch,
} from './allowlist.mjs';
export {
  createDefaultSettingsObject,
  normalizeFullSettings,
} from './settings-schema.mjs';
export {
  buildTelemetryPayload,
  clearTelemetryBuilderMemo,
  setBeforeTelemetryReadHookForTest,
} from './telemetry-builder.mjs';
