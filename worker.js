import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const staticDir = path.join(__dirname, 'static');
const generatedDir = path.join(staticDir, 'generated');
const uploadsDir = path.join(staticDir, 'uploads');
const dataDir = path.join(__dirname, 'data');

[staticDir, generatedDir, uploadsDir, dataDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const dbPath = process.env.DATABASE_PATH || process.env.DB_PATH || process.env.SUBSCRIPTIONS_DB_PATH || path.join(dataDir, 'depthforge.sqlite');
export const db = new sqlite3.Database(dbPath);

export function initJobsDb(database = db) {
    return new Promise((resolve, reject) => {
        database.run(`
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
            if (err) reject(err);
            else resolve();
        });
    });
}

export function updateJobStatus(id, status, resultUrl = null, error = null, database = db) {
    return new Promise(async (resolve, reject) => {
        const databaseUrl = process.env.DATABASE_URL;
        if (databaseUrl && !databaseUrl.startsWith('sqlite')) {
            try {
                const { default: pg } = await import('pg');
                const client = new pg.Client({ connectionString: databaseUrl });
                await client.connect();
                const res = await client.query(
                    `UPDATE jobs SET status = $1, result_url = COALESCE($2, result_url), error = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
                    [status, resultUrl, error, id]
                );
                await client.end();
                return resolve(res.rowCount);
            } catch (pgErr) {
                console.warn('[Worker] PostgreSQL updateJobStatus error, falling back to SQLite:', pgErr.message);
            }
        }

        database.run(
            `UPDATE jobs SET status = ?, result_url = COALESCE(?, result_url), error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [status, resultUrl, error, id],
            function (err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

function sanitizeBaseUrl(raw) {
    if (!raw) return null;
    let clean = raw.trim();
    while (clean.startsWith('GEMINI_BASE_URL=')) {
        clean = clean.slice('GEMINI_BASE_URL='.length).trim();
    }
    while ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1).trim();
    }
    if (clean.includes('depthforge-geminiy')) {
        clean = clean.replace('depthforge-geminiy', 'depthforge-gemini');
    }
    return clean;
}

function sanitizeToken(raw) {
    if (!raw) return null;
    let clean = raw.trim();
    while (clean.startsWith('CF_AIG_TOKEN=') || clean.startsWith('CLOUDFLARE_AIG_TOKEN=')) {
        clean = clean.split('=')[1].trim();
    }
    while ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1).trim();
    }
    return clean;
}

const sanitizedBaseUrl = sanitizeBaseUrl(process.env.GEMINI_BASE_URL);
const sanitizedCfToken = sanitizeToken(process.env.CF_AIG_TOKEN || process.env.CLOUDFLARE_AIG_TOKEN);

const aiOptions = {
    apiKey: process.env.GEMINI_API_KEY
};

if (sanitizedBaseUrl) {
    aiOptions.httpOptions = {
        baseUrl: sanitizedBaseUrl
    };
    const customHeaders = {};
    if (process.env.GEMINI_API_KEY) {
        customHeaders['x-goog-api-key'] = process.env.GEMINI_API_KEY.trim();
    }
    if (sanitizedCfToken) {
        customHeaders['cf-aig-authorization'] = sanitizedCfToken.startsWith('Bearer ') ? sanitizedCfToken : `Bearer ${sanitizedCfToken}`;
    }
    if (Object.keys(customHeaders).length > 0) {
        aiOptions.httpOptions.headers = customHeaders;
    }
}

let ai;
try {
    ai = new GoogleGenAI(aiOptions);
} catch (aiInitErr) {
    console.error('[Worker AI Init Error] Failed to initialize GoogleGenAI with custom options:', aiInitErr?.message || aiInitErr);
    ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

let noAuthGatewayAi = null;
if (sanitizedBaseUrl && process.env.GEMINI_API_KEY && sanitizedCfToken) {
    try {
        noAuthGatewayAi = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY.trim(),
            httpOptions: {
                baseUrl: sanitizedBaseUrl,
                headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY.trim() }
            }
        });
    } catch (e) {
        console.warn('[Worker NoAuthGateway AI Init Error]:', e.message);
    }
}

let altAi = null;
if (sanitizedBaseUrl && process.env.GEMINI_API_KEY) {
    const altUrl = sanitizedBaseUrl.includes('depthforge-geminiy')
        ? sanitizedBaseUrl.replace('depthforge-geminiy', 'depthforge-gemini')
        : (sanitizedBaseUrl.includes('depthforge-gemini')
            ? sanitizedBaseUrl.replace('depthforge-gemini', 'depthforge-geminiy')
            : null);
    if (altUrl && altUrl !== sanitizedBaseUrl) {
        try {
            const altHeaders = { 'x-goog-api-key': process.env.GEMINI_API_KEY.trim() };
            if (sanitizedCfToken) {
                altHeaders['cf-aig-authorization'] = sanitizedCfToken.startsWith('Bearer ') ? sanitizedCfToken : `Bearer ${sanitizedCfToken}`;
            }
            altAi = new GoogleGenAI({
                apiKey: process.env.GEMINI_API_KEY.trim(),
                httpOptions: {
                    baseUrl: altUrl,
                    headers: altHeaders
                }
            });
        } catch (e) {
            console.warn('[Worker Alt AI Init Error]:', e.message);
        }
    }
}

let directAi = null;
if (process.env.GEMINI_API_KEY) {
    try {
        directAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
    } catch (e) {
        console.warn('[Worker Direct AI Init Error]:', e.message);
    }
}

async function runWithAiFallback(operation) {
    const clients = [
        { name: 'primary-ai', client: ai },
        { name: 'no-auth-gateway-ai', client: noAuthGatewayAi },
        { name: 'alt-gateway-ai', client: altAi },
        { name: 'direct-google-ai', client: directAi }
    ].filter(item => !!item.client);

    let lastError = null;
    for (const { name, client } of clients) {
        try {
            return await operation(client);
        } catch (err) {
            lastError = err;
            const errMsg = String(err?.message || err || '');
            const isRetryable = errMsg.includes('AiGatewayError') ||
                                errMsg.includes('2009') ||
                                errMsg.includes('Unauthorized') ||
                                errMsg.includes('FAILED_PRECONDITION') ||
                                errMsg.includes('location is not supported') ||
                                errMsg.includes('fetch failed');
            if (isRetryable && clients.length > 1) {
                console.warn(`[Worker AI Fallback] ${name} failed (${errMsg}), trying next client...`);
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}

export function getDepthModifier(intensity = 70) {
    const num = Number(intensity);
    const val = Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : 70;
    if (val <= 30) {
        return "gentle, shallow relief with subtle height transitions";
    }
    if (val >= 70) {
        return "dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief";
    }
    return "";
}

export function buildFinalPrompt(improvedPrompt, depthIntensity = 70) {
    const modifier = getDepthModifier(depthIntensity);
    const depthModifierClause = modifier ? `DEPTH INTENSITY: ${modifier}. ` : '';
    return `A perfect, ultra-smooth 3D grayscale height map of ${improvedPrompt}. ` +
        depthModifierClause +
        "CRITICAL: The subject must be ISOLATED on a PURE BLACK BACKGROUND (#000000). " +
        "STYLE: Flawless, continuous gradients. Soft, airbrushed shading to represent height. " +
        "TECHNICAL: Pure black to pure white linear Z-axis distribution. " +
        "OUTPUT: Pure black and white height map ONLY. No color, no text, no borders.\n";
}

async function generateImagesViaRestPredict({ baseUrl, apiKey, prompt, numImages = 1, aspectRatio = '1:1', cfToken = null }) {
    if (!apiKey) return null;
    const candidateModels = ['imagen-3.0-generate-002', 'imagen-4.0-generate-001', 'imagen-4.0-fast-generate-001'];
    const headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
    };
    if (cfToken) {
        headers['cf-aig-authorization'] = cfToken.startsWith('Bearer ') ? cfToken : `Bearer ${cfToken}`;
    }

    const host = baseUrl || 'https://generativelanguage.googleapis.com';
    for (const model of candidateModels) {
        try {
            const url = `${host}/v1beta/models/${model}:predict?key=${apiKey}`;
            const body = {
                instances: [{ prompt: prompt }],
                parameters: {
                    sampleCount: numImages,
                    aspectRatio: aspectRatio
                }
            };
            const resp = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });
            if (!resp.ok) {
                const errText = await resp.text();
                console.warn(`[Worker ImageGen REST] ${model} returned ${resp.status}: ${errText}`);
                continue;
            }
            const data = await resp.json();
            const generatedImages = [];
            if (Array.isArray(data?.predictions)) {
                for (const pred of data.predictions) {
                    const b64 = pred?.bytesBase64Encoded || pred?.image?.imageBytes;
                    if (b64) {
                        generatedImages.push({
                            image: { imageBytes: b64 }
                        });
                    }
                }
            }
            if (generatedImages.length > 0) {
                return { generatedImages };
            }
        } catch (e) {
            console.warn(`[Worker ImageGen REST] ${model} fetch error:`, e.message);
        }
    }
    return null;
}

async function generateImagesWithFallback(params) {
    if (process.env.NODE_ENV === 'test') {
        return await ai.models.generateImages(params);
    }

    const prompt = params.prompt || '';
    const numImages = params?.config?.numberOfImages || 1;
    const aspectRatio = params?.config?.aspectRatio || '1:1';
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;

    // 1. Try native Google AI Studio Imagen predict via Cloudflare Gateway / Base URL
    const gatewayUrls = [
        sanitizedBaseUrl,
        'https://gateway.ai.cloudflare.com/v1/6719c1f96fb5d0cacd2969483878e1f6/depthforge-gemini/google-ai-studio'
    ].filter(Boolean);

    const seenUrls = new Set();
    for (const gUrl of gatewayUrls) {
        if (seenUrls.has(gUrl)) continue;
        seenUrls.add(gUrl);
        try {
            const restResult = await generateImagesViaRestPredict({
                baseUrl: gUrl,
                apiKey,
                prompt,
                numImages,
                aspectRatio,
                cfToken: sanitizedCfToken
            });
            if (restResult?.generatedImages?.length) {
                return restResult;
            }
        } catch (restErr) {
            console.warn(`[Worker ImageGen REST] Gateway ${gUrl} attempt failed:`, restErr?.message || restErr);
        }
    }

    // 2. Try SDK models via runWithAiFallback
    return await runWithAiFallback(async (activeAi) => {
        let lastModelErr = null;
        const candidateModels = [params?.model, 'imagen-4.0-fast-generate-001', 'imagen-4.0-generate-001', 'imagen-3.0-generate-002'].filter(Boolean);
        const seen = new Set();
        for (const modelName of candidateModels) {
            if (seen.has(modelName)) continue;
            seen.add(modelName);
            try {
                const res = await activeAi.models.generateImages({
                    ...params,
                    model: modelName
                });
                if (res?.generatedImages?.length) return res;
            } catch (err) {
                lastModelErr = err;
                if (process.env.NODE_ENV === 'test') {
                    throw err;
                }
                console.warn(`[Worker ImageGen] generateImages unavailable for ${modelName} (${err?.message || err}), trying next candidate...`);
            }
        }

        const imageModels = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image-preview'];
        for (const imgModel of imageModels) {
            try {
                const tasks = Array.from({ length: numImages }, () =>
                    activeAi.models.generateContent({
                        model: imgModel,
                        contents: prompt,
                        config: {
                            responseModalities: ['TEXT', 'IMAGE'],
                            imageConfig: {
                                aspectRatio: aspectRatio
                            }
                        }
                    })
                );

                const responses = await Promise.all(tasks);
                const generatedImages = [];
                for (const r of responses) {
                    const part = r?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
                    if (part?.inlineData?.data) {
                        generatedImages.push({
                            image: {
                                imageBytes: part.inlineData.data
                            }
                        });
                    }
                }

                if (generatedImages.length > 0) {
                    return { generatedImages };
                }
            } catch (modelErr) {
                lastModelErr = modelErr;
                console.warn(`[Worker ImageGen] ${imgModel} fallback failed (${modelErr?.message || modelErr}), trying next candidate...`);
            }
        }

        if (lastModelErr) {
            throw lastModelErr;
        }
        throw new Error('No image returned from the AI model.');
    });
}

export function runProcessor(command, inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const pythonBin = process.env.PYTHON_BIN || 'python';
        let proc = spawn(pythonBin, ['processor.py', command, inputPath, outputPath]);
        let stderr = '';
        let stdout = '';

        proc.on('error', (err) => {
            if (err.code === 'ENOENT' && pythonBin === 'python') {
                const proc3 = spawn('python3', ['processor.py', command, inputPath, outputPath]);
                proc3.stdout.on('data', (d) => { stdout += d.toString(); });
                proc3.stderr.on('data', (d) => { stderr += d.toString(); });
                proc3.on('close', (code) => {
                    if (code === 0) resolve({ stdout, outputPath });
                    else reject(new Error(`processor.py exited with code ${code}: ${stderr || stdout}`));
                });
                proc3.on('error', (err2) => reject(err2));
            } else {
                reject(err);
            }
        });

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, outputPath });
            } else {
                reject(new Error(`processor.py exited with code ${code}: ${stderr || stdout}`));
            }
        });
    });
}

export async function processJob(job) {
    const data = job.data || {};
    const id = data.jobId || data.id || job.id;
    console.log(`[Worker] Starting job ${id}...`);

    await updateJobStatus(id, 'processing');

    try {
        let smoothedPath = path.join(generatedDir, `${id}_depth.png`);
        let rawPath = data.rawPath;

        if (!rawPath && data.prompt) {
            const finalPrompt = buildFinalPrompt(data.prompt, data.depthIntensity);
            const result = await generateImagesWithFallback({
                prompt: finalPrompt,
                config: {
                    numberOfImages: Math.min(Math.max(1, parseInt(data.numberOfImages, 10) || 1), 4),
                    aspectRatio: data.aspectRatio || '1:1'
                }
            });

            const item = result.generatedImages[0];
            if (!item?.image?.imageBytes) {
                throw new Error('Failed to retrieve image bytes from model');
            }

            rawPath = path.join(uploadsDir, `${id}_raw.png`);
            const imgBuffer = Buffer.from(item.image.imageBytes, 'base64');
            fs.writeFileSync(rawPath, imgBuffer);
        }

        if (!rawPath || !fs.existsSync(rawPath)) {
            throw new Error(`Raw input image not found for job ${id}`);
        }

        try {
            await runProcessor('smooth', rawPath, smoothedPath);
        } catch (procErr) {
            console.error(`[Worker] Processor smooth error on job ${id}:`, procErr.message);
            if (fs.existsSync(rawPath)) {
                fs.copyFileSync(rawPath, smoothedPath);
            } else {
                throw procErr;
            }
        }

        const { uploadGeneratedImage } = await import('./storage.js');
        const resultUrl = await uploadGeneratedImage(smoothedPath, `${id}_depth.png`);
        await updateJobStatus(id, 'completed', resultUrl);
        console.log(`[Worker] Completed job ${id} -> ${resultUrl}`);
        return { id, url: resultUrl, status: 'completed' };
    } catch (err) {
        console.error(`[Worker] Error processing job ${id}:`, err);
        await updateJobStatus(id, 'failed', null, err.message);
        throw err;
    }
}

export const QUEUE_NAME = 'image-generation';
export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export function getRedisConnection() {
    const client = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy(times) {
            return Math.min(times * 200, 3000);
        }
    });
    client.on('error', (err) => {
        console.warn(`[Worker Redis Warning]: ${err.message}`);
    });
    return client;
}

let workerInstance = null;
export function startWorker() {
    initJobsDb();
    const connection = getRedisConnection();
    workerInstance = new Worker(QUEUE_NAME, processJob, {
        connection,
        concurrency: parseInt(process.env.WORKER_CONCURRENCY || '2', 10)
    });

    workerInstance.on('completed', (job) => {
        console.log(`[Worker] Job ${job.id} marked as completed in BullMQ.`);
    });

    workerInstance.on('failed', (job, err) => {
        console.error(`[Worker] Job ${job?.id} marked as failed in BullMQ:`, err.message);
    });

    console.log(`[Worker] DepthForge background worker started listening on '${QUEUE_NAME}'`);
    return workerInstance;
}

const isDirectRun = process.argv[1] && (
    process.argv[1].endsWith('worker.js') ||
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
);

if (isDirectRun) {
    startWorker();
}
