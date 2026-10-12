import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initLedgerSchema } from '../db/ledger-schema.js';
import { grantCredits, getCreditBalance } from '../db/credits.js';

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1),(2)');
  initLedgerSchema(db);
  return db;
}
function topup(overrides = {}) {
  return { userId: 1, source: 'topup', sourceRef: 'payment-1', credits: 25, now: 1000, ...overrides };
}

test('creates grant and ledger atomically with no purchased expiry', t => {
  const db = setup(t);
  const g = grantCredits(db, topup());
  assert.equal(g.expires_at, null);
  assert.equal(getCreditBalance(db, 1, 1000).available, 25);
  const entries = db.prepare('SELECT * FROM credit_ledger').all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].grant_id, g.id);
  assert.equal(entries[0].credits, 25);
});

test('identical retry creates no additional balance even at a later timestamp', t => {
  const db = setup(t);
  const first = grantCredits(db, topup());
  assert.equal(grantCredits(db, topup({ now: 2000 })).id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n, 1);
  assert.equal(getCreditBalance(db, 1, 2000).available, 25);
  for (const change of [{ credits: 26 }, { userId: 2 }]) {
    assert.throws(() => grantCredits(db, topup(change)), /GRANT_IDEMPOTENCY_CONFLICT/);
  }
});

test('trial expiry is 30 days and a second trial event is rejected', t => {
  const db = setup(t);
  const options = topup({ source: 'trial', sourceRef: 'trial-1', credits: 5 });
  const g = grantCredits(db, options);
  assert.equal(g.expires_at, 1000 + 2592000);
  assert.equal(grantCredits(db, { ...options, now: g.expires_at + 1 }).id, g.id);
  assert.throws(() => grantCredits(db, { ...options, sourceRef: 'trial-2' }), /TRIAL_ALREADY_GRANTED/);
  assert.equal(getCreditBalance(db, 1, g.expires_at - 1).available, 5);
  assert.equal(getCreditBalance(db, 1, g.expires_at).available, 0);
  assert.equal(getCreditBalance(db, 1, g.expires_at).expiredAvailable, 5);
});

test('available grants are sorted by expiry with purchased credits last', t => {
  const db = setup(t);
  const p = grantCredits(db, topup());
  const s = grantCredits(db, topup({ source: 'subscription', sourceRef: 'cycle-1', credits: 30, expiresAt: 3000 }));
  const trial = grantCredits(db, topup({ source: 'promotion', sourceRef: 'promo-1', credits: 2, expiresAt: 2000 }));
  assert.deepEqual(getCreditBalance(db, 1, 1500).grants.map(g => g.id), [trial.id, s.id, p.id]);
  assert.equal(getCreditBalance(db, 1, 2000).available, 55);
  assert.equal(getCreditBalance(db, 2, 2000).available, 0);
  assert.equal(getCreditBalance(db, 1, 999).available, 0);
});

test('expired holds remain visible without being counted as spendable', t => {
  const db = setup(t);
  const g = grantCredits(db, topup({ source: 'subscription', expiresAt: 2000 }));
  db.prepare('UPDATE credit_grants SET credits_available=20, credits_reserved=5 WHERE id=?').run(g.id);
  const balance = getCreditBalance(db, 1, 2000);
  assert.equal(balance.available, 0);
  assert.equal(balance.reserved, 5);
  assert.equal(balance.expiredAvailable, 20);
});

test('failed ledger insert rolls back the grant', t => {
  const db = setup(t);
  db.exec("CREATE TRIGGER fail_grant_ledger BEFORE INSERT ON credit_ledger BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  assert.throws(() => grantCredits(db, topup()), /injected failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_grants').get().n, 0);
});

test('invalid inputs and unknown users fail without writes', t => {
  const db = setup(t);
  for (const change of [
    { credits: 0 }, { credits: -1 }, { credits: 1.5 }, { userId: 0 },
    { credits: Number.MAX_SAFE_INTEGER + 1 }, { sourceRef: ' ' },
    { source: 'refund' }, { expiresAt: 2000 }, { now: -1 },
    { source: 'subscription' }, { source: 'promotion', expiresAt: 999 }
  ]) assert.throws(() => grantCredits(db, topup(change)), TypeError);
  assert.throws(() => grantCredits(db, topup({ userId: 99 })), /UNKNOWN_USER/);
  assert.throws(() => getCreditBalance(db, 99), /UNKNOWN_USER/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_grants').get().n, 0);
});

test('expired subscription retries are idempotent and expiry changes conflict', t => {
  const db = setup(t);
  const options = topup({ source: 'subscription', expiresAt: 2000 });
  const first = grantCredits(db, options);
  assert.equal(grantCredits(db, { ...options, now: 3000 }).id, first.id);
  assert.throws(() => grantCredits(db, { ...options, expiresAt: 4000 }), /GRANT_IDEMPOTENCY_CONFLICT/);
});
