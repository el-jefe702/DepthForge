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

export function initDb() {
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
                CREATE TABLE IF NOT EXISTS generations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT,
                    prompt TEXT,
                    cost INTEGER,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                )
            `, (err) => {
                if (err) {
                    console.error('[DB] Error creating tables:', err);
                    reject(err);
                } else {
                    console.log('[DB] Tables initialized successfully.');
                    resolve(db);
                }
            });
        });
    });
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    initDb().then((db) => {
        db.close();
        process.exit(0);
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
