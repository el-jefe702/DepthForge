function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
}

// Trusted caller must confirm durable delivery and that provider work is finished.
// Never settle an ambiguous timeout automatically; reconcile provider/job state first.
export function settleCredits(db, { userId, jobId, deliveredOutputs, now = Math.floor(Date.now() / 1000) }) {
  positive(userId, 'userId');
  positive(jobId, 'jobId');
  if (!Number.isSafeInteger(deliveredOutputs) || deliveredOutputs < 0) throw new TypeError('Invalid deliveredOutputs');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid now');
  if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Foreign keys must be enabled');
  const operation = db.transaction(() => {
    const job = db.prepare('SELECT * FROM generation_jobs WHERE id=? AND user_id=?').get(jobId,userId);
    if (!job) throw new Error('UNKNOWN_JOB');
    if (deliveredOutputs > job.requested_outputs) throw new TypeError('Delivery exceeds requested outputs');
    if (now < job.created_at || now < job.updated_at) throw new TypeError('Settlement timestamp precedes job state');
    const status = deliveredOutputs === 0 ? 'failed' : deliveredOutputs === job.requested_outputs ? 'succeeded' : 'partial';
    const charge = deliveredOutputs * job.credits_per_output;
    if (!Number.isSafeInteger(charge)) throw new RangeError('Unsafe settlement price');
    if (['succeeded','partial','failed'].includes(job.status)) {
      if (job.delivered_outputs !== deliveredOutputs || job.status !== status) throw new Error('SETTLEMENT_CONFLICT');
      return { settled: false, job, charged: charge };
    }
    if (!['reserved','running'].includes(job.status)) throw new Error('JOB_REQUIRES_RECONCILIATION');
    const holds = db.prepare(`SELECT r.*, g.expires_at FROM credit_reservations r
      JOIN credit_grants g ON g.id=r.grant_id AND g.user_id=r.user_id
      WHERE r.job_id=? AND r.user_id=? ORDER BY r.id`).all(jobId,userId);
    let total = 0;
    for (const hold of holds) {
      if (hold.status !== 'held' || hold.credits_consumed !== 0 || hold.credits_released !== 0) throw new Error('INVALID_RESERVATION_STATE');
      total += hold.credits_held;
      if (!Number.isSafeInteger(total)) throw new RangeError('Unsafe hold total');
    }
    if (total !== job.requested_outputs * job.credits_per_output || holds.length === 0) throw new Error('INCOMPLETE_RESERVATIONS');
    let remaining = charge;
    const entry = db.prepare(`INSERT INTO credit_ledger
      (user_id,grant_id,job_id,reservation_id,entry_type,credits,event_key,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const hold of holds) {
      const consumed = Math.min(remaining,hold.credits_held);
      const released = hold.credits_held - consumed;
      remaining -= consumed;
      const changed = db.prepare(`UPDATE credit_grants SET credits_reserved=credits_reserved-?, credits_available=credits_available+?
        WHERE id=? AND user_id=? AND credits_reserved>=?`)
        .run(hold.credits_held,released,hold.grant_id,userId,hold.credits_held);
      if (changed.changes !== 1) throw new Error('SETTLEMENT_BALANCE_CONFLICT');
      if (consumed) entry.run(userId,hold.grant_id,jobId,hold.id,'consume',consumed,`consume:${hold.id}`,now);
      if (released) entry.run(userId,hold.grant_id,jobId,hold.id,'release',released,`release:${hold.id}`,now);
      if (released && hold.expires_at !== null && hold.expires_at <= now) {
        db.prepare('UPDATE credit_grants SET credits_available=credits_available-? WHERE id=?').run(released,hold.grant_id);
        entry.run(userId,hold.grant_id,null,null,'expire',released,`expire:release:${hold.id}`,now);
      }
      db.prepare(`UPDATE credit_reservations SET credits_consumed=?, credits_released=?, status=? WHERE id=?`)
        .run(consumed,released,consumed === 0 ? 'released' : 'settled',hold.id);
    }
    db.prepare('UPDATE generation_jobs SET delivered_outputs=?, status=?, updated_at=? WHERE id=?')
      .run(deliveredOutputs,status,now,jobId);
    return { settled: true, job: db.prepare('SELECT * FROM generation_jobs WHERE id=?').get(jobId), charged: charge };
  });
  return operation.immediate();
}
