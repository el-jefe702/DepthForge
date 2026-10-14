import fs from 'fs';
import path from 'path';

try {
    let serverCode = fs.readFileSync('server.js', 'utf8');
    let cbCode = fs.readFileSync('credit-backend.js', 'utf8');

    if (!cbCode.includes('deductCredit')) {
        cbCode += `\nexport const deductCredit = (userId, prompt, imageUrl) => {
    return new Promise(async (resolve, reject) => {
        try {
            const sqlite3 = (await import('sqlite3')).default;
            const path = await import('path');
            const dbPath = process.env.SUBSCRIPTIONS_DB_PATH || path.join(process.cwd(), 'data', 'subscriptions.db');
            const localDb = new sqlite3.Database(dbPath);
            
            localDb.serialize(() => {
                localDb.run('BEGIN TRANSACTION');
                localDb.run('UPDATE users SET credits_balance = credits_balance - 1 WHERE id = ? AND credits_balance > 0', [userId], function(err) {
                    if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                    if (this.changes === 0) { localDb.run('ROLLBACK'); localDb.close(); return reject(new Error('Insufficient credits')); }
                    localDb.run('INSERT INTO generations (user_id, prompt, image_url) VALUES (?, ?, ?)', [userId, prompt, imageUrl], function(err) {
                        if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                        localDb.get('SELECT credits_balance FROM users WHERE id = ?', [userId], (err, row) => {
                            if (err) { localDb.run('ROLLBACK'); localDb.close(); return reject(err); }
                            localDb.run('COMMIT', err => {
                                localDb.close();
                                if (err) return reject(err);
                                resolve(row.credits_balance);
                            });
                        });
                    });
                });
            });
        } catch (err) {
            reject(err);
        }
    });
};\n`;
        fs.writeFileSync('credit-backend.js', cbCode);
        console.log('Patched credit-backend.js');
    }

    let serverModified = false;
    if (!serverCode.includes('deductCredit')) {
        serverCode = serverCode.replace(
            "import { addCredits } from './credit-backend.js';",
            "import { addCredits, deductCredit } from './credit-backend.js';"
        );
        serverModified = true;
    }

    if (!serverCode.includes('creditDeductionMiddleware')) {
        const middlewareCode = `
const creditDeductionMiddleware = (req, res, next) => {
    const originalJson = res.json;
    res.json = function (body) {
        const userId = req.user?.id || req.userId || (typeof req.user === 'string' ? req.user : null);
        if (res.statusCode === 200 && body && !body.error && userId) {
            Promise.resolve().then(async () => {
                try {
                    const imageUrl = body.imageUrl || body.url || body.image_url || (body.generatedImages && body.generatedImages[0] && body.generatedImages[0].url) || '';
                    const newBalance = await deductCredit(userId, req.body.prompt || 'Generation', imageUrl);
                    body.credits_balance = newBalance;
                } catch (err) {
                    console.error('Credit deduction failed:', err);
                }
                originalJson.call(this, body);
            });
            return this;
        }
        return originalJson.call(this, body);
    };
    next();
};
app.use('/api/generate', creditDeductionMiddleware);
app.use('/api/photo-to-depth', creditDeductionMiddleware);
`;
        serverCode = serverCode.replace(
            "app.use('/api/generate', creditGate);",
            "app.use('/api/generate', creditGate);\n" + middlewareCode
        );
        serverModified = true;
    }

    if (!serverCode.includes('catch (processorError)')) {
        const originalServerCode = serverCode;
        serverCode = serverCode.replace(
            /(await\s+runPythonProcessor\([^)]+\)\s*;)/g,
            `try { $1 } catch (processorError) { console.error("Processor error:", processorError); throw new Error("Post-processing failed: " + processorError.message); }`
        );
        
        serverCode = serverCode.replace(
            /(await\s+new\s+Promise\s*\(\s*\(\s*resolve\s*,\s*reject\s*\)\s*=>\s*\{[\s\S]*?spawn\(['"`]python3['"`],\s*\['"`]processor\.py['"`][\s\S]*?\}\s*\)\s*;)/g,
            `try { $1 } catch (processorError) { console.error("Processor error:", processorError); throw new Error("Post-processing failed: " + processorError.message); }`
        );
        
        if (serverCode !== originalServerCode) {
            serverModified = true;
        }
    }

    if (serverModified) {
        fs.writeFileSync('server.js', serverCode);
        console.log('Patched server.js');
    }
} catch (err) {
    console.error('Patch failed:', err);
}
