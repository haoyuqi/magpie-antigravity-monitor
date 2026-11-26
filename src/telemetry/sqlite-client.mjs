/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Zero-dependency local SQLite + WAL non-blocking read-only short-lived connection primitives (`sqlite-client.mjs`).
 *
 * Core capabilities:
 * 1. Lazily load Node 22.5+ built-in `node:sqlite`, silently suppressing experimental feature warnings to avoid polluting CLI / MCP `stdio`;
 * 2. Combine `mtime + size` of the main `.db` and `.db-wal` into a composite signature (ignoring the jittery `-shm` shared memory header) to accurately detect uncheckpointed live writes;
 * 3. Use short-lived connections + `PRAGMA busy_timeout = 1000` + transient `SQLITE_BUSY` lock retries and immediately release handles in `finally`, never blocking host WAL checkpoints.
 */

import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SQLITE_IN_CHUNK_SIZE = 400;
const SQLITE_MIN_READY_BYTES = 4096;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_MAGIC_PREFIX = 'SQLite format 3\0';
const MAX_SQLITE_READY_MEMO = 512;
const sqliteWalReadyMemo = new Map();

let sqliteResolved = false;
let sqliteDatabaseSyncCtor = null;

/**
 * Lazily obtain the `DatabaseSync` constructor from Node's built-in `node:sqlite` (compatible with test-sandbox-injected `globalThis.DatabaseSync`).
 * Silently filters Node 22 experimental feature warnings on first load; returns `null` if unsupported by the current runtime.
 *
 * @returns {Function | null}
 */
export function getNodeSqliteDatabaseSync() {
  if (typeof globalThis.DatabaseSync === 'function') {
    return globalThis.DatabaseSync;
  }
  if (sqliteResolved) return sqliteDatabaseSyncCtor;
  sqliteResolved = true;
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return null;
  }
  const origEmitWarning = process.emitWarning;
  try {
    if (typeof origEmitWarning === 'function') {
      process.emitWarning = function filteredSqliteWarning(warning, ...rest) {
        const msg = typeof warning === 'string' ? warning : String(warning?.message || '');
        if (/SQLite is an experimental feature/i.test(msg)) return;
        return origEmitWarning.call(this, warning, ...rest);
      };
    }
    const mod = process.getBuiltinModule('node:sqlite');
    sqliteDatabaseSyncCtor = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    sqliteDatabaseSyncCtor = null;
  } finally {
    if (typeof origEmitWarning === 'function') {
      process.emitWarning = origEmitWarning;
    }
  }
  return sqliteDatabaseSyncCtor;
}

/**
 * Whether the current runtime has built-in `node:sqlite` read capability.
 *
 * @returns {boolean}
 */
export function hasBuiltinNodeSqlite() {
  return Boolean(getNodeSqliteDatabaseSync());
}

/**
 * Determine whether a local `.db` has completed schema initialization (or has switched to WAL with valid committed frames) via a zero-SQLite-lock 100-byte header probe.
 *
 * On Windows, within the few milliseconds while the host (e.g., `agy` CLI) creates `<cid>.db` and runs `schema init` / `PRAGMA journal_mode = WAL`,
 * if an external process issues a `sqlite3_open_v2` query against a 0-byte DB or one still in rollback journal mode (`writeVersion !== 2`) and holds a `SHARED` lock,
 * it directly triggers `trajectory db schema init: database is locked` in the host and forces the entire session to permanently downgrade to encrypted `.pb`.
 * Pure `fs.openSync` / `fs.readSync` acquires no SQLite byte-range locks (`LockFileEx`), safely skipping half-initialized databases.
 *
 * @param {string} dbPath
 * @param {{ dbStat?: import('node:fs').Stats | null, walStat?: import('node:fs').Stats | null, skipWalStat?: boolean }} [opts={}]
 * @returns {boolean}
 */
export function isSqliteDbReadyForRead(
  dbPath,
  { dbStat: preDbStat = null, walStat: preWalStat = null, skipWalStat = false } = {}
) {
  if (!dbPath || typeof dbPath !== 'string') return false;
  if (
    typeof openSync !== 'function' ||
    typeof readSync !== 'function' ||
    typeof closeSync !== 'function'
  ) {
    return typeof globalThis.DatabaseSync === 'function';
  }

  let dbStat = preDbStat;
  if (!dbStat) {
    try {
      dbStat = statSync(dbPath, { throwIfNoEntry: false });
    } catch {
      return false;
    }
  }
  const dbSize = Number(dbStat?.size || 0);
  if (!dbStat || dbSize < SQLITE_MIN_READY_BYTES) {
    sqliteWalReadyMemo.delete(dbPath);
    return false;
  }

  const birthKey = `${Number(dbStat.birthtimeMs || 0)}:${Number(dbStat.ino || 0)}`;
  const cachedReady = sqliteWalReadyMemo.get(dbPath);
  if (cachedReady && cachedReady.birthKey === birthKey && dbSize >= cachedReady.minVerifiedSize) {
    return true;
  }

  try {
    const journalStat = statSync(`${dbPath}-journal`, { throwIfNoEntry: false });
    if (journalStat && Number(journalStat.size || 0) > 0) {
      return false;
    }
  } catch {
    // Ignore transient rollback journal probe errors
  }

  let fd = -1;
  try {
    fd = openSync(dbPath, 'r');
    const header = Buffer.allocUnsafe(SQLITE_HEADER_BYTES);
    const bytesRead = readSync(fd, header, 0, SQLITE_HEADER_BYTES, 0);
    if (bytesRead < SQLITE_HEADER_BYTES) return false;
    if (header.toString('latin1', 0, 16) !== SQLITE_MAGIC_PREFIX) return false;

    const writeVersion = header[18];
    const readVersion = header[19];
    const pageCount = header.readUInt32BE(28);
    const schemaCookie = header.readUInt32BE(40);
    const isWalMode = writeVersion === 2 && readVersion === 2;

    if (isWalMode) {
      let hasCommittedSchema = pageCount >= 2 && schemaCookie > 0;
      if (!hasCommittedSchema) {
        let walStat = preWalStat;
        if (!walStat && !skipWalStat) {
          try {
            walStat = statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
          } catch {
            walStat = null;
          }
        }
        hasCommittedSchema = Number(walStat?.size || 0) > SQLITE_WAL_HEADER_BYTES;
      }
      if (!hasCommittedSchema) return false;

      if (sqliteWalReadyMemo.size >= MAX_SQLITE_READY_MEMO && !sqliteWalReadyMemo.has(dbPath)) {
        const oldestKey = sqliteWalReadyMemo.keys().next().value;
        if (oldestKey !== undefined) sqliteWalReadyMemo.delete(oldestKey);
      }
      sqliteWalReadyMemo.set(dbPath, {
        birthKey,
        minVerifiedSize: SQLITE_MIN_READY_BYTES,
      });
      return true;
    }

    return pageCount >= 2 && schemaCookie > 0;
  } catch {
    return false;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Compute a composite signature of the SQLite main DB and `.db-wal` write-ahead log (ignoring the jittery `-shm` shared memory header) to accurately detect uncheckpointed live writes.
 * Before actually opening, `withReadOnlySqliteDb` intercepts empty files that have not completed `schema init` via `isSqliteDbReadyForRead`.
 *
 * @param {string} dbPath
 * @returns {{ exists: boolean, mtimeMs: number, sig: string }}
 */
export function computeSqliteWalSig(dbPath, { skipWalCheck = false } = {}) {
  if (!dbPath || typeof dbPath !== 'string') {
    return { exists: false, mtimeMs: 0, sig: '' };
  }
  let dbStat = null;
  try {
    dbStat = statSync(dbPath, { throwIfNoEntry: false });
  } catch {
    return { exists: false, mtimeMs: 0, sig: '' };
  }
  if (!dbStat) return { exists: false, mtimeMs: 0, sig: '' };

  let walStat = null;
  if (!skipWalCheck) {
    try {
      walStat = statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    } catch {
      walStat = null;
    }
  }
  const dbMtimeMs = Number(dbStat.mtimeMs || 0);
  const dbSize = Number(dbStat.size || 0);
  const walSize = Number(walStat?.size || 0);
  // A 0-byte empty .db-wal contains no uncheckpointed transaction frames; ignore its mtime to prevent read-only opens or host LRU eviction from triggering infinite rescan loops
  const walMtimeMs = walSize > 0 ? Number(walStat?.mtimeMs || 0) : 0;
  return {
    exists: true,
    mtimeMs: Math.max(dbMtimeMs, walMtimeMs),
    sig: `${Math.floor(dbMtimeMs)}:${dbSize}|${Math.floor(walMtimeMs)}:${walSize}`,
  };
}

export function isSqliteBusyError(err) {
  const msg = String(err?.message || err?.code || '');
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

function isSqliteTransientSnapshotError(err) {
  const msg = String(err?.message || err?.code || '');
  return /SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_IOERR|database disk image is malformed/i.test(msg);
}

function toImmutableSqliteUri(dbPath) {
  const url = pathToFileURL(resolve(dbPath));
  url.searchParams.set('immutable', '1');
  return url.href;
}

const MAX_WAL_SNAPSHOT_ATTEMPTS = 3;

function readFileSnapshot(filePath, { optional = false } = {}) {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    let st;
    try {
      st = fstatSync(fd, { bigint: true });
    } catch {
      st = fstatSync(fd);
    }
    const expectedSize = Number(st.size || 0);
    const chunks = [];
    let offset = 0;
    const chunkSize = Math.max(4096, Math.min(expectedSize || 4096, 1024 * 1024));
    const buf = Buffer.allocUnsafe(chunkSize);
    while (true) {
      const bytesRead = readSync(fd, buf, 0, buf.length, offset);
      if (bytesRead <= 0) break;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      offset += bytesRead;
    }
    const content = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    return {
      exists: true,
      ino: String(st.ino ?? 0),
      size: content.length,
      mtimeKey: String(st.mtimeNs ?? st.mtimeMs ?? 0),
      content,
    };
  } catch (err) {
    if (optional && err?.code === 'ENOENT') {
      return { exists: false, ino: '0', size: 0, mtimeKey: '0', content: null };
    }
    throw err;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

function snapshotsMatch(a, b) {
  if (!a || !b || a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return (
    String(a.ino) === String(b.ino) &&
    a.size === b.size &&
    a.mtimeKey === b.mtimeKey &&
    a.content.equals(b.content)
  );
}

/**
 * Open the SQLite database in read-only mode to execute a query and immediately close the connection in `finally`, avoiding long-lived connections that block host WAL checkpoints.
 * Performs a lock-free header readiness check before opening; when an active WAL exists, takes a double-fenced consistency snapshot with bounded retries on transient changes/lock contention, and skips this read round if consistency cannot be confirmed.
 *
 * @template T
 * @param {string} dbPath
 * @param {(db: any) => T} queryFn
 * @param {{ maxSnapshotAttempts?: number, _onAfterDbSnapshot?: (attempt: number) => void }} [options={}]
 * @returns {T | null}
 */
export function withReadOnlySqliteDb(dbPath, queryFn, options = {}) {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return null;
  if (!isSqliteDbReadyForRead(dbPath)) return null;

  const maxSnapshotAttempts = Math.max(
    1,
    Number(options?.maxSnapshotAttempts) || MAX_WAL_SNAPSHOT_ATTEMPTS
  );
  const onAfterDbSnapshot =
    typeof options?._onAfterDbSnapshot === 'function' ? options._onAfterDbSnapshot : null;

  for (let attempt = 0; attempt < maxSnapshotAttempts; attempt++) {
    let db = null;
    let tempWalDir = '';
    try {
      // Always read a double-fenced snapshot of .db and optional -wal into memory,
      // verify neither changed across the pair of reads, then open the private copy.
      const dbSnap1 = readFileSnapshot(dbPath);
      if (onAfterDbSnapshot) {
        onAfterDbSnapshot(attempt);
      }
      const walSnap1 = readFileSnapshot(`${dbPath}-wal`, { optional: true });
      const dbSnap2 = readFileSnapshot(dbPath);
      const walSnap2 = readFileSnapshot(`${dbPath}-wal`, { optional: true });
      if (!snapshotsMatch(dbSnap1, dbSnap2) || !snapshotsMatch(walSnap1, walSnap2)) {
        continue;
      }

      tempWalDir = mkdtempSync(join(tmpdir(), 'ag-mon-wal-'));
      const tempDbPath = join(tempWalDir, basename(dbPath));
      writeFileSync(tempDbPath, dbSnap1.content);
      if (walSnap1.exists && walSnap1.content.length > 0) {
        writeFileSync(`${tempDbPath}-wal`, walSnap1.content);
        db = new DatabaseSync(tempDbPath, { readOnly: true });
      } else {
        db = new DatabaseSync(toImmutableSqliteUri(tempDbPath), { readOnly: true });
      }
      try {
        db.exec('PRAGMA busy_timeout = 1000;');
      } catch {
        // Compatible with minimal test stubs
      }
      return queryFn(db);
    } catch (err) {
      if (
        attempt + 1 < maxSnapshotAttempts &&
        (isSqliteBusyError(err) || (tempWalDir && isSqliteTransientSnapshotError(err)))
      ) {
        continue;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close errors
        }
      }
      if (tempWalDir) {
        try {
          rmSync(tempWalDir, { recursive: true, force: true });
        } catch {
          // Ignore temp cleanup errors
        }
      }
    }
  }
  return null;
}

/**
 * Normalize SQLite `TEXT` timestamp columns (e.g. `'2026-11-18 08:12:00+00:00'` -> ISO-8601), stripping zero-value sentinel timestamps.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSqliteIsoTime(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('0001-01-01') || raw.startsWith('1970-01-01 00:00:00')) return '';
  return raw.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T').replace(/\+00:00$/, 'Z');
}
