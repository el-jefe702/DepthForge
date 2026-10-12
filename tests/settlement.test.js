import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initLedgerSchema } from '../db/ledger-schema.js';
import { grantCredits, getCreditBalance } from '../db/credits.js';
import { reserveCredits } from '../db/reservations.js';
import { settleCredits } from '../db/settlement.js';

function setup(t, { credits = 10, price = 1, source = 'topup', expiresAt = null } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1),(2)');
  initLedgerSchema(db);
  grantCredits(db,{userId:1,source,sourceRef:'grant-1',credits,expiresAt,now:1000});
  const { job } = reserveCredits(db,{userId:1,idempotencyKey:'job-1',requestFingerprint:'hash',action:'text_to_depth',modelId:'test',resolution:'1K',requestedOutputs:4,creditsPerOutput:price,now:1500});
  return {db,job};
}
function settle(db,job,deliveredOutputs,now=1600) {
  return settleCredits(db,{userId:1,jobId:job.id,deliveredOutputs,now});
}

for (const [delivered,expectedStatus,available] of [[4,'succeeded',6],[3,'partial',7],[0,'failed',10]]) {
  test(`delivery of ${delivered} settles charges and releases unused holds`, t => {
    const {db,job} = setup(t);
    const result = settle(db,job,delivered);
    assert.equal(result.job.status,expectedStatus);
    assert.equal(result.charged,delivered);
    assert.equal(getCreditBalance(db,1,1600).available,available);
    assert.equal(getCreditBalance(db,1,1600).reserved,0);
    const r = db.prepare('SELECT * FROM credit_reservations').get();
    assert.equal(r.credits_consumed,delivered);
    assert.equal(r.credits_released,4-delivered);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  });
}

test('matching repeat is a no-op and different delivered count conflicts', t => {
  const {db,job} = setup(t);
  settle(db,job,3);
  const before = db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n;
  assert.equal(settle(db,job,3,1700).settled,false);
  assert.throws(() => settle(db,job,4,1700),/SETTLEMENT_CONFLICT/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_ledger').get().n,before);
});

test('honors expired hold but expires unused released credits', t => {
  const {db,job} = setup(t,{source:'subscription',credits:4,expiresAt:1550});
  settle(db,job,3,1600);
  const g = db.prepare('SELECT * FROM credit_grants').get();
  assert.equal(g.credits_reserved,0);
  assert.equal(g.credits_available,0);
  assert.equal(db.prepare("SELECT credits FROM credit_ledger WHERE entry_type='expire'").get().credits,1);
  assert.equal(getCreditBalance(db,1,1600).available,0);
});

test('failure during settlement rolls back balance, ledger and job state', t => {
  const {db,job} = setup(t);
  db.exec("CREATE TRIGGER reject_release BEFORE INSERT ON credit_ledger WHEN NEW.entry_type='release' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => settle(db,job,3),/injected/);
  assert.equal(getCreditBalance(db,1,1600).available,6);
  assert.equal(getCreditBalance(db,1,1600).reserved,4);
  assert.equal(db.prepare('SELECT status FROM generation_jobs').get().status,'reserved');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE entry_type='consume'").get().n,0);
});

test('multi-grant premium job settles at quoted per-image price', t => {
  const {db} = setup(t);
  grantCredits(db,{userId:1,source:'promotion',sourceRef:'extra',credits:3,expiresAt:3000,now:1500});
  const {job} = reserveCredits(db,{userId:1,idempotencyKey:'premium',requestFingerprint:'premium-hash',action:'text_to_depth',modelId:'test',resolution:'2K',requestedOutputs:4,creditsPerOutput:2,now:1500});
  const result = settle(db,job,3);
  assert.equal(result.charged,6);
  assert.equal(getCreditBalance(db,1,1600).available,3);
  assert.equal(getCreditBalance(db,1,1600).reserved,4);
  const holds = db.prepare('SELECT * FROM credit_reservations WHERE job_id=? ORDER BY id').all(job.id);
  assert.deepEqual(holds.map(r=>[r.credits_consumed,r.credits_released]),[[3,0],[3,2]]);
});

test('invalid deliveries and wrong owner fail without changes', t => {
  const {db,job} = setup(t);
  for (const count of [-1,1.5,5]) assert.throws(()=>settle(db,job,count),TypeError);
  assert.throws(()=>settle(db,job,1,1400),TypeError);
  assert.throws(()=>settleCredits(db,{userId:2,jobId:job.id,deliveredOutputs:1,now:1600}),/UNKNOWN_JOB/);
  assert.equal(getCreditBalance(db,1,1600).reserved,4);
});

test('ambiguous jobs retain holds until separate reconciliation', t => {
  const {db,job} = setup(t);
  db.prepare("UPDATE generation_jobs SET status='needs_reconciliation' WHERE id=?").run(job.id);
  assert.throws(()=>settle(db,job,0),/JOB_REQUIRES_RECONCILIATION/);
  assert.equal(getCreditBalance(db,1,1600).reserved,4);
});
