import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initLedgerSchema } from '../db/ledger-schema.js';

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1), (2)');
  initLedgerSchema(db);
  return db;
}
function grant(db, user = 1, ref = 'purchase-1') {
  return Number(db.prepare("INSERT INTO credit_grants (user_id, source, source_ref, credits_total, credits_available) VALUES (?, 'topup', ?, 10, 10)").run(user, ref).lastInsertRowid);
}
function job(db, user = 1, key = 'job-1') {
  return Number(db.prepare("INSERT INTO generation_jobs (user_id,idempotency_key,request_fingerprint,action,model_id,resolution,requested_outputs,credits_per_output) VALUES (?, ?, 'fingerprint', 'text_to_depth', 'test-model', '1K', 4, 1)").run(user,key).lastInsertRowid);
}
function reservation(db, user, jobId, grantId) {
  return Number(db.prepare('INSERT INTO credit_reservations (user_id,job_id,grant_id,credits_held) VALUES (?,?,?,4)').run(user,jobId,grantId).lastInsertRowid);
}

test('creates tables and indexes and migration is repeatable', t => {
  const db = setup(t);
  assert.deepEqual(initLedgerSchema(db), []);
  for (const name of ['credit_grants','generation_jobs','credit_reservations','credit_ledger']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }
  for (const name of ['idx_grants_spend','idx_jobs_status','idx_ledger_user']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('requires foreign key enforcement', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = OFF');
  assert.throws(() => initLedgerSchema(db), /foreign_keys/);
});

test('purchased credits have no expiry and cannot be fractional or oversubscribed', t => {
  const db = setup(t);
  const id = grant(db);
  assert.equal(db.prepare('SELECT expires_at FROM credit_grants WHERE id=?').get(id).expires_at, null);
  assert.throws(() => db.prepare('UPDATE credit_grants SET expires_at=unixepoch()+3600 WHERE id=?').run(id));
  assert.throws(() => db.prepare('UPDATE credit_grants SET credits_available=1.5 WHERE id=?').run(id));
  assert.throws(() => db.prepare('UPDATE credit_grants SET credits_reserved=1 WHERE id=?').run(id));
  assert.throws(() => db.prepare('UPDATE credit_grants SET credits_available=-1 WHERE id=?').run(id));
});

test('source references are unique and unknown users are rejected', t => {
  const db = setup(t);
  grant(db);
  assert.throws(() => grant(db));
  assert.throws(() => grant(db,99,'missing-user'));
});

test('job idempotency is scoped to user and output count is constrained', t => {
  const db = setup(t);
  const id = job(db);
  assert.throws(() => job(db));
  assert.ok(job(db,2));
  assert.throws(() => db.prepare('UPDATE generation_jobs SET delivered_outputs=5 WHERE id=?').run(id));
  assert.throws(() => db.prepare('UPDATE generation_jobs SET requested_outputs=1.5 WHERE id=?').run(id));
});

test('reservations cannot mix owners and settlement must balance', t => {
  const db = setup(t);
  const g = grant(db);
  const j = job(db);
  const other = grant(db,2,'other');
  assert.throws(() => reservation(db,1,j,other));
  const r = reservation(db,1,j,g);
  assert.throws(() => reservation(db,1,j,g));
  assert.throws(() => db.prepare("UPDATE credit_reservations SET status='settled', credits_consumed=3 WHERE id=?").run(r));
  db.prepare("UPDATE credit_reservations SET status='settled', credits_consumed=3, credits_released=1 WHERE id=?").run(r);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('ledger is append-only, idempotent and ownership constrained', t => {
  const db = setup(t);
  const g = grant(db);
  const j = job(db);
  const r = reservation(db,1,j,g);
  const insert = db.prepare("INSERT INTO credit_ledger (user_id,grant_id,job_id,reservation_id,entry_type,credits,event_key) VALUES (?,?,?,?, 'reserve',4,?)");
  insert.run(1,g,j,r,'hold-1');
  assert.throws(() => insert.run(1,g,j,r,'hold-1'));
  assert.throws(() => insert.run(2,g,j,r,'wrong-owner'));
  assert.throws(() => insert.run(1,g,j,null,'missing-reservation'));
  assert.throws(() => db.exec('UPDATE credit_ledger SET credits=2'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM credit_ledger'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM users WHERE id=1'));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('refund grant requires a valid original ledger reference', t => {
  const db = setup(t);
  const g = grant(db);
  const original = db.prepare("INSERT INTO credit_ledger (user_id,grant_id,entry_type,credits,event_key) VALUES (1,?,'grant',10,'original')").run(g).lastInsertRowid;
  const insert = db.prepare("INSERT INTO credit_grants (user_id,source,source_ref,credits_total,credits_available,refund_of_ledger_id) VALUES (1,'refund',?,1,1,?)");
  assert.throws(() => insert.run('missing',null));
  assert.throws(() => insert.run('invalid',999));
  insert.run('refund-1',original);
});
