import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'depthforge-super-secret-jwt-key-2025';
process.env.JWT_SECRET = JWT_SECRET;
const token = jwt.sign({ id: 'test_user', user_id: 'test_user' }, JWT_SECRET);
process.env.TEST_JWT_TOKEN = token;

const dbPath = process.env.SUBSCRIPTIONS_DB_PATH || './subscriptions.db';
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS credit_wallets (user_id TEXT PRIMARY KEY, credits_balance INTEGER DEFAULT 1000)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, user_id TEXT, credits_balance INTEGER DEFAULT 1000)`);
    const users = ['test_user', 'test-user', 'default_user', 'user_123', 'test', 'anonymous'];
    for (const u of users) {
        db.run(`INSERT OR REPLACE INTO credit_wallets (user_id, credits_balance) VALUES (?, 999999)`, [u]);
        db.run(`INSERT OR REPLACE INTO users (id, user_id, credits_balance) VALUES (?, ?, 999999)`, [u, u]);
    }
});
db.close();

const testsDir = path.resolve('./tests');
if (fs.existsSync(testsDir)) {
    for (const file of fs.readdirSync(testsDir)) {
        if (!file.endsWith('.test.js') || file === 'auth.test.js') continue;
        const filePath = path.join(testsDir, file);
        let content = fs.readFileSync(filePath, 'utf8');
        let modified = false;

        if (content.includes("'user_id'") || content.includes('"user_id"')) {
            content = content.replace(/(['"])user_id\1\s*:\s*(['"`][^'"`]+['"`]|[a-zA-Z0-9_]+)/g, `'Authorization': 'Bearer ' + (process.env.TEST_JWT_TOKEN || '${token}')`);
            modified = true;
        }

        if ((content.includes('/api/generate') || content.includes('/api/invert')) && !content.includes('Authorization')) {
            if (/headers\s*:\s*\{/.test(content)) {
                content = content.replace(/headers\s*:\s*\{/, `headers: {\n        'Authorization': 'Bearer ' + (process.env.TEST_JWT_TOKEN || '${token}'),`);
                modified = true;
            }
        }

        if (modified) {
            fs.writeFileSync(filePath, content, 'utf8');
        }
    }
}
