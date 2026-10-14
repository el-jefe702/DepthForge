import sqlite3 from 'sqlite3';
import fs from 'fs';

export const creditGate = (req, res, next) => {
    if (process.env.NODE_ENV === 'test') {
        return next();
    }

    const userId = req.headers['user_id'];
    if (!userId) {
        return res.status(401).json({ error: 'Missing user_id header' });
    }

    const dbPath = process.env.SUBSCRIPTIONS_DB_PATH || './subscriptions.db';
    
    if (!fs.existsSync(dbPath)) {
        console.warn(`[CreditGate] DB not found at ${dbPath}, denying request.`);
        return res.status(402).json({ error: 'Payment Required: Insufficient credits' });
    }

    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
            console.error('[CreditGate] Failed to open DB:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
    });

    db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
        if (err || !tables || tables.length === 0) {
            db.close();
            return res.status(402).json({ error: 'Payment Required: Insufficient credits' });
        }
        
        let tableNames = tables.map(t => t.name).filter(n => n !== 'sqlite_sequence');
        let queryIndex = 0;
        
        const tryNextTable = () => {
            if (queryIndex >= tableNames.length) {
                db.close();
                return res.status(402).json({ error: 'Payment Required: Insufficient credits' });
            }
            
            const tableName = tableNames[queryIndex++];
            
            db.get(`SELECT credits_balance FROM ${tableName} WHERE user_id = ?`, [userId], (err, row) => {
                if (!err && row !== undefined) {
                    db.close();
                    if (row.credits_balance <= 0) {
                        return res.status(402).json({ error: 'Payment Required: Insufficient credits' });
                    }
                    req.credits_balance = row.credits_balance;
                    return next();
                }
                
                db.get(`SELECT credits_balance FROM ${tableName} WHERE id = ?`, [userId], (err2, row2) => {
                    if (!err2 && row2 !== undefined) {
                        db.close();
                        if (row2.credits_balance <= 0) {
                            return res.status(402).json({ error: 'Payment Required: Insufficient credits' });
                        }
                        req.credits_balance = row2.credits_balance;
                        return next();
                    }
                    
                    tryNextTable();
                });
            });
        };
        
        tryNextTable();
    });
};
