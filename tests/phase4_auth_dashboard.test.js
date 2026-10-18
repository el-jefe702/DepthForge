import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app } from '../server.js';
import { closeStore } from '../db/store.js';

const TEST_DB = path.resolve('./test_phase4_store.db');

describe('Phase 4: Integrated Web Site, User Auth, User Dashboard & Admin Console', () => {
    let server;
    let baseUrl;
    let adminToken;
    let adminUser;
    let regularToken;
    let regularUser;

    before(async () => {
        process.env.NODE_ENV = 'test';
        process.env.JWT_SECRET = 'phase4-test-jwt-secret-key';
        process.env.SUBSCRIPTIONS_DB_PATH = TEST_DB;
        if (fs.existsSync(TEST_DB)) {
            try { fs.unlinkSync(TEST_DB); } catch {}
        }

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const addr = server.address();
                baseUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });

    after(async () => {
        await closeStore();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        delete process.env.SUBSCRIPTIONS_DB_PATH;
        if (fs.existsSync(TEST_DB)) {
            try { fs.unlinkSync(TEST_DB); } catch {}
        }
    });

    it('serves integrated SpatialOps web site pages (/, /app, /solutions, /pricing, /about, /terms, /privacy, /login, /signup, /dashboard, /admin)', async () => {
        const rootManual = await fetch(`${baseUrl}/`, { redirect: 'manual' });
        assert.equal(rootManual.status, 200, 'Expected GET / to return 200 directly (not 302 redirect)');
        const rootHtml = await rootManual.text();
        assert.match(rootHtml, /SpatialOps, LLC/i);
        assert.match(rootHtml, /\/app\?mode=photo/);

        for (const route of ['/', '/app', '/solutions', '/pricing', '/about', '/terms', '/privacy', '/login', '/signup', '/dashboard', '/admin']) {
            const res = await fetch(`${baseUrl}${route}`);
            assert.equal(res.status, 200, `Expected 200 for ${route}`);
            const html = await res.text();
            assert.match(html, /DepthForge|SpatialOps/i);
        }
    });

    it('exposes SpatialOps & SLCreations.llc ecosystem info and accepts contact/fabrication inquiries', async () => {
        const infoRes = await fetch(`${baseUrl}/api/ecosystem/info`, {
            headers: { Origin: 'https://SLCreations.llc' }
        });
        assert.equal(infoRes.status, 200);
        assert.equal(infoRes.headers.get('access-control-allow-origin'), 'https://SLCreations.llc');
        const info = await infoRes.json();
        assert.equal(info.company, 'SpatialOps, LLC');
        assert.equal(info.partner.url, 'https://SLCreations.llc');

        const contactRes = await fetch(`${baseUrl}/api/contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Shop Owner',
                email: 'shop@slcreations.llc',
                category: 'slcreations_fabrication',
                message: 'Custom hardwood CNC relief order from DepthForge heightmap'
            })
        });
        assert.equal(contactRes.status, 201);
        const contactData = await contactRes.json();
        assert.equal(contactData.status, 'success');
        assert.ok(contactData.inquiryId);
    });

    it('registers the first user as admin with starter credits', async () => {
        const res = await fetch(`${baseUrl}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'founder@depthforge.io', password: 'password123' })
        });
        assert.equal(res.status, 201);
        const data = await res.json();
        assert.ok(data.token);
        assert.equal(data.user.email, 'founder@depthforge.io');
        assert.equal(data.user.role, 'admin');
        assert.equal(data.user.credits_balance, 10);
        adminToken = data.token;
        adminUser = data.user;
    });

    it('registers subsequent users with role "user" and rejects duplicate emails', async () => {
        const res = await fetch(`${baseUrl}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'maker@depthforge.io', password: 'password123' })
        });
        assert.equal(res.status, 201);
        const data = await res.json();
        assert.equal(data.user.role, 'user');
        assert.equal(data.user.credits_balance, 10);
        regularToken = data.token;
        regularUser = data.user;

        const dup = await fetch(`${baseUrl}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'maker@depthforge.io', password: 'password123' })
        });
        assert.equal(dup.status, 409);
    });

    it('authenticates existing users via /api/auth/login and /api/auth/me', async () => {
        const badRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'maker@depthforge.io', password: 'wrongpassword' })
        });
        assert.equal(badRes.status, 401);

        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'maker@depthforge.io', password: 'password123' })
        });
        assert.equal(loginRes.status, 200);
        const loginData = await loginRes.json();
        assert.ok(loginData.token);

        const meRes = await fetch(`${baseUrl}/api/auth/me`, {
            headers: { Authorization: `Bearer ${loginData.token}` }
        });
        assert.equal(meRes.status, 200);
        const meData = await meRes.json();
        assert.equal(meData.user.email, 'maker@depthforge.io');
    });

    it('returns user dashboard data, credit wallet balance, and checkout URL', async () => {
        const dashRes = await fetch(`${baseUrl}/api/user/dashboard`, {
            headers: { Authorization: `Bearer ${regularToken}` }
        });
        assert.equal(dashRes.status, 200);
        const dashData = await dashRes.json();
        assert.equal(dashData.user.email, 'maker@depthforge.io');
        assert.equal(dashData.credits_balance, 10);
        assert.ok(Array.isArray(dashData.generations));

        const walletRes = await fetch(`${baseUrl}/api/wallet/balance`, {
            headers: { Authorization: `Bearer ${regularToken}` }
        });
        assert.equal(walletRes.status, 200);
        const walletData = await walletRes.json();
        assert.equal(walletData.balance, 10);
        assert.equal(walletData.credits_balance, 10);

        const checkoutRes = await fetch(`${baseUrl}/api/wallet/checkout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${regularToken}`
            },
            body: JSON.stringify({ packageId: 'basic' })
        });
        assert.equal(checkoutRes.status, 200);
        const checkoutData = await checkoutRes.json();
        assert.ok(checkoutData.url);
    });

    it('enforces admin RBAC and allows admins to view stats, list users, and adjust credits', async () => {
        const forbiddenRes = await fetch(`${baseUrl}/api/admin/stats`, {
            headers: { Authorization: `Bearer ${regularToken}` }
        });
        assert.equal(forbiddenRes.status, 403);

        const statsRes = await fetch(`${baseUrl}/api/admin/stats`, {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.equal(statsRes.status, 200);
        const stats = await statsRes.json();
        assert.equal(stats.totalUsers, 2);
        assert.equal(stats.outstandingCredits, 20);

        const grantRes = await fetch(`${baseUrl}/api/admin/credits`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${adminToken}`
            },
            body: JSON.stringify({ userId: regularUser.id, amount: 25 })
        });
        assert.equal(grantRes.status, 200);
        const grantData = await grantRes.json();
        assert.equal(grantData.user.credits_balance, 35);
    });
});
