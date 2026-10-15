// Server-only adapter. Call authenticate() first; never trust a body-supplied user ID.
// Route integration, provider execution claims, and reconciliation are separate stages.
import { randomUUID } from 'node:crypto';

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
    return rpc('credit_job_action', {
      p_action: 'reserve',
      p_user_id: validId(userId),
      p_job_id: validId(jobId),
      p_credits: batch ? 4 : 1,
      p_job_type: batch ? 'generate_batch_4' : 'generate_single'
    });
  }
  async function grantCredits(targetUserId, amount, reason, idempotencyKey) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Credit amount must be a positive integer');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('Credit grant reason required');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('Credit grant idempotency key required');
    return rpc('grant_credits', {
      p_target_user_id: validId(targetUserId),
      p_amount: amount,
      p_reason: reason.trim(),
      p_idempotency_key: `admin-grant:${idempotencyKey.trim()}`
    });
  }
  async function finalize(action, userId, jobId) {
    return rpc('credit_job_action', { p_action: action, p_user_id: validId(userId), p_job_id: validId(jobId) });
  }
  return Object.freeze({
    authenticate,
    reserve,
    grantCredits,
    commit: (userId, jobId) => finalize('commit', userId, jobId),
    refund: (userId, jobId) => finalize('refund', userId, jobId)
  });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const creditBackend = SUPABASE_URL && SUPABASE_PUBLIC_KEY && SUPABASE_SERVICE_ROLE_KEY
  ? createCreditBackend({
      url: SUPABASE_URL,
      publicKey: SUPABASE_PUBLIC_KEY,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY
    })
  : null;

export async function addCredits(userId, amount, options = {}) {
  if (!creditBackend) throw new Error('Credit service is not configured');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Credit amount must be a positive integer');
  const idempotencyKey = options.idempotencyKey || randomUUID();
  return creditBackend.grantCredits(
    userId,
    amount,
    options.reason?.trim() || 'Purchase',
    `purchase:${idempotencyKey.trim()}`
  );
}

export async function deductCredit(userId, prompt, imageUrl) {
  if (!creditBackend) throw new Error('Credit service is not configured');
  const jobId = randomUUID();
  const reserved = await creditBackend.reserve(userId, jobId);
  await creditBackend.commit(userId, jobId);
  return reserved?.balance ?? null;
}
