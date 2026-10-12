import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initLedgerSchema } from '../db/ledger-schema.js';
import { grantCredits, getCreditBalance } from '../db/credits.js';
import { reserveCredits } from '../db/reservations.js';

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1),(2)');
  initLedgerSchema(db);
  return db;
}
function grant(db, credits = 10, extra = {}) {
  return grantCredits(db, { userId: 1, source: 'topup', sourceRef: 'payment', credits, now: 1000, ...extra });
}
function quote(extra = {}) {
  return { userId: 1, idempotencyKey: 'request-1', requestFingerprint: 'hash-1', action: 'text_to_depth', modelId: 'test-model', resolution: '1K', requestedOutputs: 4, creditsPerOutput: 1, now: 1500, ...extra };
}

test('atomically holds full batch price and records ledger entries', t => {
  const db = setup(t);
  grant(db);
  const result = reserveCredits(db, quote());
  assert.equal(result.created, true);
  assert.equal(result.job.status, 'reserved');
  assert.equal(result.reservations[0].credits_held, 4);
  assert.equal(getCreditBalance(db,1,1500).available, 6);
  assert.equal(getCreditBalance(db,1,1500).reserved, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE entry_type='reserve'").get().n, 1);
});

test('retries return existing job without additional holds; changed terms conflict', t => {
  const db = setup(t);
  grant(db);
  const first = reserveCredits(db,quote());
  const retry = reserveCredits(db,quote({ now: 2000 }));
  assert.equal(retry.created,false);
  assert.equal(retry.job.id,first.job.id);
  for (const extra of [{ requestFingerprint: 'changed' }, { creditsPerOutput: 2 }, { modelId: 'other' }, { requestedOutputs: 1 }]) {
    assert.throws(() => reserveCredits(db,quote(extra)), /JOB_IDEMPOTENCY_CONFLICT/);
  }
  assert.equal(getCreditBalance(db,1,2000).reserved,4);
});

test('insufficient funds creates no job, hold or ledger debit', t => {
  const db = setup(t);
  grant(db,3);
  assert.throws(() => reserveCredits(db,quote()), /INSUFFICIENT_CREDITS/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_reservations').get().n,0);
  assert.equal(getCreditBalance(db,1,1500).available,3);
});

test('uses expiring grants first and excludes expired and future grants', t => {
  const db = setup(t);
  const purchased = grant(db,10);
  grant(db,20,{ source:'promotion',sourceRef:'expired',expiresAt:1500 });
  grant(db,20,{ sourceRef:'future',now:2000 });
  const early = grant(db,2,{ source:'promotion',sourceRef:'early',expiresAt:1800 });
  const later = grant(db,1,{ source:'subscription',sourceRef:'cycle',expiresAt:3000 });
  const result = reserveCredits(db,quote());
  assert.deepEqual(result.reservations.map(r => [r.grant_id,r.credits_held]), [[early.id,2],[later.id,1],[purchased.id,1]]);
});

test('ledger failure rolls back job, allocations and all held balances', t => {
  const db = setup(t);
  grant(db);
  db.exec("CREATE TRIGGER fail_reserve BEFORE INSERT ON credit_ledger WHEN NEW.entry_type='reserve' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => reserveCredits(db,quote()), /injected/);
  assert.equal(getCreditBalance(db,1,1500).available,10);
  assert.equal(getCreditBalance(db,1,1500).reserved,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n,0);
});

test('invalid and cross-user requests cannot spend another balance', t => {
  const db = setup(t);
  grant(db);
  for (const extra of [{ requestedOutputs:5 },{ requestedOutputs:0 },{ creditsPerOutput:-1 },{ creditsPerOutput:1.5 },{ idempotencyKey:' ' },{ action:'invalid' },{ resolution:'8K' },{ now:-1 }]) {
    assert.throws(() => reserveCredits(db,quote(extra)),TypeError);
  }
  assert.throws(() => reserveCredits(db,quote({userId:99})), /UNKNOWN_USER/);
  assert.throws(() => reserveCredits(db,quote({userId:2})), /INSUFFICIENT_CREDITS/);
  assert.equal(getCreditBalance(db,1,1500).available,10);
});

test('two database connections serialize competing jobs and reject overspending', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'depthforge-reserve-'));
  const file = path.join(dir,'test.db');
  const a = new Database(file);
  const b = new Database(file,{timeout:20});
  t.after(() => { b.close(); a.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  for (const db of [a,b]) db.pragma('foreign_keys = ON');
  a.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1)');
  initLedgerSchema(a);
  grant(a,4);
  a.exec('BEGIN IMMEDIATE');
  assert.throws(() => reserveCredits(b,quote()), e => e.code === 'SQLITE_BUSY');
  a.exec('ROLLBACK');
  reserveCredits(a,quote());
  assert.throws(() => reserveCredits(b,quote({idempotencyKey:'request-2'})), /INSUFFICIENT_CREDITS/);
  assert.equal(reserveCredits(b,quote()).created,false);
  assert.equal(getCreditBalance(b,1,1500).reserved,4);
});
