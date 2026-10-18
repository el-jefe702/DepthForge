import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'depthforge.sqlite');

let pgPool = null;

export async function getDbClient() {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl && !databaseUrl.startsWith('sqlite')) {
        if (!pgPool) {
            try {
                const { default: pg } = await import('pg');
                pgPool = new pg.Pool({ connectionString: databaseUrl });
            } catch (err) {
                console.warn('[DB] PostgreSQL driver not loaded, falling back to SQLite:', err.message);
            }
        }
        if (pgPool) {
            return {
                type: 'postgres',
                query: async (sql, params = []) => {
                    let idx = 1;
                    const pgSql = sql.replace(/\?/g, () => `$${idx++}`);
                    const res = await pgPool.query(pgSql, params);
                    return res.rows;
                },
                close: async () => {
                    await pgPool.end();
                    pgPool = null;
                }
            };
        }
    }

    const db = new sqlite3.Database(dbPath);
    return {
        type: 'sqlite',
        query: (sql, params = []) => {
            return new Promise((resolve, reject) => {
                if (sql.trim().toUpperCase().startsWith('SELECT')) {
                    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
                } else {
                    db.run(sql, params, function (err) {
                        if (err) reject(err);
                        else resolve({ lastID: this.lastID, changes: this.changes });
                    });
                }
            });
        },
        close: () => {
            return new Promise((resolve) => db.close(resolve));
        }
    };
}

export async function initDb() {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl && !databaseUrl.startsWith('sqlite')) {
        try {
            const { default: pg } = await import('pg');
            const pool = new pg.Pool({ connectionString: databaseUrl });
            await pool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE,
                    stripe_customer_id TEXT,
                    credits_balance INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS credit_wallets (
                    user_id TEXT PRIMARY KEY,
                    credits_balance INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS generations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(id),
                    prompt TEXT,
                    image_url TEXT,
                    cost INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'queued',
                    prompt TEXT,
                    style_preset TEXT,
                    result_url TEXT,
                    error TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);
            console.log('[DB] Connected and initialized PostgreSQL database tables.');
            return pool;
        } catch (err) {
            console.warn('[DB] Could not connect to PostgreSQL, falling back to SQLite:', err.message);
        }
    }

    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('[DB] Error connecting to SQLite:', err);
                return reject(err);
            }
            console.log(`[DB] Connected to SQLite at ${dbPath}`);
        });

        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE,
                    stripe_customer_id TEXT,
                    credits_balance INTEGER DEFAULT 0
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS credit_wallets (
                    user_id TEXT PRIMARY KEY,
                    credits_balance INTEGER DEFAULT 0
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS generations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT,
                    prompt TEXT,
                    image_url TEXT,
                    cost INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'queued',
                    prompt TEXT,
                    style_preset TEXT,
                    result_url TEXT,
                    error TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) {
                    console.error('[DB] Error creating tables:', err);
                    reject(err);
                } else {
                    console.log('[DB] SQLite tables initialized successfully.');
                    resolve(db);
                }
            });
        });
    });
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    initDb().then((db) => {
        if (db && typeof db.close === 'function') db.close();
        else if (db && typeof db.end === 'function') db.end();
        process.exit(0);
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
