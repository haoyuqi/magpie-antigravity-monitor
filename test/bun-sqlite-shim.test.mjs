import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createBunDatabaseSyncClass,
  installBunSqliteShim,
} from '../src/runtime/bun-sqlite-shim.mjs';
import {
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
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('bun-sqlite-shim', () => {
  it('installs a working DatabaseSync shim when running under Bun or keeps node:sqlite', async () => {
    const result = await installBunSqliteShim();
    assert.ok(['node:sqlite', 'bun:sqlite', 'global'].includes(result.source));
    assert.equal(hasBuiltinNodeSqlite(), true);
  });

  it('reads a WAL-mode SQLite database in readOnly mode and rejects writes', async () => {
    await installBunSqliteShim();
    const dir = makeTempDir();
    const dbPath = join(dir, 'sample.db');

    const DatabaseSync = globalThis.DatabaseSync || (await import('node:sqlite')).DatabaseSync;
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL;');
    writer.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, tokens INTEGER NOT NULL);');
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(1, 420);
    writer.prepare('INSERT INTO steps (idx, tokens) VALUES (?, ?)').run(2, 880);
    writer.close();

    assert.equal(isSqliteDbReadyForRead(dbPath), true);

    const rows = withReadOnlySqliteDb(dbPath, (db) =>
      db.prepare('SELECT idx, tokens FROM steps WHERE idx >= ? ORDER BY idx ASC').all(1)
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].idx, 1);
    assert.equal(rows[0].tokens, 420);
    assert.equal(rows[1].tokens, 880);

    assert.throws(() => {
      withReadOnlySqliteDb(dbPath, (db) => {
        db.exec('INSERT INTO steps (idx, tokens) VALUES (3, 100);');
      });
    });
  });

  it('createBunDatabaseSyncClass rejects non-constructor inputs', () => {
    assert.throws(() => createBunDatabaseSyncClass(null), TypeError);
  });
});
