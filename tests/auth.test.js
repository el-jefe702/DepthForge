import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../auth.js';

function mockResponse() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test('auth middleware passes through when disabled', async () => {
  const auth = createAuth({ enabled: false });
  const req = { headers: {} };
  const res = mockResponse();
  let called = false;

  await auth.requireAuth(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(req.user, null);
  assert.equal(auth.isEnabled(), false);
});

test('auth middleware rejects a missing bearer token when enabled', async () => {
  const auth = createAuth({ enabled: true, supabaseClient: {} });
  const req = { headers: {} };
  const res = mockResponse();
  let called = false;

  await auth.requireAuth(req, res, () => {
    called = true;
  });

  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Authentication required.');
});

test('auth middleware rejects an invalid token', async () => {
  const supabaseClient = {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'bad token' } })
    }
  };
  const auth = createAuth({ enabled: true, supabaseClient });
  const req = { headers: { authorization: 'Bearer invalid' } };
  const res = mockResponse();
  let called = false;

  await auth.requireAuth(req, res, () => {
    called = true;
  });

  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Invalid or expired session.');
});

test('auth middleware accepts a valid token and attaches the user', async () => {
  const user = { id: 'user-123', email: 'user@example.com' };
  const supabaseClient = {
    auth: {
      getUser: async (token) => ({
        data: { user: token === 'valid-token' ? user : null },
        error: null
      })
    }
  };
  const auth = createAuth({ enabled: true, supabaseClient });
  const req = { headers: { authorization: 'Bearer valid-token' } };
  const res = mockResponse();
  let called = false;

  await auth.requireAuth(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.deepEqual(req.user, user);
});
