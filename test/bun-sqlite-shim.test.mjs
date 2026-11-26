import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createBunDatabaseSyncClass,
  installBunSqliteShim,
} from '../src/runtime/bun-sqlite-shim.mjs';
import {
  getNodeSqliteDatabaseSync,
  hasBuiltinNodeSqlite,
  isSqliteDbReadyForRead,
  withReadOnlySqliteDb,
} from '../src/telemetry/sqlite-client.mjs';
import { createTrajectorySqliteLedger } from '../src/telemetry/trajectory-sqlite-ledger.mjs';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ag-mon-sqlite-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Ignore chmod restore errors
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bun-sqlite-shim', () => {
  it('installs a working DatabaseSync shim when running under Bun or keeps node:sqlite', async () => {
    const result = await installBunSqliteShim();
    assert.ok(['node:sqlite', 'bun:sqlite', 'global'].includes(result.source));
    assert.equal(hasBuiltinNodeSqlite(), true);
  });

  it('reads a cleanly closed WAL database with zero sidecar files created', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'closed.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 420);
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(2, 880);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    writer.close();

    // Remove any leftover empty sidecars (e.g. macOS Bun 1.3.14) to simulate a cleanly closed host DB
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const header = readFileSync(dbPath);
    assert.equal(header[18], 2);
    assert.equal(header[19], 2);

    assert.deepEqual(readdirSync(dir), ['closed.db']);
    assert.equal(isSqliteDbReadyForRead(dbPath), true);

    chmodSync(dir, 0o555);
    try {
      const rows = withReadOnlySqliteDb(dbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps WHERE idx >= ? ORDER BY idx ASC').all(1)
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].tokens, 420);
      assert.equal(rows[1].tokens, 880);

      assert.throws(() => {
        withReadOnlySqliteDb(dbPath, (db) => {
          db.exec('INSERT INTO steps (idx, tokens) VALUES (3, 100);');
        });
      });
    } finally {
      chmodSync(dir, 0o755);
    }

    assert.deepEqual(readdirSync(dir), ['closed.db']);
  });

  it('reads live WAL uncommitted rows and stays sidecar-free if host closes mid-read', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'live.db');

    const RealDatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new RealDatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 150);
    writer.exec('PRAGMA wal_checkpoint(FULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(2, 250);

    const hadGlobalDatabaseSync = Object.prototype.hasOwnProperty.call(globalThis, 'DatabaseSync');
    const prevGlobalDatabaseSync = globalThis.DatabaseSync;
    let writerClosed = false;
    try {
      const liveRows = withReadOnlySqliteDb(dbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
      );
      assert.deepEqual(
        liveRows.map((r) => r.tokens),
        [150, 250]
      );

      let simulatedShutdown = false;
      globalThis.DatabaseSync = class RaceSimDatabaseSync extends RealDatabaseSync {
        constructor(filename, opts) {
          assert.notEqual(filename, dbPath);
          if (!simulatedShutdown) {
            simulatedShutdown = true;
            writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            writer.close();
            writerClosed = true;
            rmSync(`${dbPath}-wal`, { force: true });
            rmSync(`${dbPath}-shm`, { force: true });
            assert.deepEqual(readdirSync(dir), ['live.db']);
          }
          super(filename, opts);
        }
      };

      const raceRows = withReadOnlySqliteDb(dbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
      );
      assert.equal(simulatedShutdown, true);
      assert.deepEqual(
        raceRows.map((r) => r.tokens),
        [150, 250]
      );
      assert.deepEqual(readdirSync(dir), ['live.db']);
    } finally {
      if (hadGlobalDatabaseSync) {
        globalThis.DatabaseSync = prevGlobalDatabaseSync;
      } else {
        delete globalThis.DatabaseSync;
      }
      if (!writerClosed) {
        writer.close();
      }
    }
  });

  it('reads orphaned non-empty -wal without -shm without creating -shm in source dir', async () => {
    await installBunSqliteShim();
    const writerDir = makeTempDir();
    const orphanDir = makeTempDir();
    const checkDir = makeTempDir();
    const srcDbPath = join(writerDir, 'orphaned.db');
    const orphanDbPath = join(orphanDir, 'orphaned.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(srcDbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 100);
    writer.exec('PRAGMA wal_checkpoint(FULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(2, 999);

    // Snapshot both .db and -wal together before closing writer so row 2 exists only in -wal
    copyFileSync(srcDbPath, orphanDbPath);
    copyFileSync(`${srcDbPath}-wal`, `${orphanDbPath}-wal`);
    writer.close();

    // Prove row 2 is not present in the main .db file alone
    const onlyDbPath = join(checkDir, 'only.db');
    copyFileSync(orphanDbPath, onlyDbPath);
    const onlyRows = withReadOnlySqliteDb(onlyDbPath, (db) =>
      db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
    );
    assert.deepEqual(
      onlyRows.map((r) => r.tokens),
      [100]
    );

    const beforeFiles = readdirSync(orphanDir).sort();
    assert.deepEqual(beforeFiles, ['orphaned.db', 'orphaned.db-wal']);

    chmodSync(orphanDir, 0o555);
    try {
      const rows = withReadOnlySqliteDb(orphanDbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
      );
      assert.deepEqual(
        rows.map((r) => r.tokens),
        [100, 999]
      );
    } finally {
      chmodSync(orphanDir, 0o755);
    }
    assert.deepEqual(readdirSync(orphanDir).sort(), ['orphaned.db', 'orphaned.db-wal']);
  });

  it('retries when writer checkpoints and commits between .db and -wal reads, never returning mixed state', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'checkpoint-retry.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 100);
    writer.exec('PRAGMA wal_checkpoint(FULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(2, 200);

    let writerClosed = false;
    try {
      const attempts = [];
      const rows = withReadOnlySqliteDb(
        dbPath,
        (db) => db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all(),
        {
          _onAfterDbSnapshot: (attempt) => {
            attempts.push(attempt);
            if (attempt === 0) {
              writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
              writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(3, 300);
            }
          },
        }
      );

      assert.ok(attempts.length >= 2);
      assert.deepEqual(
        rows.map((r) => r.tokens),
        [100, 200, 300]
      );

      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      writer.close();
      writerClosed = true;
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });

      assert.deepEqual(readdirSync(dir), ['checkpoint-retry.db']);
      const postCloseRows = withReadOnlySqliteDb(dbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
      );
      assert.deepEqual(
        postCloseRows.map((r) => r.tokens),
        [100, 200, 300]
      );
      assert.deepEqual(readdirSync(dir), ['checkpoint-retry.db']);
    } finally {
      if (!writerClosed) {
        writer.close();
      }
    }
  });

  it('skips the read round (returns null) when concurrent checkpoints persist across all snapshot attempts', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'checkpoint-skip.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 100);
    writer.exec('PRAGMA wal_checkpoint(FULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(2, 200);

    let writerClosed = false;
    try {
      let queryCalls = 0;
      let nextIdx = 3;
      const result = withReadOnlySqliteDb(
        dbPath,
        (db) => {
          queryCalls += 1;
          return db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all();
        },
        {
          maxSnapshotAttempts: 3,
          _onAfterDbSnapshot: () => {
            writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(nextIdx, nextIdx * 100);
            nextIdx += 1;
          },
        }
      );

      assert.equal(result, null);
      assert.equal(queryCalls, 0);

      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      writer.close();
      writerClosed = true;
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });

      assert.deepEqual(readdirSync(dir), ['checkpoint-skip.db']);
      const cleanRows = withReadOnlySqliteDb(dbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
      );
      assert.deepEqual(
        cleanRows.map((r) => r.tokens),
        [100, 200, 300, 400, 500]
      );
      assert.deepEqual(readdirSync(dir), ['checkpoint-skip.db']);
    } finally {
      if (!writerClosed) {
        writer.close();
      }
    }
  });

  it('keeps multi-query reads atomic on an initially empty-WAL DB when writer updates and checkpoints mid-read', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'empty-wal-atomic.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('CREATE TABLE t_a (id INTEGER PRIMARY KEY, val INTEGER NOT NULL);');
    writer.exec('CREATE TABLE t_b (id INTEGER PRIMARY KEY, val INTEGER NOT NULL);');
    writer.prepare('INSERT INTO t_a (id, val) VALUES (?, ?)').run(1, 1);
    writer.prepare('INSERT INTO t_b (id, val) VALUES (?, ?)').run(1, 1);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    let writerClosed = false;
    try {
      const pair = withReadOnlySqliteDb(dbPath, (db) => {
        const a = db.prepare('SELECT val FROM t_a WHERE id = 1').get()?.val;
        writer.exec(
          'BEGIN IMMEDIATE; UPDATE t_a SET val = 2 WHERE id = 1; UPDATE t_b SET val = 2 WHERE id = 1; COMMIT;'
        );
        writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        const b = db.prepare('SELECT val FROM t_b WHERE id = 1').get()?.val;
        return [a, b];
      });
      assert.deepEqual(pair, [1, 1]);

      const updatedPair = withReadOnlySqliteDb(dbPath, (db) => [
        db.prepare('SELECT val FROM t_a WHERE id = 1').get()?.val,
        db.prepare('SELECT val FROM t_b WHERE id = 1').get()?.val,
      ]);
      assert.deepEqual(updatedPair, [2, 2]);

      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      writer.close();
      writerClosed = true;
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });

      assert.deepEqual(readdirSync(dir), ['empty-wal-atomic.db']);
      const postClosePair = withReadOnlySqliteDb(dbPath, (db) => [
        db.prepare('SELECT val FROM t_a WHERE id = 1').get()?.val,
        db.prepare('SELECT val FROM t_b WHERE id = 1').get()?.val,
      ]);
      assert.deepEqual(postClosePair, [2, 2]);
      assert.deepEqual(readdirSync(dir), ['empty-wal-atomic.db']);
    } finally {
      if (!writerClosed) {
        writer.close();
      }
    }
  });

  it('handles WAL transitioning from empty to non-empty during snapshot without mixed state', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'empty-to-nonempty.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    writer.exec('CREATE TABLE t_a (id INTEGER PRIMARY KEY, val INTEGER NOT NULL);');
    writer.exec('CREATE TABLE t_b (id INTEGER PRIMARY KEY, val INTEGER NOT NULL);');
    writer.prepare('INSERT INTO t_a (id, val) VALUES (?, ?)').run(1, 1);
    writer.prepare('INSERT INTO t_b (id, val) VALUES (?, ?)').run(1, 1);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');

    let writerClosed = false;
    try {
      // Sub-case A: -wal becomes non-empty between .db snapshot and -wal snapshot without checkpoint
      const pairA = withReadOnlySqliteDb(
        dbPath,
        (db) => [
          db.prepare('SELECT val FROM t_a WHERE id = 1').get()?.val,
          db.prepare('SELECT val FROM t_b WHERE id = 1').get()?.val,
        ],
        {
          _onAfterDbSnapshot: (attempt) => {
            if (attempt === 0) {
              writer.exec(
                'BEGIN IMMEDIATE; UPDATE t_a SET val = 2 WHERE id = 1; UPDATE t_b SET val = 2 WHERE id = 1; COMMIT;'
              );
            }
          },
        }
      );
      assert.deepEqual(pairA, [2, 2]);

      // Reset to empty -wal at (3, 3)
      writer.exec(
        'BEGIN IMMEDIATE; UPDATE t_a SET val = 3 WHERE id = 1; UPDATE t_b SET val = 3 WHERE id = 1; COMMIT;'
      );
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');

      // Sub-case B: -wal is empty at start, then writer commits (4,4), checkpoints, and commits (5,5)
      const attempts = [];
      const pairB = withReadOnlySqliteDb(
        dbPath,
        (db) => [
          db.prepare('SELECT val FROM t_a WHERE id = 1').get()?.val,
          db.prepare('SELECT val FROM t_b WHERE id = 1').get()?.val,
        ],
        {
          _onAfterDbSnapshot: (attempt) => {
            attempts.push(attempt);
            if (attempt === 0) {
              writer.exec(
                'BEGIN IMMEDIATE; UPDATE t_a SET val = 4 WHERE id = 1; UPDATE t_b SET val = 4 WHERE id = 1; COMMIT;'
              );
              writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
              writer.exec(
                'BEGIN IMMEDIATE; UPDATE t_a SET val = 5 WHERE id = 1; UPDATE t_b SET val = 5 WHERE id = 1; COMMIT;'
              );
            }
          },
        }
      );
      assert.ok(attempts.length >= 2);
      assert.deepEqual(pairB, [5, 5]);

      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      writer.close();
      writerClosed = true;
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });

      assert.deepEqual(readdirSync(dir), ['empty-to-nonempty.db']);
      const postClosePair = withReadOnlySqliteDb(dbPath, (db) => [
        db.prepare('SELECT val FROM t_a WHERE id = 1').get()?.val,
        db.prepare('SELECT val FROM t_b WHERE id = 1').get()?.val,
      ]);
      assert.deepEqual(postClosePair, [5, 5]);
      assert.deepEqual(readdirSync(dir), ['empty-to-nonempty.db']);
    } finally {
      if (!writerClosed) {
        writer.close();
      }
    }
  });

  it('trajectory SQLite ledger falls back to query_only when readOnly hits SQLITE_CANTOPEN on closed WAL', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const sqliteFilePath = join(dir, 'trajectory_store.sqlite');

    const seedLedger = createTrajectorySqliteLedger({ sqliteFilePath });
    seedLedger.openAndHydrateInitial();
    seedLedger.flushDeltaBatch({
      upserts: [
        {
          cascadeId: 'conv-1',
          entry: {
            title: 'Test',
            steps: [{ stepIndex: 1, inputTokens: 10, outputTokens: 5 }],
          },
        },
      ],
    });

    const prevGlobalDbSync = globalThis.DatabaseSync;
    const RealDbSync = getNodeSqliteDatabaseSync();
    let readOnlyCantOpenCount = 0;
    let sawQueryOnlyPragma = false;

    globalThis.DatabaseSync = class WrappedDbSync extends RealDbSync {
      constructor(dbPath, opts) {
        if (opts !== undefined) {
          super(dbPath, opts);
        } else {
          super(dbPath);
        }
        if (opts?.readOnly) {
          this.prepare = () => {
            readOnlyCantOpenCount += 1;
            throw Object.assign(new Error('unable to open database file'), {
              errcode: 14,
              code: 'ERR_SQLITE_ERROR',
            });
          };
        } else {
          const origExec = this.exec.bind(this);
          this.exec = (sql) => {
            if (/PRAGMA\s+query_only\s*=\s*ON/i.test(String(sql || ''))) {
              sawQueryOnlyPragma = true;
            }
            return origExec(sql);
          };
        }
      }
    };

    try {
      const readLedger = createTrajectorySqliteLedger({ sqliteFilePath });
      const hydrated = readLedger.openAndHydrateInitial();
      assert.ok(readOnlyCantOpenCount >= 1);
      assert.equal(sawQueryOnlyPragma, true);
      assert.equal(hydrated.cacheObj['conv-1']?.title, 'Test');
      assert.equal(hydrated.cacheObj['conv-1']?.steps?.length, 1);
    } finally {
      if (prevGlobalDbSync === undefined) {
        delete globalThis.DatabaseSync;
      } else {
        globalThis.DatabaseSync = prevGlobalDbSync;
      }
    }
  });

  it('createBunDatabaseSyncClass rejects non-constructor inputs', () => {
    assert.throws(() => createBunDatabaseSyncClass(null), TypeError);
  });
});
