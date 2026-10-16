// Server-only adapter. Call authenticate() first; never trust a body-supplied user ID.
// Route integration, provider execution claims, and reconciliation are separate stages.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createCreditBackend({ url, publicKey, serviceRoleKey, fetchImpl = globalThis.fetch }) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !publicKey || !serviceRoleKey || typeof fetchImpl !== 'function') {
    throw new Error('Invalid server credit configuration');
  }
  const base = origin.origin;
  const validId = value => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid credit identifier');
    return value;
  };
  async function request(path, { token, key, body }) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error('Credit service request failed; outcome may be unknown, retry the same job ID');
    }
    if (!response.ok) {
      const error = new Error('Credit service rejected request');
      error.status = response.status;
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error('Invalid credit service response; outcome may be unknown'); }
  }
  const rpc = (name, body) => request('/rest/v1/rpc/' + name, { token: serviceRoleKey, key: serviceRoleKey, body });
  async function authenticate(authorization) {
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization)) throw new Error('Bearer authentication required');
    const user = await request('/auth/v1/user', { token: authorization.slice(7), key: publicKey });
    return validId(user?.id);
  }
  async function reserve(userId, jobId, batch = false) {
    if (typeof batch !== 'boolean') throw new Error('Batch must be a server-normalized boolean');
    return rpc('reserve_priced_credit_job', {
      p_user_id: validId(userId), p_job_id: validId(jobId),
      p_job_type: batch ? 'generate_batch_4' : 'generate_single'
    });
  }
  async function finalize(action, userId, jobId) {
    return rpc('credit_job_action', { p_action: action, p_user_id: validId(userId), p_job_id: validId(jobId) });
  }
  return Object.freeze({ authenticate, reserve,
    commit: (userId, jobId) => finalize('commit', userId, jobId),
    refund: (userId, jobId) => finalize('refund', userId, jobId)
  });
}

export const deductCredit = (userId, prompt, imageUrl) => {
    return new Promise(async (resolve, reject) => {
        try {
            const sqlite3 = (await import('sqlite3')).default;
            const path = await import('path');
            const dbPath = process.env.SUBSCRIPTIONS_DB_PATH || path.join(process.cwd(), 'data', 'subscriptions.db');
            const localDb = new sqlite3.Database(dbPath);
            
            localDb.serialize(() => {
                localDb.run('BEGIN TRANSACTION');
                localDb.run('UPDATE users SET credits_balance = credits_balance - 1 WHERE id = ? AND credits_balance > 0', [userId], function(err) {
                    if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                    if (this.changes === 0) { localDb.run('ROLLBACK'); localDb.close(); return reject(new Error('Insufficient credits')); }
                    localDb.run('INSERT INTO generations (user_id, prompt, image_url) VALUES (?, ?, ?)', [userId, prompt, imageUrl], function(err) {
                        if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                        localDb.get('SELECT credits_balance FROM users WHERE id = ?', [userId], (err, row) => {
                            if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                            localDb.run('COMMIT', err => {
                                localDb.close();
                                if (err) return reject(err);
                                resolve(row.credits_balance);
                            });
                        });
                    });
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};

export const addCredits = (userId, amount, prompt = '', imageUrl = '') => {
    return new Promise(async (resolve, reject) => {
        try {
            const sqlite3 = (await import('sqlite3')).default;
            const path = await import('path');
            const dbPath = process.env.SUBSCRIPTIONS_DB_PATH || path.join(process.cwd(), 'data', 'subscriptions.db');
            const localDb = new sqlite3.Database(dbPath);
            localDb.serialize(() => {
                localDb.run('BEGIN TRANSACTION');
                localDb.run('UPDATE users SET credits_balance = credits_balance + ? WHERE id = ?', [amount, userId], function(err) {
                    if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                    localDb.get('SELECT credits_balance FROM users WHERE id = ?', [userId], (err, row) => {
                        if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                        localDb.run('COMMIT', err => {
                            localDb.close();
                            if (err) return reject(err);
                            resolve(row.credits_balance);
                        });
                    });
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};
