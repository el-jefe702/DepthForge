import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initDb, getOrCreateUser, SCHEMA_SQL } from '../db/subscriptions.js';
import { grantCredits, getCreditBalance } from '../db/credits.js';
import { reserveCredits } from '../db/reservations.js';
import { settleCredits } from '../db/settlement.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'depthforge-init-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
function check(db) {
  for (const name of ['users','subscriptions','usage','credit_grants','generation_jobs','credit_reservations','credit_ledger']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,1);
}

test('in-memory initialization includes ledger and isolates connections', t => {
  const a = initDb(':memory:');
  const b = initDb(':memory:');
  t.after(()=>{ a.close(); b.close(); });
  check(a); check(b);
  getOrCreateUser(a,'maker@example.test');
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);
});

test('nested file path creates parents and survives reopen with full accounting flow', t => {
  const file = path.join(temp(t),'nested','data','subscriptions.db');
  let db = initDb(file);
  try {
    check(db);
    assert.equal(db.pragma('journal_mode',{simple:true}),'wal');
    const user = getOrCreateUser(db,'maker@example.test');
    assert.equal(db.prepare('SELECT plan FROM subscriptions WHERE user_id=?').get(user.id).plan,'free');
    grantCredits(db,{userId:user.id,source:'topup',sourceRef:'payment-1',credits:10,now:1000});
    const {job} = reserveCredits(db,{userId:user.id,idempotencyKey:'job-1',requestFingerprint:'hash',action:'text_to_depth',modelId:'test',resolution:'1K',requestedOutputs:4,creditsPerOutput:1,now:1100});
    settleCredits(db,{userId:user.id,jobId:job.id,deliveredOutputs:3,now:1200});
    db.close();
    db = initDb(file);
    check(db);
    assert.equal(getCreditBalance(db,user.id,1300).available,7);
    assert.equal(getCreditBalance(db,user.id,1300).reserved,0);
    assert.equal(db.prepare('SELECT status FROM generation_jobs').get().status,'partial');
  } finally { if (db.open) db.close(); }
});

test('upgrades legacy database without discarding user or usage records', t => {
  const file = path.join(temp(t),'legacy.db');
  const old = new Database(file);
  old.exec(SCHEMA_SQL);
  const user = getOrCreateUser(old,'legacy@example.test');
  old.prepare("INSERT INTO usage (user_id,action,units,period) VALUES (?,'generate',2,'2026-10')").run(user.id);
  old.close();
  const db = initDb(file);
  try {
    check(db);
    assert.equal(db.prepare('SELECT email FROM users').get().email,'legacy@example.test');
    assert.equal(db.prepare('SELECT units FROM usage').get().units,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM credit_grants').get().n,0);
  } finally { db.close(); }
});

test('environment path and default relative path work in isolated child processes', t => {
  const dir = temp(t);
  const moduleUrl = new URL('../db/subscriptions.js',import.meta.url).href;
  const script = `import { initDb } from ${JSON.stringify(moduleUrl)}; const db=initDb(); db.close();`;
  for (const configured of [true,false]) {
    const env = {...process.env};
    const target = configured ? path.join(dir,'configured','db.sqlite') : path.join(dir,'data','subscriptions.db');
    if (configured) env.SUBSCRIPTIONS_DB_PATH=target;
    else delete env.SUBSCRIPTIONS_DB_PATH;
    const result = spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(fs.existsSync(target));
  }
});

test('invalid paths fail clearly and an invalid parent does not create a database', t => {
  for (const value of ['', ' ', null, 123, 'bad\0path']) assert.throws(()=>initDb(value),TypeError);
  const dir=temp(t);
  const parent=path.join(dir,'not-a-directory');
  fs.writeFileSync(parent,'file');
  assert.throws(()=>initDb(path.join(parent,'db.sqlite')),/Database initialization failed/);
});

test('unknown schema version fails and rolls back newly added schema', t => {
  const file=path.join(temp(t),'future.db');
  const old=new Database(file);
  old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO schema_migrations VALUES (99,'future','now')");
  old.close();
  assert.throws(()=>initDb(file), e=> /Database initialization failed/.test(e.message) && /Unknown or changed/.test(e.cause.message));
  const db=new Database(file);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='users'").get().n,0);
    assert.equal(db.prepare('SELECT version FROM schema_migrations').get().version,99);
  } finally { db.close(); }
});
