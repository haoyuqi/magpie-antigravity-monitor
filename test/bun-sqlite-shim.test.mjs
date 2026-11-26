import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    writer.close();

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

  it('reads live WAL uncommitted rows while writer holds -wal and -shm', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'live.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 150);

    try {
      const rows = withReadOnlySqliteDb(dbPath, (db) =>
        db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tokens, 150);
    } finally {
      writer.close();
    }
  });

  it('reads orphaned non-empty -wal without -shm without creating -shm in source dir', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'orphaned.db');

    const DatabaseSync = getNodeSqliteDatabaseSync();
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 999);
    // Remove -shm while keeping -wal open/non-empty? Instead snapshot-remove -shm after close?
    // Re-create via a writer that checkpoints nothing, then copy -wal before close.
    const rowsBeforeClose = writer.prepare('SELECT idx, tokens FROM steps').all();
    assert.equal(rowsBeforeClose.length, 1);
    // Keep -wal alongside -db by copying before close
    const { copyFileSync } = await import('node:fs');
    const savedWal = join(dir, 'saved.wal');
    copyFileSync(`${dbPath}-wal`, savedWal);
    writer.close();

    // Restore orphaned non-empty -wal with no -shm present
    const { renameSync } = await import('node:fs');
    renameSync(savedWal, `${dbPath}-wal`);
    rmSync(`${dbPath}-shm`, { force: true });

    const beforeFiles = readdirSync(dir).sort();
    assert.deepEqual(beforeFiles, ['orphaned.db', 'orphaned.db-wal']);

    const rows = withReadOnlySqliteDb(dbPath, (db) =>
      db.prepare('SELECT idx, tokens FROM steps ORDER BY idx ASC').all()
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokens, 999);
    assert.deepEqual(readdirSync(dir).sort(), ['orphaned.db', 'orphaned.db-wal']);
  });

  it('createBunDatabaseSyncClass rejects non-constructor inputs', () => {
    assert.throws(() => createBunDatabaseSyncClass(null), TypeError);
  });
});
