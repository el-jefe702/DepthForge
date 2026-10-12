function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}

// Internal API: authenticated user and quote must be supplied by trusted server code.
// Returning an existing job is not permission to launch another provider request.
export function reserveCredits(db, options) {
  const { userId, requestedOutputs, creditsPerOutput, now = Math.floor(Date.now() / 1000) } = options;
  positive(userId, 'userId');
  positive(requestedOutputs, 'requestedOutputs');
  positive(creditsPerOutput, 'creditsPerOutput');
  if (requestedOutputs > 4) throw new TypeError('At most four outputs are supported');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid now');
  const total = requestedOutputs * creditsPerOutput;
  positive(total, 'total price');
  const key = text(options.idempotencyKey, 'idempotencyKey');
  const fingerprint = text(options.requestFingerprint, 'requestFingerprint');
  const model = text(options.modelId, 'modelId');
  const { action, resolution } = options;
  if (!['text_to_depth', 'photo_to_depth'].includes(action)) throw new TypeError('Invalid action');
  if (!['1K','2K','4K'].includes(resolution)) throw new TypeError('Invalid resolution');
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Foreign keys must be enabled');

  const operation = db.transaction(() => {
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw new Error('UNKNOWN_USER');
    const existing = db.prepare('SELECT * FROM generation_jobs WHERE user_id=? AND idempotency_key=?').get(userId,key);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint || existing.action !== action ||
          existing.model_id !== model || existing.resolution !== resolution ||
          existing.requested_outputs !== requestedOutputs || existing.credits_per_output !== creditsPerOutput) {
        throw new Error('JOB_IDEMPOTENCY_CONFLICT');
      }
      return { created: false, job: existing,
        reservations: db.prepare('SELECT * FROM credit_reservations WHERE job_id=? ORDER BY id').all(existing.id) };
    }
    const grants = db.prepare(`SELECT * FROM credit_grants WHERE user_id=? AND credits_available>0
      AND granted_at<=? AND (expires_at IS NULL OR expires_at>?)
      ORDER BY (expires_at IS NULL), expires_at, granted_at, id`).all(userId,now,now);
    let remaining = total;
    const allocations = [];
    for (const grant of grants) {
      const credits = Math.min(grant.credits_available, remaining);
      allocations.push({ grantId: grant.id, credits });
      remaining -= credits;
      if (remaining === 0) break;
    }
    if (remaining !== 0) throw new Error('INSUFFICIENT_CREDITS');
    const inserted = db.prepare(`INSERT INTO generation_jobs
      (user_id,idempotency_key,request_fingerprint,action,status,model_id,resolution,requested_outputs,credits_per_output,created_at,updated_at)
      VALUES (?,?,?,?,'reserved',?,?,?,?,?,?)`).run(userId,key,fingerprint,action,model,resolution,requestedOutputs,creditsPerOutput,now,now);
    const jobId = Number(inserted.lastInsertRowid);
    positive(jobId, 'jobId');
    for (const allocation of allocations) {
      const changed = db.prepare(`UPDATE credit_grants SET credits_available=credits_available-?, credits_reserved=credits_reserved+?
        WHERE id=? AND user_id=? AND credits_available>=?`).run(allocation.credits,allocation.credits,allocation.grantId,userId,allocation.credits);
      if (changed.changes !== 1) throw new Error('RESERVATION_BALANCE_CONFLICT');
      const r = db.prepare('INSERT INTO credit_reservations (user_id,job_id,grant_id,credits_held) VALUES (?,?,?,?)')
        .run(userId,jobId,allocation.grantId,allocation.credits);
      const reservationId = Number(r.lastInsertRowid);
      positive(reservationId, 'reservationId');
      db.prepare(`INSERT INTO credit_ledger (user_id,grant_id,job_id,reservation_id,entry_type,credits,event_key,created_at)
        VALUES (?,?,?,?,'reserve',?,?,?)`).run(userId,allocation.grantId,jobId,reservationId,allocation.credits,`reserve:${reservationId}`,now);
    }
    return { created: true, job: db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(jobId),
      reservations: db.prepare('SELECT * FROM credit_reservations WHERE job_id=? ORDER BY id').all(jobId) };
  });
  return operation.immediate();
}
