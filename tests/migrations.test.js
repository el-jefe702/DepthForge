import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateDb } from '../db/migrations.js';

function database(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  return db;
}

function exists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function initial() {
  return { version: 1, name: 'create_items', up(db) {
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO items (value) VALUES (?)').run('initial');
  } };
}

test('applies migrations in order and skips them on repeat execution', t => {
  const db = database(t);
  const migrations = [initial(), { version: 2, name: 'add_item', up(db) {
    db.prepare('INSERT INTO items (value) VALUES (?)').run('second');
  } }];
  assert.deepEqual(migrateDb(db, migrations), [1, 2]);
  assert.deepEqual(migrateDb(db, migrations), []);
  assert.deepEqual(db.prepare('SELECT value FROM items ORDER BY id').all(),
    [{ value: 'initial' }, { value: 'second' }]);
  assert.deepEqual(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all(),
    [{ version: 1, name: 'create_items' }, { version: 2, name: 'add_item' }]);
});

test('runs only newly appended migrations', t => {
  const db = database(t);
  const migrations = [initial()];
  migrateDb(db, migrations);
  migrations.push({ version: 2, name: 'create_extra', up(db) {
    db.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)');
  } });
  assert.deepEqual(migrateDb(db, migrations), [2]);
  assert.equal(exists(db, 'extra'), true);
});

test('empty migration list initializes tracking without applying versions', t => {
  const db = database(t);
  assert.deepEqual(migrateDb(db), []);
  assert.equal(exists(db, 'schema_migrations'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 0);
});

test('rolls back all new schema and data on first-run failure', t => {
  const db = database(t);
  assert.throws(() => migrateDb(db, [initial(), { version: 2, name: 'fail', up(db) {
    db.exec('CREATE TABLE transient (id INTEGER PRIMARY KEY)');
    throw new Error('intentional failure');
  } }]), /intentional failure/);
  for (const name of ['items', 'transient', 'schema_migrations']) {
    assert.equal(exists(db, name), false);
  }
  assert.equal(db.inTransaction, false);
});

test('failed upgrade preserves committed versions and rolls back pending work', t => {
  const db = database(t);
  const first = initial();
  migrateDb(db, [first]);
  assert.throws(() => migrateDb(db, [first, { version: 2, name: 'fail_upgrade', up(db) {
    db.prepare('INSERT INTO items (value) VALUES (?)').run('must rollback');
    db.exec('CREATE TABLE transient (id INTEGER PRIMARY KEY)');
    throw new Error('upgrade failed');
  } }]), /upgrade failed/);
  assert.equal(exists(db, 'transient'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all(), [{ version: 1 }]);
  assert.deepEqual(migrateDb(db, [first, { version: 2, name: 'recovered', up(db) {
    db.exec('CREATE TABLE recovered (id INTEGER PRIMARY KEY)');
  } }]), [2]);
});

const invalidLists = [
  ['non-array', null],
  ['zero version', [{ version: 0, name: 'bad', up() {} }]],
  ['negative version', [{ version: -1, name: 'bad', up() {} }]],
  ['fractional version', [{ version: 1.5, name: 'bad', up() {} }]],
  ['unsafe version', [{ version: Number.MAX_SAFE_INTEGER + 1, name: 'bad', up() {} }]],
  ['duplicate version', [initial(), { version: 1, name: 'duplicate', up() {} }]],
  ['descending versions', [{ version: 2, name: 'two', up() {} }, initial()]],
  ['blank name', [{ version: 1, name: ' ', up() {} }]],
  ['missing callback', [{ version: 1, name: 'bad' }]],
];
for (const [label, migrations] of invalidLists) {
  test(`rejects ${label} before creating tables`, t => {
    const db = database(t);
    assert.throws(() => migrateDb(db, migrations), TypeError);
    assert.equal(exists(db, 'schema_migrations'), false);
  });
}

test('rejects unknown applied versions and renamed migrations', t => {
  const db = database(t);
  migrateDb(db, [initial()]);
  assert.throws(() => migrateDb(db, []), /Unknown or changed database migration: 1/);
  assert.throws(() => migrateDb(db, [{ version: 1, name: 'renamed', up() {} }]),
    /Unknown or changed database migration: 1/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
});

test('rejects insertion before an already applied version', t => {
  const db = database(t);
  const later = { version: 2, name: 'later', up(db) {
    db.exec('CREATE TABLE later (id INTEGER PRIMARY KEY)');
  } };
  migrateDb(db, [later]);
  assert.throws(() => migrateDb(db, [initial(), later]),
    /Cannot insert a migration before an applied version/);
  assert.equal(exists(db, 'items'), false);
  assert.equal(exists(db, 'later'), true);
});

test('rejects promise-returning callbacks and rolls back synchronous changes', t => {
  const db = database(t);
  assert.throws(() => migrateDb(db, [{ version: 1, name: 'promise_callback', up(db) {
    db.exec('CREATE TABLE transient (id INTEGER PRIMARY KEY)');
    return Promise.resolve();
  } }]), /Migrations must be synchronous/);
  assert.equal(exists(db, 'transient'), false);
  assert.equal(exists(db, 'schema_migrations'), false);
});
