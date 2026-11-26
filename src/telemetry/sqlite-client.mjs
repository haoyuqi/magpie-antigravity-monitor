/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview 零业务依赖的本地 SQLite + WAL 非阻塞只读短连接原语 (`sqlite-client.mjs`)。
 *
 * 核心能力：
 * 1. 惰性加载 Node 22.5+ 内置 `node:sqlite`，自动静默实验特性告警，避免污染 CLI / MCP `stdio`；
 * 2. 组合主库 `.db` 与 `.db-wal` 的 `mtime + size` 生成复合签名（忽略易抖动的 `-shm` 共享内存头），精准感知未 checkpoint 的实时写入；
 * 3. 采用短连接 + `PRAGMA busy_timeout = 1000` + `SQLITE_BUSY` 瞬时锁重试并在 `finally` 中立即释放句柄，绝不阻塞宿主 WAL checkpoint。
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
 * 惰性获取 Node 内置 `node:sqlite` 的 `DatabaseSync` 构造器（兼容测试沙箱注入的 `globalThis.DatabaseSync`）。
 * 首次加载时静默过滤 Node 22 的实验特性告警；当前运行时不支持时返回 `null`。
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
 * 当前运行时是否具备内置 `node:sqlite` 读取能力。
 *
 * @returns {boolean}
 */
export function hasBuiltinNodeSqlite() {
  return Boolean(getNodeSqliteDatabaseSync());
}

/**
 * 通过零 SQLite 锁的 100 字节文件头探测判断本地 `.db` 是否已完成表结构初始化（或已切入 WAL 且含有效提交帧）。
 *
 * Windows 下宿主（如 `agy` CLI）新建 `<cid>.db` 执行 `schema init` / `PRAGMA journal_mode = WAL` 的数毫秒内，
 * 若外部进程对 0 字节或仍处于回滚日志模式（`writeVersion !== 2`）的库发起 `sqlite3_open_v2` 查询并持有 `SHARED` 锁，
 * 会直接触发宿主 `trajectory db schema init: database is locked` 并迫使整场会话永久降级至加密 `.pb`。
 * 纯 `fs.openSync` / `fs.readSync` 不申请任何 SQLite 字节区间锁（`LockFileEx`），可安全跳过初始化途中的半成品库。
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
    // 忽略瞬时回滚日志探测异常
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
        // 忽略关闭异常
      }
    }
  }
}

/**
 * 计算 SQLite 主库与 `.db-wal` 预写日志的复合签名（忽略易抖动的 `-shm` 共享内存头），精准感知未 checkpoint 的实时写入。
 * 实际打开前由 `withReadOnlySqliteDb` 经 `isSqliteDbReadyForRead` 拦截未完成 `schema init` 的空文件。
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
  // 0 字节的空 .db-wal 不含未 checkpoint 事务帧，忽略其 mtime 避免只读打开或宿主 LRU 驱逐触发死循环重扫
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
 * 以只读模式打开 SQLite 数据库执行查询并在 `finally` 中立即关闭连接，避免长连接阻塞宿主 WAL checkpoint。
 * 打开前先执行无锁头部就绪校验；存在活跃 WAL 时采用双栅栏一致性快照并在瞬时变化/锁竞争时有限重试，无法确认一致性则跳过本轮读取。
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
        // 兼容最小测试桩
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
          // 忽略关闭异常
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
 * 归一化 SQLite `TEXT` 时间列（如 `'2026-11-18 08:12:00+00:00'` -> ISO-8601），剔除零值哨兵时间。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSqliteIsoTime(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('0001-01-01') || raw.startsWith('1970-01-01 00:00:00')) return '';
  return raw.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T').replace(/\+00:00$/, 'Z');
}
