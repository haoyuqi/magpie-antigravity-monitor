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
 * Compatibility shim adapting `bun:sqlite` to the `node:sqlite` `DatabaseSync`
 * interface used by upstream telemetry readers and caches.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Creates a `DatabaseSync`-compatible class backed by a `bun:sqlite` `Database` constructor.
 *
 * @param {typeof import('bun:sqlite').Database} BunDatabase
 * @returns {Function}
 */
export function createBunDatabaseSyncClass(BunDatabase) {
  if (typeof BunDatabase !== 'function') {
    throw new TypeError('Expected a bun:sqlite Database constructor');
  }

  class BunStatementSync {
    #stmt;

    constructor(stmt) {
      this.#stmt = stmt;
    }

    all(...args) {
      return this.#stmt.all(...args);
    }

    get(...args) {
      const row = this.#stmt.get(...args);
      return row === null ? undefined : row;
    }

    run(...args) {
      return this.#stmt.run(...args);
    }
  }

  return class BunDatabaseSync {
    #db;

    constructor(filename, options = {}) {
      const readOnly = Boolean(options?.readOnly);
      const isImmutableUri =
        typeof filename === 'string' &&
        /^file:/i.test(filename) &&
        /[?&]immutable=1(?:&|$)/i.test(filename);

      if (readOnly && (isImmutableUri || Boolean(options?.immutable))) {
        const fsPath = isImmutableUri ? fileURLToPath(filename.split('?')[0]) : filename;
        const buf = Buffer.from(readFileSync(fsPath));
        // Clear WAL format version bytes (18..19) in memory so SQLite deserializes
        // cleanly without touching or creating -wal/-shm sidecar files on disk.
        if (buf.length >= 20 && buf[18] === 2 && buf[19] === 2) {
          buf[18] = 1;
          buf[19] = 1;
        }
        this.#db = new BunDatabase(buf, { readonly: true });
        return;
      }

      const bunOptions = readOnly ? { readonly: true } : { create: true };
      this.#db = new BunDatabase(filename, bunOptions);
    }

    exec(sql) {
      this.#db.exec(sql);
    }

    prepare(sql) {
      return new BunStatementSync(this.#db.prepare(sql));
    }

    close() {
      this.#db.close();
    }
  };
}

/**
 * Installs `globalThis.DatabaseSync` using `bun:sqlite` when running under Bun
 * (where `node:sqlite` is not built in). No-op under Node 22.5+ or if already present.
 *
 * @returns {Promise<{ installed: boolean, source: string }>}
 */
export async function installBunSqliteShim() {
  if (typeof globalThis.DatabaseSync === 'function') {
    return { installed: false, source: 'global' };
  }
  if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
    try {
      const nodeSqlite = process.getBuiltinModule('node:sqlite');
      if (typeof nodeSqlite?.DatabaseSync === 'function') {
        return { installed: false, source: 'node:sqlite' };
      }
    } catch {
      // Ignore missing node:sqlite and fall back to bun:sqlite
    }
  }
  try {
    const bunSqlite = await import('bun:sqlite');
    if (typeof bunSqlite?.Database === 'function') {
      globalThis.DatabaseSync = createBunDatabaseSyncClass(bunSqlite.Database);
      return { installed: true, source: 'bun:sqlite' };
    }
  } catch {
    // Not running under Bun
  }
  return { installed: false, source: 'none' };
}
