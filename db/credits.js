const SOURCES = new Set(['trial', 'subscription', 'topup', 'promotion']);
const TRIAL_SECONDS = 30 * 24 * 60 * 60;

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`${name} must be a safe integer >= ${min}`);
  return value;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new TypeError(`${name} must be a nonblank string of at most 256 characters`);
  }
  return value.trim();
}
function userExists(db, userId) {
  integer(userId, 'userId', 1);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new Error('UNKNOWN_USER');
}
function safeSum(rows, field) {
  let total = 0;
  for (const row of rows) {
    total += integer(row[field], field);
    if (!Number.isSafeInteger(total)) throw new RangeError('Credit balance exceeds safe integer range');
  }
  return total;
}

// Internal trusted caller only. sourceRef identifies a verified payment/cycle/trial event.
// Refund and adjustment helpers will be implemented separately.
export function grantCredits(db, options) {
  const { userId, source, credits, expiresAt = null, now = Math.floor(Date.now() / 1000) } = options;
  integer(userId, 'userId', 1);
  integer(credits, 'credits', 1);
  integer(now, 'now');
  const sourceRef = text(options.sourceRef, 'sourceRef');
  if (!SOURCES.has(source)) throw new TypeError('Unsupported grant source');
  if (source === 'topup' && expiresAt !== null) throw new TypeError('Purchased credits cannot expire');
  if (['subscription', 'promotion'].includes(source) && expiresAt === null) {
    throw new TypeError('Subscription and promotion grants require expiresAt');
  }
  if (expiresAt !== null) integer(expiresAt, 'expiresAt');
  if (source === 'trial' && expiresAt !== null) throw new TypeError('Trial expiry is calculated automatically');

  const operation = db.transaction(() => {
    userExists(db, userId);
    const existing = db.prepare('SELECT * FROM credit_grants WHERE source = ? AND source_ref = ?').get(source, sourceRef);
    if (existing) {
      const sameExpiry = source === 'trial'
        ? existing.expires_at === existing.granted_at + TRIAL_SECONDS
        : existing.expires_at === expiresAt;
      if (existing.user_id !== userId || existing.credits_total !== credits || !sameExpiry) {
        throw new Error('GRANT_IDEMPOTENCY_CONFLICT');
      }
      return existing;
    }
    if (source === 'trial' && db.prepare("SELECT id FROM credit_grants WHERE user_id = ? AND source = 'trial'").get(userId)) {
      throw new Error('TRIAL_ALREADY_GRANTED');
    }
    const expiry = source === 'trial' ? integer(now + TRIAL_SECONDS, 'trial expiry') : expiresAt;
    if (expiry !== null && expiry <= now) throw new TypeError('expiresAt must be after now');
    const result = db.prepare(`INSERT INTO credit_grants
      (user_id,source,source_ref,credits_total,credits_available,granted_at,expires_at)
      VALUES (?,?,?,?,?,?,?)`).run(userId, source, sourceRef, credits, credits, now, expiry);
    const grantId = Number(result.lastInsertRowid);
    integer(grantId, 'grantId', 1);
    db.prepare(`INSERT INTO credit_ledger
      (user_id,grant_id,entry_type,credits,event_key,created_at)
      VALUES (?,?,'grant',?,?,?)`).run(userId, grantId, credits, `grant:${grantId}`, now);
    return db.prepare('SELECT * FROM credit_grants WHERE id = ?').get(grantId);
  });
  return operation.immediate();
}

export function getCreditBalance(db, userId, now = Math.floor(Date.now() / 1000)) {
  integer(now, 'now');
  const read = db.transaction(() => {
    userExists(db, userId);
    const rows = db.prepare(`SELECT * FROM credit_grants WHERE user_id = ?
      ORDER BY (expires_at IS NULL) ASC, expires_at ASC, granted_at ASC, id ASC`).all(userId);
    const eligible = rows.filter(g => g.granted_at <= now && (g.expires_at === null || g.expires_at > now));
    return {
      available: safeSum(eligible, 'credits_available'),
      reserved: safeSum(rows, 'credits_reserved'),
      expiredAvailable: safeSum(rows.filter(g => g.expires_at !== null && g.expires_at <= now), 'credits_available'),
      grants: eligible.filter(g => g.credits_available > 0).map(g => ({
        id: g.id, source: g.source, available: g.credits_available, expiresAt: g.expires_at
      }))
    };
  });
  return read();
}
