// Shared user & credit store for Phase 4 (auth, user dashboard, admin dashboard).
// Uses PostgreSQL when DATABASE_URL is set, otherwise a local SQLite file.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const getSubscriptionsDbPath = () =>
    process.env.SUBSCRIPTIONS_DB_PATH || path.join(process.cwd(), 'data', 'subscriptions.db');

const usePostgres = () => {
    const url = process.env.DATABASE_URL;
    return Boolean(url && !url.startsWith('sqlite'));
};

let pgPool = null;
const sqliteHandles = new Map();
const initialized = new Set();

async function getSqlite() {
    const dbPath = getSubscriptionsDbPath();
    if (sqliteHandles.has(dbPath)) return sqliteHandles.get(dbPath);
    const sqlite3 = (await import('sqlite3')).default;
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new sqlite3.Database(dbPath);
    sqliteHandles.set(dbPath, db);
    return db;
}

async function rawQuery(sql, params = []) {
    if (usePostgres()) {
        if (!pgPool) {
            const { default: pg } = await import('pg');
            pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        }
        let i = 1;
        const res = await pgPool.query(sql.replace(/\?/g, () => `$${i++}`), params);
        return { rows: res.rows, changes: res.rowCount };
    }
    const db = await getSqlite();
    return new Promise((resolve, reject) => {
        if (/^\s*(SELECT|WITH)/i.test(sql)) {
            db.all(sql, params, (err, rows) => (err ? reject(err) : resolve({ rows, changes: 0 })));
        } else {
            db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ rows: [], changes: this.changes });
            });
        }
    });
}

async function ensureSchema() {
    const key = usePostgres() ? 'pg' : getSubscriptionsDbPath();
    if (initialized.has(key)) return;
    const ts = usePostgres() ? 'TIMESTAMP' : 'DATETIME';
    await rawQuery(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        stripe_customer_id TEXT,
        credits_balance INTEGER DEFAULT 0,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        created_at ${ts} DEFAULT CURRENT_TIMESTAMP
    )`);
    // Upgrade older tables that predate Phase 4 columns.
    const userUpgradeCols = [
        'email TEXT',
        'stripe_customer_id TEXT',
        'credits_balance INTEGER DEFAULT 0',
        'password_hash TEXT',
        "role TEXT DEFAULT 'user'",
        `created_at ${ts} DEFAULT CURRENT_TIMESTAMP`
    ];
    for (const col of userUpgradeCols) {
        try {
            await rawQuery(`ALTER TABLE users ADD COLUMN ${usePostgres() ? 'IF NOT EXISTS ' : ''}${col}`);
        } catch { /* column already exists */ }
    }
    try {
        await rawQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    } catch { /* ignore if index exists */ }

    await rawQuery(`CREATE TABLE IF NOT EXISTS generations (
        id TEXT,
        user_id TEXT,
        prompt TEXT,
        image_url TEXT,
        cost INTEGER DEFAULT 1,
        created_at ${ts} DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const col of ['image_url TEXT', 'cost INTEGER DEFAULT 1', `created_at ${ts} DEFAULT CURRENT_TIMESTAMP`]) {
        try {
            await rawQuery(`ALTER TABLE generations ADD COLUMN ${usePostgres() ? 'IF NOT EXISTS ' : ''}${col}`);
        } catch { /* column already exists */ }
    }
    initialized.add(key);
}

export async function query(sql, params = []) {
    await ensureSchema();
    return rawQuery(sql, params);
}

// --- Password hashing (scrypt, no native deps) ---
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
    const [, salt, hash] = stored.split('$');
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

// --- Users ---
const PUBLIC_FIELDS = 'id, email, role, credits_balance, created_at';

export async function findUserByEmail(email) {
    const { rows } = await query('SELECT * FROM users WHERE email = ?', [email]);
    return rows[0] || null;
}

export async function findUserById(id) {
    const { rows } = await query(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`, [id]);
    return rows[0] || null;
}

export async function countUsers() {
    const { rows } = await query('SELECT COUNT(*) AS n FROM users');
    return Number(rows[0]?.n || 0);
}

export async function countAdmins() {
    const { rows } = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND password_hash IS NOT NULL");
    return Number(rows[0]?.n || 0);
}

export async function upgradeLegacyUser({ id, password, role }) {
    await query(
        'UPDATE users SET password_hash = ?, role = COALESCE(?, role) WHERE id = ?',
        [hashPassword(password), role || null, id]
    );
    return findUserById(id);
}

export async function createUser({ email, password, role = 'user', credits = 0 }) {
    const id = crypto.randomUUID();
    await query(
        'INSERT INTO users (id, email, password_hash, role, credits_balance) VALUES (?, ?, ?, ?, ?)',
        [id, email, hashPassword(password), role, credits]
    );
    return findUserById(id);
}

export async function listUsers({ search = '', limit = 100 } = {}) {
    const like = `%${search}%`;
    const { rows } = await query(
        `SELECT ${PUBLIC_FIELDS} FROM users WHERE email LIKE ? ORDER BY created_at DESC LIMIT ?`,
        [like, Math.min(Math.max(1, Number(limit) || 100), 500)]
    );
    return rows;
}

export async function adjustCredits(userId, amount) {
    const { changes } = await query(
        'UPDATE users SET credits_balance = MAX(0, credits_balance + ?) WHERE id = ?'.replace(
            'MAX(0,', usePostgres() ? 'GREATEST(0,' : 'MAX(0,'
        ),
        [amount, userId]
    );
    if (!changes) return null;
    return findUserById(userId);
}

export async function setRole(userId, role) {
    await query('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
    return findUserById(userId);
}

// --- Generations ---
export async function recordGeneration(userId, prompt, imageUrl) {
    await query('INSERT INTO generations (id, user_id, prompt, image_url) VALUES (?, ?, ?, ?)', [
        crypto.randomUUID(), userId, prompt, imageUrl
    ]);
}

export async function listGenerations(userId, limit = 50) {
    const { rows } = await query(
        'SELECT id, prompt, image_url, created_at FROM generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        [userId, Math.min(Math.max(1, Number(limit) || 50), 200)]
    );
    return rows;
}

export async function getStats() {
    const users = (await query('SELECT COUNT(*) AS n, COALESCE(SUM(credits_balance),0) AS c FROM users')).rows[0];
    const gens = (await query('SELECT COUNT(*) AS n FROM generations')).rows[0];
    const recent = (await query(
        'SELECT g.prompt, g.image_url, g.created_at, u.email FROM generations g LEFT JOIN users u ON u.id = g.user_id ORDER BY g.created_at DESC LIMIT 10'
    )).rows;
    return {
        totalUsers: Number(users?.n || 0),
        outstandingCredits: Number(users?.c || 0),
        totalGenerations: Number(gens?.n || 0),
        recentGenerations: recent
    };
}

export async function closeStore() {
    for (const db of sqliteHandles.values()) await new Promise(r => db.close(() => r()));
    sqliteHandles.clear();
    initialized.clear();
    if (pgPool) { await pgPool.end().catch(() => {}); pgPool = null; }
}
