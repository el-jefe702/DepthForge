// SQLite schema for DepthForge monetization (Phase 1): users, usage, subscriptions.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const PLANS = {
  free: { monthlyQuota: 10 },
  pro: { monthlyQuota: 200 },
  studio: { monthlyQuota: 1000 },
};

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  external_id TEXT UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','studio')),
  status              TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','trialing','past_due','canceled')),
  stripe_customer_id  TEXT,
  stripe_sub_id       TEXT UNIQUE,
  current_period_start TEXT,
  current_period_end   TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  units      INTEGER NOT NULL DEFAULT 1,
  period     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage(user_id, period);
`;

export function currentPeriod(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

export function initDb(dbPath = process.env.SUBSCRIPTIONS_DB_PATH || './data/subscriptions.db') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

export function getOrCreateUser(db, email, externalId = null) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;
  const tx = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, external_id) VALUES (?, ?)')
      .run(email, externalId);
    db.prepare("INSERT INTO subscriptions (user_id, plan, status) VALUES (?, 'free', 'active')").run(lastInsertRowid);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  });
  return tx();
}

export function getActiveSubscription(db, userId) {
  return db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing') ORDER BY id DESC LIMIT 1")
    .get(userId);
}

export function recordUsage(db, userId, action = 'generate', units = 1) {
  db.prepare('INSERT INTO usage (user_id, action, units, period) VALUES (?, ?, ?, ?)').run(
    userId, action, units, currentPeriod()
  );
}

export function getUsageThisPeriod(db, userId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(units), 0) AS total FROM usage WHERE user_id = ? AND period = ?')
    .get(userId, currentPeriod());
  return row.total;
}

export function checkQuota(db, userId) {
  const sub = getActiveSubscription(db, userId);
  const plan = sub ? sub.plan : 'free';
  const limit = PLANS[plan].monthlyQuota;
  const used = getUsageThisPeriod(db, userId);
  return { plan, limit, used, remaining: Math.max(0, limit - used), allowed: used < limit };
}
