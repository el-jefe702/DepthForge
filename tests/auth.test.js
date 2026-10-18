import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { creditGate, extractToken } from '../middleware/auth.js';

const TEST_DB = path.resolve('./test_subscriptions_auth.db');
const JWT_SECRET = 'test-secret-suite-key-123';

describe('JWT Authentication Middleware (Issue #39)', () => {
    before(() => {
        process.env.JWT_SECRET = JWT_SECRET;
        process.env.SUBSCRIPTIONS_DB_PATH = TEST_DB;

        const db = new sqlite3.Database(TEST_DB);
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS credit_wallets (
                user_id TEXT PRIMARY KEY,
                credits_balance INTEGER
            )`);
            db.run(`INSERT OR REPLACE INTO credit_wallets (user_id, credits_balance) VALUES ('rich_user', 50)`);
            db.run(`INSERT OR REPLACE INTO credit_wallets (user_id, credits_balance) VALUES ('broke_user', 0)`);
        });
        db.close();
    });

    after(() => {
        delete process.env.SUBSCRIPTIONS_DB_PATH;
        if (fs.existsSync(TEST_DB)) {
            try { fs.unlinkSync(TEST_DB); } catch (e) {}
        }
    });

    it('should reject requests without a token with status 401', () => {
        let statusCode = null;
        let responseBody = null;
        let nextCalled = false;

        const req = { headers: {} };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(data) {
                responseBody = data;
                return this;
            }
        };
        const next = () => { nextCalled = true; };

        creditGate(req, res, next);
        assert.equal(statusCode, 401);
        assert.match(responseBody.error, /token/i);
        assert.equal(nextCalled, false);
    });

    it('should reject requests with an invalid JWT signature with status 401', () => {
        const badToken = jwt.sign({ id: 'user1' }, 'wrong-secret');
        let statusCode = null;
        let responseBody = null;
        let nextCalled = false;

        const req = { headers: { authorization: `Bearer ${badToken}` } };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(data) {
                responseBody = data;
                return this;
            }
        };
        const next = () => { nextCalled = true; };

        creditGate(req, res, next);
        assert.equal(statusCode, 401);
        assert.match(responseBody.error, /invalid|expired/i);
        assert.equal(nextCalled, false);
    });

    it('should reject requests with malformed token with status 401', () => {
        let statusCode = null;
        const req = { headers: { authorization: 'Bearer not-a-real-jwt' } };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json() { return this; }
        };

        creditGate(req, res, () => {});
        assert.equal(statusCode, 401);
    });

    it('should reject token lacking userId / id payload with status 401', () => {
        const token = jwt.sign({ foo: 'bar' }, JWT_SECRET);
        let statusCode = null;
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json() { return this; }
        };

        creditGate(req, res, () => {});
        assert.equal(statusCode, 401);
    });

    it('should query ledger and reject user with 0 credits with status 402', (t, done) => {
        const token = jwt.sign({ id: 'broke_user' }, JWT_SECRET);
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = {
            status(code) {
                assert.equal(code, 402);
                return this;
            },
            json(data) {
                assert.match(data.error, /credits/i);
                done();
                return this;
            }
        };

        creditGate(req, res, () => {
            assert.fail('Should not call next for broke user');
        });
    });

    it('should query ledger and allow user with positive credits', (t, done) => {
        const token = jwt.sign({ id: 'rich_user' }, JWT_SECRET);
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = {
            status() { return this; },
            json() { return this; }
        };

        creditGate(req, res, () => {
            assert.equal(req.userId, 'rich_user');
            assert.equal(req.user.id, 'rich_user');
            assert.equal(req.credits_balance, 50);
            done();
        });
    });

    it('extractToken correctly handles Bearer prefix and token header variants', () => {
        assert.equal(extractToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
        assert.equal(extractToken({ headers: { authorization: 'xyz.123.456' } }), 'xyz.123.456');
        assert.equal(extractToken({ headers: { 'x-access-token': 'token123' } }), 'token123');
        assert.equal(extractToken({ headers: { token: 'token456' } }), 'token456');
        assert.equal(extractToken({ headers: {} }), null);
    });
});
