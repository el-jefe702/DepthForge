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
    return new Promise((resolve, reject) => {
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

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

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

async function generateImagesWithFallback(params) {
    try {
        const res = await ai.models.generateImages(params);
        if (res?.generatedImages?.length) return res;
    } catch (err) {
        if (process.env.NODE_ENV === 'test') {
            throw err;
        }
        console.warn(`[Worker ImageGen] generateImages unavailable (${err?.message || err}), falling back to gemini-3.1-flash-image`);
    }

    const prompt = params.prompt || '';
    const numImages = params?.config?.numberOfImages || 1;
    const aspectRatio = params?.config?.aspectRatio || '1:1';

    const tasks = Array.from({ length: numImages }, () =>
        ai.models.generateContent({
            model: 'gemini-3.1-flash-image',
            contents: prompt,
            config: {
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

    if (!generatedImages.length) {
        throw new Error('No image returned from the AI model.');
    }

    return { generatedImages };
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

        const resultUrl = `/static/generated/${id}_depth.png`;
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
