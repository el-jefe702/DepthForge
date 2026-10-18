import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
}

export function getTestToken() {
  const secret = process.env.JWT_SECRET || 'depthforge-test-jwt-secret';
  process.env.JWT_SECRET = secret;
  const token = jwt.sign(
    { id: 'test-user', userId: 'test-user', user_id: 'test-user', sub: 'test-user', role: 'authenticated' },
    secret,
    { expiresIn: '1h' }
  );
  process.env.TEST_JWT_TOKEN = token;
  return token;
}

getTestToken();

export const authenticatedFetch = (input, init = {}) => {
  const token = getTestToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return globalThis.fetch(input, { ...init, headers });
};
