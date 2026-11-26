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
 * Magpie OpenCode v1 plugin entrypoint.
 *
 * Importing this module never binds a port. The local loopback HTTP service
 * starts lazily once when Magpie invokes `server(input, options)`.
 */

import { join } from 'node:path';

export const DEFAULT_PORT = 18787;

let started = null;

function resolvePort(options) {
  const num = Number(options?.port);
  if (Number.isInteger(num) && num > 0 && num <= 65535) {
    return num;
  }
  return DEFAULT_PORT;
}

function resolveIsolatedDataDir(input) {
  if (process.env.USAGE_MONITOR_DATA_DIR) {
    return process.env.USAGE_MONITOR_DATA_DIR;
  }
  const baseDir = String(input?.directory || '').trim();
  if (baseDir) {
    const dir = join(baseDir, '.antigravity-monitor');
    process.env.USAGE_MONITOR_DATA_DIR = dir;
    return dir;
  }
  return '';
}

function start(input, options) {
  if (!started) {
    started = (async () => {
      resolveIsolatedDataDir(input);
      const { installBunSqliteShim } = await import('./src/telemetry/index.mjs');
      await installBunSqliteShim();
      const { startMonitorHttpServer } = await import('./src/server/http-server.mjs');
      const port = resolvePort(options);
      const info = await startMonitorHttpServer({ port });
      if (info.listening) {
        console.log(`[magpie-antigravity-monitor] listening on http://127.0.0.1:${info.port}`);
      } else {
        info.ready.then(
          (boundPort) => {
            if (boundPort) {
              console.log(
                `[magpie-antigravity-monitor] listening on http://127.0.0.1:${boundPort}`
              );
            }
          },
          (err) => {
            console.error(
              '[magpie-antigravity-monitor] background bind failed:',
              err?.message || err
            );
          }
        );
      }
      return info;
    })().catch((err) => {
      console.error('[magpie-antigravity-monitor] could not start:', err?.message || err);
      return null;
    });
  }
  return started;
}

export default {
  id: 'magpie-antigravity-monitor',
  server: async (input, options) => {
    await start(input, options);
    return {};
  },
};
