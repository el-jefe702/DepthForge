import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreditBackend } from '../credit-backend.js';

const user = '11111111-1111-4111-8111-111111111111';
const job = '22222222-2222-4222-8222-222222222222';

function setup(reply = { id: user }) {
  const calls = [];
  const api = createCreditBackend({
    url: 'https://example.supabase.co',
    publicKey: 'public-test',
    serviceRoleKey: 'service-test',
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return { ok: true, json: async () => reply };
    }
  });
  return { api, calls };
}

test('verifies bearer token with Auth before deriving user ID', async () => {
  const { api, calls } = setup();
  assert.equal(await api.authenticate('Bearer user-test-token'), user);
  assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/user');
  assert.equal(calls[0].headers.apikey, 'public-test');
  assert.equal(calls[0].headers.Authorization, 'Bearer user-test-token');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].redirect, 'error');
});

test('rejects missing authentication and malformed Auth responses', async () => {
  const { api, calls } = setup();
  await assert.rejects(api.authenticate(undefined), /authentication required/);
  assert.equal(calls.length, 0);
  await assert.rejects(setup({ id: 'bad' }).api.authenticate('Bearer x'), /identifier/);
});

test('reserve uses the implemented Supabase job action RPC', async () => {
  const { api, calls } = setup({ status: 'reserved' });
  await api.reserve(user, job);
  await api.reserve(user, job, true);

  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/credit_job_action');
  assert.deepEqual(JSON.parse(calls[0].body), {
    p_action: 'reserve',
    p_user_id: user,
    p_job_id: job,
    p_credits: 1,
    p_job_type: 'generate_single'
  });
  assert.deepEqual(JSON.parse(calls[1].body), {
    p_action: 'reserve',
    p_user_id: user,
    p_job_id: job,
    p_credits: 4,
    p_job_type: 'generate_batch_4'
  });
  assert.equal(calls[0].headers.Authorization, 'Bearer service-test');
  assert.equal(calls[0].headers.apikey, 'service-test');
  await assert.rejects(api.reserve(user, job, 'true'), /boolean/);
  await assert.rejects(api.reserve('bad', job), /identifier/);
});

test('grantCredits validates input and calls the admin grant RPC', async () => {
  const { api, calls } = setup({ replayed: false, balance: 10 });
  const result = await api.grantCredits(user, 5, ' Support adjustment ', 'abc123');

  assert.equal(result.replayed, false);
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/grant_credits');
  assert.deepEqual(JSON.parse(calls[0].body), {
    p_target_user_id: user,
    p_amount: 5,
    p_reason: 'Support adjustment',
    p_idempotency_key: 'admin-grant:abc123'
  });
  await assert.rejects(api.grantCredits(user, 0, 'reason', 'key'), /positive integer/);
  await assert.rejects(api.grantCredits(user, 1.5, 'reason', 'key'), /positive integer/);
  await assert.rejects(api.grantCredits(user, 1, '  ', 'key'), /reason required/i);
  await assert.rejects(api.grantCredits(user, 1, 'reason', ' '), /idempotency key required/i);
  await assert.rejects(api.grantCredits('bad', 1, 'reason', 'key'), /identifier/);
});

test('commit and refund retain the same user and job identity', async () => {
  const { api, calls } = setup();
  await api.commit(user, job);
  await api.refund(user, job);

  for (const [index, action] of ['commit', 'refund'].entries()) {
    assert.deepEqual(JSON.parse(calls[index].body), {
      p_action: action,
      p_user_id: user,
      p_job_id: job
    });
    assert.ok(calls[index].url.endsWith('/rpc/credit_job_action'));
  }
});

test('does not leak upstream errors or auto-refund uncertain outcomes', async () => {
  const api = createCreditBackend({
    url: 'https://example.supabase.co',
    publicKey: 'public-test',
    serviceRoleKey: 'service-test',
    fetchImpl: async () => {
      throw new Error('secret upstream details');
    }
  });
  await assert.rejects(
    api.reserve(user, job),
    error => !error.message.includes('secret') && error.message.includes('outcome may be unknown')
  );

  const rejected = createCreditBackend({
    url: 'https://example.supabase.co',
    publicKey: 'public-test',
    serviceRoleKey: 'service-test',
    fetchImpl: async () => ({ ok: false, status: 401 })
  });
  await assert.rejects(rejected.authenticate('Bearer x'), error => error.status === 401);
});

test('rejects insecure configuration', () => {
  assert.throws(
    () => createCreditBackend({ url: 'http://example.com', publicKey: 'p', serviceRoleKey: 's' }),
    /configuration/
  );
});
