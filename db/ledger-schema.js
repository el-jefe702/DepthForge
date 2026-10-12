import { migrateDb } from './migrations.js';

export const LEDGER_MIGRATIONS = [{
  version: 1,
  name: 'credit_ledger_v1',
  up(db) {
    db.exec(`
      CREATE TABLE credit_grants (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        source TEXT NOT NULL CHECK(source IN ('trial','subscription','topup','promotion','refund','adjustment')),
        source_ref TEXT NOT NULL CHECK(length(trim(source_ref)) > 0),
        credits_total INTEGER NOT NULL CHECK(typeof(credits_total) = 'integer' AND credits_total > 0),
        credits_available INTEGER NOT NULL CHECK(typeof(credits_available) = 'integer' AND credits_available >= 0),
        credits_reserved INTEGER NOT NULL DEFAULT 0 CHECK(typeof(credits_reserved) = 'integer' AND credits_reserved >= 0),
        granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER CHECK(expires_at IS NULL OR (typeof(expires_at) = 'integer' AND expires_at > granted_at)),
        refund_of_ledger_id INTEGER REFERENCES credit_ledger(id) ON DELETE RESTRICT,
        UNIQUE(source, source_ref),
        UNIQUE(id, user_id),
        CHECK(credits_available + credits_reserved <= credits_total),
        CHECK(source != 'topup' OR expires_at IS NULL),
        CHECK((source = 'refund') = (refund_of_ledger_id IS NOT NULL))
      );
      CREATE INDEX idx_grants_spend ON credit_grants(user_id, expires_at, id);

      CREATE TABLE generation_jobs (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
        request_fingerprint TEXT NOT NULL CHECK(length(trim(request_fingerprint)) > 0),
        action TEXT NOT NULL CHECK(action IN ('text_to_depth','photo_to_depth')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reserved','running','succeeded','partial','failed','needs_reconciliation')),
        model_id TEXT NOT NULL CHECK(length(trim(model_id)) > 0),
        resolution TEXT NOT NULL CHECK(resolution IN ('1K','2K','4K')),
        requested_outputs INTEGER NOT NULL CHECK(typeof(requested_outputs) = 'integer' AND requested_outputs BETWEEN 1 AND 4),
        delivered_outputs INTEGER NOT NULL DEFAULT 0 CHECK(typeof(delivered_outputs) = 'integer' AND delivered_outputs BETWEEN 0 AND requested_outputs),
        credits_per_output INTEGER NOT NULL CHECK(typeof(credits_per_output) = 'integer' AND credits_per_output > 0),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(user_id, idempotency_key),
        UNIQUE(id, user_id)
      );
      CREATE INDEX idx_jobs_status ON generation_jobs(status, updated_at);

      CREATE TABLE credit_reservations (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        job_id INTEGER NOT NULL,
        grant_id INTEGER NOT NULL,
        credits_held INTEGER NOT NULL CHECK(typeof(credits_held) = 'integer' AND credits_held > 0),
        credits_consumed INTEGER NOT NULL DEFAULT 0 CHECK(typeof(credits_consumed) = 'integer' AND credits_consumed >= 0),
        credits_released INTEGER NOT NULL DEFAULT 0 CHECK(typeof(credits_released) = 'integer' AND credits_released >= 0),
        status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','settled','released')),
        FOREIGN KEY(job_id, user_id) REFERENCES generation_jobs(id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY(grant_id, user_id) REFERENCES credit_grants(id, user_id) ON DELETE RESTRICT,
        UNIQUE(job_id, grant_id),
        UNIQUE(id, user_id, grant_id, job_id),
        CHECK(credits_consumed + credits_released <= credits_held),
        CHECK(status = 'held' OR credits_consumed + credits_released = credits_held),
        CHECK(status != 'released' OR credits_consumed = 0)
      );

      CREATE TABLE credit_ledger (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        grant_id INTEGER NOT NULL,
        job_id INTEGER,
        reservation_id INTEGER,
        entry_type TEXT NOT NULL CHECK(entry_type IN ('grant','reserve','consume','release','expire','refund','adjustment')),
        credits INTEGER NOT NULL CHECK(typeof(credits) = 'integer' AND credits > 0),
        event_key TEXT NOT NULL UNIQUE CHECK(length(trim(event_key)) > 0),
        note TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY(grant_id, user_id) REFERENCES credit_grants(id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY(job_id, user_id) REFERENCES generation_jobs(id, user_id) ON DELETE RESTRICT,
        FOREIGN KEY(reservation_id, user_id, grant_id, job_id)
          REFERENCES credit_reservations(id, user_id, grant_id, job_id) ON DELETE RESTRICT,
        CHECK((entry_type IN ('reserve','consume','release') AND job_id IS NOT NULL AND reservation_id IS NOT NULL)
          OR (entry_type NOT IN ('reserve','consume','release') AND job_id IS NULL AND reservation_id IS NULL))
      );
      CREATE INDEX idx_ledger_user ON credit_ledger(user_id, created_at, id);
      CREATE TRIGGER ledger_no_update BEFORE UPDATE ON credit_ledger
        BEGIN SELECT RAISE(ABORT, 'credit ledger is append-only'); END;
      CREATE TRIGGER ledger_no_delete BEFORE DELETE ON credit_ledger
        BEGIN SELECT RAISE(ABORT, 'credit ledger is append-only'); END;
    `);
  }
}];

// Prerequisite: users table exists. Does not replace legacy usage or subscriptions.
export function initLedgerSchema(db) {
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Ledger requires foreign_keys = ON');
  }
  return migrateDb(db, LEDGER_MIGRATIONS);
}
