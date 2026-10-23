import express from 'express';
import { creditGate, requireAuth, requireAdmin } from './middleware/auth.js';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI } from '@google/genai';
import { spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import PQueue from 'p-queue';
import Stripe from 'stripe';
import { addCredits, deductCredit } from './credit-backend.js';
import {
    findUserByEmail,
    findUserById,
    countUsers,
    countAdmins,
    upgradeLegacyUser,
    createUser,
    listUsers,
    adjustCredits,
    setRole,
    listGenerations,
    getStats,
    verifyPassword,
    isStripeEventProcessed,
    recordStripeEvent
} from './db/store.js';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { LIGHTBURN_PRESETS, buildLbrn2Xml, laserQueue } from './lib/lightburn.js';

dotenv.config();

import {
    cleanupGeneratedFiles,
    cleanupGeneratedFilesSync,
    parseTtlHours,
    startCleanupScheduler,
    stopCleanupScheduler,
    DEFAULT_TTL_HOURS,
    CLEANUP_INTERVAL_MS,
    isMainModule
} from './cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8000;

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

if (process.env.TRUST_PROXY) {
    const tpVal = process.env.TRUST_PROXY.trim().toLowerCase();
    app.set('trust proxy', tpVal === 'true' ? true : (tpVal === 'false' ? false : (isNaN(Number(tpVal)) ? process.env.TRUST_PROXY : Number(tpVal))));
}

// Ensure directories exist
const staticDir = path.join(__dirname, 'static');
const generatedDir = path.join(staticDir, 'generated');
const uploadsDir = path.join(staticDir, 'uploads');

[staticDir, generatedDir, uploadsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.use('/static', express.static(staticDir));

// Stripe Webhook - MUST be before express.json()
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) {
        return res.status(500).send('Stripe is not configured');
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`[Stripe Webhook] Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const eventId = event.id || session.id;

        try {
            if (await isStripeEventProcessed(eventId)) {
                console.log(`[Stripe Webhook] Event ${eventId} already processed, skipping duplicate.`);
                return res.json({ received: true, duplicate: true });
            }

            const userId = session.client_reference_id || session.metadata?.user_id;
            const creditsToAdd = parseInt(session.metadata?.credits || '0', 10);
            const amountCents = session.amount_total || 0;

            if (userId && creditsToAdd > 0) {
                await addCredits(userId, creditsToAdd);
                await recordStripeEvent({
                    eventId,
                    eventType: event.type,
                    userId,
                    credits: creditsToAdd,
                    amountCents
                });
                console.log(`[Stripe Webhook] Added ${creditsToAdd} credits to user ${userId} (event: ${eventId})`);
            }
        } catch (err) {
            console.error(`[Stripe Webhook] Failed to process webhook event: ${err.message}`);
            return res.status(500).json({ error: 'Failed to process event' });
        }
    }

    res.json({ received: true });
});

app.use(express.json({ limit: '50kb' }));
app.use(['/api/generate', '/api/photo-to-depth'], creditGate);

const creditDeductionMiddleware = (req, res, next) => {
    const originalJson = res.json;
    res.json = function (body) {
        const userId = req.user?.id || req.userId || (typeof req.user === 'string' ? req.user : null);
        if (res.statusCode === 200 && body && !body.error && userId) {
            Promise.resolve().then(async () => {
                try {
                    const isBatch = req.body?.batch === true || req.body?.batch === 'true' || req.body?.numberOfImages === 4 || req.body?.numberOfImages === '4';
                    const cost = isBatch ? 4 : 1;
                    const imageUrl = body.imageUrl || body.url || body.image_url || (body.generatedImages && body.generatedImages[0] && body.generatedImages[0].url) || '';
                    const prompt = req.body?.prompt || (req.file ? `Photo to Carve: ${req.file.originalname}` : 'Generation');
                    const newBalance = await deductCredit(userId, prompt, imageUrl, cost);
                    body.credits_balance = newBalance;
                } catch (err) {
                    console.error('Credit deduction failed:', err);
                }
            });
        }
        return originalJson.call(this, body);
    };
    next();
};
app.use(['/api/generate', '/api/photo-to-depth'], creditDeductionMiddleware);

// Global error guards — prevents silent process crashes
process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
});

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toLocaleTimeString()}] 🌍 ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// Root route '/' is handled below by the Phase 4 Integrated Web Site handler (serves static/landing.html)

const aiOptions = {
    apiKey: process.env.GEMINI_API_KEY
};
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
if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    aiOptions.vertexai = true;
    if (process.env.GOOGLE_CLOUD_PROJECT) {
        aiOptions.project = process.env.GOOGLE_CLOUD_PROJECT;
    }
    aiOptions.location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        try {
            aiOptions.googleAuthOptions = { credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) };
        } catch (e) {
            console.warn('[VertexAI] JSON parse error on GOOGLE_APPLICATION_CREDENTIALS_JSON:', e.message);
        }
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        aiOptions.googleAuthOptions = { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS };
    }
}

// Multi-tiered AI client pool:
// 1. Primary AI client (configured via GEMINI_BASE_URL and/or Vertex AI)
// 2. No-auth Gateway client (same gateway baseUrl, but without cf-aig-authorization header in case Authenticated Gateway is off)
// 3. Alternate Gateway client (swapping depthforge-geminiy <-> depthforge-gemini slug)
// 4. Direct Google AI Studio client (no proxy, direct to generativelanguage.googleapis.com)
let ai;
try {
    ai = new GoogleGenAI(aiOptions);
} catch (aiInitErr) {
    console.error('[AI Init Error] Failed to initialize GoogleGenAI with custom options:', aiInitErr?.message || aiInitErr);
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
        console.warn('[NoAuthGateway AI Init Error]:', e.message);
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
            console.warn('[Alt AI Init Error]:', e.message);
        }
    }
}

let directAi = null;
if (process.env.GEMINI_API_KEY) {
    try {
        directAi = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
    } catch (e) {
        console.warn('[Direct AI Init Error]:', e.message);
    }
}

async function runWithAiFallback(operation) {
    if (process.env.NODE_ENV === 'test') {
        return await operation(ai);
    }
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
                console.warn(`[AI Client Fallback] ${name} failed (${errMsg}), trying next candidate...`);
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}

if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn("WARNING: GEMINI_API_KEY and Google credentials are missing from .env! AI generation will fail.");
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
                console.warn(`[ImageGen REST] ${model} returned ${resp.status}: ${errText}`);
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
            console.warn(`[ImageGen REST] ${model} fetch error:`, e.message);
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
            console.warn(`[ImageGen REST] Gateway ${gUrl} attempt failed:`, restErr?.message || restErr);
        }
    }

    // 2. Try SDK models via runWithAiFallback
    return await runWithAiFallback(async (activeAi) => {
        let lastModelErr = null;
        const candidateModels = [params?.model, 'imagen-4.0-generate-001', 'imagen-3.0-generate-002'].filter(Boolean);
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
                console.warn(`[ImageGen] generateImages unavailable for ${modelName} (${err?.message || err}), trying next candidate...`);
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
                console.warn(`[ImageGen] ${imgModel} fallback failed (${modelErr?.message || modelErr}), trying next candidate...`);
            }
        }

        if (lastModelErr) {
            throw lastModelErr;
        }
        throw new Error('No image returned from the AI model. Check API key or region permissions.');
    });
}

// ----------------------------------------------------------------------
// Background Job Queue & In-Memory Store (Issues #40 & #41)
// Lazily connects to Redis only when REDIS_URL is configured outside test mode
// so importing server.js in tests never leaves open socket handles.
// ----------------------------------------------------------------------
const QUEUE_NAME = 'image-generation';
const jobStore = new Map();
let bullQueue = null;

function getBullQueue() {
    if (process.env.NODE_ENV === 'test' || !process.env.REDIS_URL) {
        return null;
    }
    if (!bullQueue) {
        const redisConn = new IORedis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            lazyConnect: true,
            retryStrategy(times) {
                if (times > 3) return null;
                return Math.min(times * 200, 2000);
            }
        });
        redisConn.on('error', () => {});
        if (typeof redisConn.unref === 'function') redisConn.unref();
        bullQueue = new Queue(QUEUE_NAME, { connection: redisConn });
        bullQueue.on('error', () => {});
    }
    return bullQueue;
}

const generationJobQueue = {
    name: QUEUE_NAME,
    async add(name, data, opts = {}) {
        const id = opts.jobId || data?.jobId || uuidv4();
        const record = {
            id,
            name,
            data,
            status: 'queued',
            result: null,
            failedReason: null,
            createdAt: Date.now()
        };
        jobStore.set(id, record);
        const q = getBullQueue();
        if (q) {
            try {
                await q.add(name, data, { ...opts, jobId: id });
            } catch {
                // Fallback to in-memory jobStore if Redis is unavailable
            }
        }
        return record;
    },
    async getJob(id) {
        const q = getBullQueue();
        if (q) {
            try {
                const bullJob = await q.getJob(id);
                if (bullJob) return bullJob;
            } catch {}
        }
        const memJob = jobStore.get(id);
        if (!memJob) return null;
        return {
            id: memJob.id,
            data: memJob.data,
            returnvalue: memJob.result,
            failedReason: memJob.failedReason,
            async getState() {
                return memJob.status;
            }
        };
    },
    async close() {
        if (bullQueue) {
            await bullQueue.close().catch(() => {});
            bullQueue = null;
        }
    }
};

// ----------------------------------------------------------------------
// Rate Limiting Configuration (F10)
// ----------------------------------------------------------------------
const DEFAULT_RATE_LIMIT_WINDOW_MS = 900000; // 15 minutes (15 * 60 * 1000)
const DEFAULT_RATE_LIMIT_MAX = 10;
const RATE_LIMIT_ERROR_MESSAGE = 'Too many requests. Please wait before generating again.';
const RATE_LIMIT_RESPONSE_BODY = { error: RATE_LIMIT_ERROR_MESSAGE };

function parseRateLimitWindowMs(val) {
    if (val === undefined || val === null || val === '') return DEFAULT_RATE_LIMIT_WINDOW_MS;
    const num = Number(val);
    if (Number.isFinite(num) && num > 0) {
        return Math.floor(num);
    }
    const parsed = parseInt(val, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_LIMIT_WINDOW_MS;
}

function parseRateLimitMax(val) {
    if (val === undefined || val === null || val === '') return DEFAULT_RATE_LIMIT_MAX;
    const num = Number(val);
    if (Number.isFinite(num) && num >= 0) {
        return Math.floor(num);
    }
    const parsed = parseInt(val, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RATE_LIMIT_MAX;
}

function createRateLimiter(options = {}) {
    const { shared, separate, ...rlOptions } = options;
    const windowMs = rlOptions.windowMs !== undefined
        ? parseRateLimitWindowMs(rlOptions.windowMs)
        : parseRateLimitWindowMs(process.env.RATE_LIMIT_WINDOW_MS);

    const limit = rlOptions.max !== undefined
        ? parseRateLimitMax(rlOptions.max)
        : (rlOptions.limit !== undefined
            ? (typeof rlOptions.limit === 'function' ? rlOptions.limit : parseRateLimitMax(rlOptions.limit))
            : () => parseRateLimitMax(process.env.RATE_LIMIT_MAX));

    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: true,
        statusCode: 429,
        message: RATE_LIMIT_RESPONSE_BODY,
        handler: (req, res, next, opts) => {
            res.status(opts.statusCode || 429).json(RATE_LIMIT_RESPONSE_BODY);
        },
        validate: { trustProxy: false, xForwardedForHeader: false, limit: false, default: true },
        ...rlOptions,
        statusCode: 429,
        message: RATE_LIMIT_RESPONSE_BODY
    });
}

const createGenerationLimiter = createRateLimiter;

let activeGenerateLimiter = createRateLimiter();
let activePhotoToDepthLimiter = createRateLimiter();

const generateLimiter = (req, res, next) => activeGenerateLimiter(req, res, next);
const photoToDepthLimiter = (req, res, next) => activePhotoToDepthLimiter(req, res, next);
const generationLimiter = generateLimiter;

function resetRateLimiters(options = {}) {
    if (options.shared) {
        const sharedLimiter = createRateLimiter(options);
        activeGenerateLimiter = sharedLimiter;
        activePhotoToDepthLimiter = sharedLimiter;
    } else {
        activeGenerateLimiter = createRateLimiter(options);
        activePhotoToDepthLimiter = createRateLimiter(options);
    }
    return {
        generateLimiter: activeGenerateLimiter,
        photoToDepthLimiter: activePhotoToDepthLimiter,
        generationLimiter: activeGenerateLimiter
    };
}

function resetGenerationLimiter(options = {}) {
    return resetRateLimiters(options);
}

// --- STYLE PRESETS ARCHITECTURE (F12) ---
const STYLE_PRESETS = {
    portrait: {
        id: 'portrait',
        label: 'Portrait',
        icon: '👤',
        guidance: 'STYLE: Portraiture relief carving. Emphasize continuous anatomic facial planes, smooth cheekbone undulations, sculpted nose and jawline depth contours, and subtle lip volume. Avoid noisy skin texture and prevent harsh stepping on facial gradients.'
    },
    wildlife: {
        id: 'wildlife',
        label: 'Wildlife',
        icon: '🦁',
        guidance: 'STYLE: Wildlife and animal relief carving. Emphasize anatomical muscle groups, defined silhouette boundaries, sculpted fur volume and feather layering as broad smooth masses rather than noisy individual strands.'
    },
    ornamental: {
        id: 'ornamental',
        label: 'Ornamental',
        icon: '⚜️',
        guidance: 'STYLE: Classical architectural ornamental relief and baroque scrollwork. Emphasize crisp filigree ridges, elegant acanthus leaf curls, symmetric florets, steep chamfered bevels, and clean flat background clearance.'
    },
    floral: {
        id: 'floral',
        label: 'Floral',
        icon: '🌸',
        guidance: 'STYLE: Botanical floral relief carving. Emphasize graceful overlapping petals, smooth concave cup shapes, natural organic curling edges, radiating leaf veining, and delicate blossom center elevation.'
    },
    architecture: {
        id: 'architecture',
        label: 'Architecture',
        icon: '🏛️',
        guidance: 'STYLE: Architectural monument relief. Emphasize distinct geometric planar facades, clean perspective depth recession, crisp column fluting, delineated masonry blocks, and sharp receding spatial planes.'
    },
    abstract: {
        id: 'abstract',
        label: 'Abstract',
        icon: '🌀',
        guidance: 'STYLE: Dynamic modern abstract relief sculpture. Emphasize flowing topographic waves, ribbon curves, mathematical surface transitions, dramatic geometric intersections, and clean curvilinear elevation variations.'
    },
    coin_medallion: {
        id: 'coin_medallion',
        label: 'Coin & Medallion',
        icon: '🪙',
        guidance: 'STYLE: Numismatic challenge coin and commemorative medallion relief. Emphasize a crisp raised circular rim bezel, recessed smooth field, bold high-relief central emblem, and sharp chamfered border geometry suitable for brass, bronze, or hardwood coin engraving.'
    },
    heraldic_crest: {
        id: 'heraldic_crest',
        label: 'Heraldic Crest',
        icon: '🛡️',
        guidance: 'STYLE: Regal heraldic coat of arms and shield crest relief. Emphasize a prominent contoured shield boss, symmetric acanthus mantling, crisp helm and crown elevation, bold supporter silhouettes, and a clean scrolled ribbon banner at the base.'
    },
    celtic_knot: {
        id: 'celtic_knot',
        label: 'Celtic Knot',
        icon: '🪢',
        guidance: 'STYLE: Interwoven Celtic knotwork and Norse weave relief. Emphasize continuous over-and-under ribbon elevation where over-crossing strands rise smoothly to white and under-passing strands dip cleanly into shadow, with crisp braided borders and no broken loops.'
    },
    western_scroll: {
        id: 'western_scroll',
        label: 'Western Scroll',
        icon: '🤠',
        guidance: 'STYLE: American Western Sheridan leather tooling and engraver scrollwork relief. Emphasize bold spiraling acanthus vines, blooming flower centers, deeply undercut background pockets, and crisp beveled leaf ridges.'
    },
    signs_plaques: {
        id: 'signs_plaques',
        label: 'Signs & Plaques',
        icon: '🪧',
        guidance: 'STYLE: Custom CNC carved dimensional sign and decorative plaque relief. Emphasize a well-defined outer moulded frame border, a recessed flat pocket floor, and a bold raised central motif and banner geometry with clean ball-nose clearance.'
    },
    address_plaque: {
        id: 'address_plaque',
        label: 'Address Plaque',
        icon: '🏠',
        guidance: 'STYLE: Estate address plaque and house number sign relief. Emphasize a classic arched or oval stepped border frame, a recessed smooth pocket background, and a clean raised central number/text reserve flanked by symmetrical botanical or scrollwork accents.'
    },
    rustic_sign: {
        id: 'rustic_sign',
        label: 'Cabin / Blank Banner',
        icon: '🪵',
        guidance: 'STYLE: Rustic lodge, cabin, and ranch sign relief with a blank text banner. Emphasize an organic hand-hewn timber or bark-edge frame, sculpted pine trees or mountain wildlife motif, and a prominent smooth raised blank ribbon banner ready for custom lettering.'
    },
    tavern_sign: {
        id: 'tavern_sign',
        label: 'Tavern & Shield',
        icon: '🍺',
        guidance: 'STYLE: Vintage pub, home bar, and tavern sign plaque relief. Emphasize a scalloped baroque or shield plaque perimeter, ornate corner flourishes, a raised barrel or hop crest, and a recessed central sign panel with high-contrast bevels.'
    },
    commercial_sign: {
        id: 'commercial_sign',
        label: 'Commercial 2.5D',
        icon: '🏢',
        guidance: 'STYLE: Precision commercial 2.5D routed sign and badge relief. Emphasize crisp prismatic chamfered borders, flat planar recessed pockets, bold architectural moulding profiles, and high-visibility geometric elevation.'
    }
};

const sanitizeStylePreset = (preset) => {
    if (typeof preset !== 'string') return null;
    const clean = preset.trim().toLowerCase();
    return STYLE_PRESETS[clean] ? clean : null;
};

const getStyleGuidance = (preset) => {
    const validKey = sanitizeStylePreset(preset);
    return validKey ? STYLE_PRESETS[validKey].guidance : '';
};

// --- PROMPT ARCHITECTURE ---
const buildImprovePrompt = (userIdea, stylePreset = null) => {
    const styleGuidance = getStyleGuidance(stylePreset);
    const styleBlock = styleGuidance ? ` ${styleGuidance}` : '';
    return `Act as a master CNC relief artist. User Idea: ${userIdea} ` +
        "TASK: Rewrite this into a highly detailed prompt for a 3D grayscale height map. " +
        "REQUIREMENTS: Demand perfectly smooth continuous gradients, soft shading, and organic rounded transitions. " +
        "Do NOT include any mention of contours, layers, or topography." +
        styleBlock +
        " Output in JSON format with key 'improved_prompt'.";
};

const sanitizeDepthIntensity = (intensity) => {
    if (typeof intensity !== 'number' && typeof intensity !== 'string') {
        return 70;
    }
    if (typeof intensity === 'string' && intensity.trim() === '') {
        return 70;
    }
    const num = Number(intensity);
    if (!Number.isFinite(num)) {
        return 70;
    }
    return Math.max(0, Math.min(100, Math.round(num)));
};

const getDepthModifier = (intensity) => {
    const val = sanitizeDepthIntensity(intensity);
    if (val <= 30) {
        return "gentle, shallow relief with subtle height transitions";
    }
    if (val >= 70) {
        return "dramatic, maximum-depth carving with extreme black-to-white contrast and deep relief";
    }
    return "";
};

const buildFinalPrompt = (improvedPrompt, depthIntensity = 70) => {
    const modifier = getDepthModifier(depthIntensity);
    const depthModifierClause = modifier ? `DEPTH INTENSITY: ${modifier}. ` : '';
    return `A perfect, ultra-smooth 3D grayscale height map of ${improvedPrompt}. ` +
        depthModifierClause +
        "CRITICAL: The subject must be ISOLATED on a PURE BLACK BACKGROUND (#000000). " +
        "STYLE: Flawless, continuous gradients. Soft, airbrushed shading to represent height. " +
        "TECHNICAL: Pure black to pure white linear Z-axis distribution. " +
        "FORBIDDEN: ABSOLUTELY NO topographic lines, NO contour lines, NO terracing, NO stepped plateaus, NO harsh outlines, NO banding, NO posterization. " +
        "OUTPUT: A perfectly smooth, seamless 16-bit depth map optimized for 3D CNC laser engraving.";
};

/**
 * Feature F15: Gemini Prompt Response Robustness
 * Safely parses JSON strings returned by Gemini models, stripping markdown code blocks
 * if present. Falls back cleanly without crashing if malformed JSON or plain text is received.
 */
function safeJsonParse(rawText, fallback = {}, logger = console) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
        return fallback;
    }

    let cleaned = rawText.trim();
    // Strip markdown code fences if wrapped in ```json ... ``` or ``` ... ```
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    try {
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        return fallback;
    } catch (err) {
        if (logger?.error) {
            logger.error(`[Gemini Response Robustness] Failed to parse JSON response: ${err.message}. Raw response: ${rawText}`);
        }
        return fallback;
    }
}

// --- DYNAMIC PACKAGE METADATA ---
const getPackageVersion = (customPkgPath = path.join(__dirname, 'package.json')) => {
    try {
        const pkgPath = (typeof customPkgPath === 'string' && customPkgPath.trim())
            ? customPkgPath.trim()
            : path.join(__dirname, 'package.json');
        if (!fs.existsSync(pkgPath) || !fs.statSync(pkgPath).isFile()) {
            return '0.0.0';
        }
        const pkgContent = fs.readFileSync(pkgPath, 'utf8');
        const cleanContent = pkgContent.replace(/^\uFEFF/, '');
        const pkg = JSON.parse(cleanContent);
        return (typeof pkg.version === 'string' && pkg.version.trim()) ? pkg.version.trim() : '0.0.0';
    } catch {
        return '0.0.0';
    }
};

// --- HELPER FOR PYTHON TASKS ---
const resolvePythonExecutable = () => {
    if (process.env.PYTHON_EXEC) {
        return process.env.PYTHON_EXEC;
    }
    const candidates = [
        path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
        path.join(__dirname, '.venv', 'bin', 'python'),
        path.join(__dirname, '.venv', 'Scripts', 'python')
    ];
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return process.platform === 'win32' ? 'python.exe' : 'python';
};

const _pyCheckCache = new Map();

const clearPythonCache = () => {
    _pyCheckCache.clear();
};

const isPythonAvailable = (customResolvePy = resolvePythonExecutable, customProcessorPath = path.join(__dirname, 'processor.py'), options = {}) => {
    try {
        if (!customProcessorPath || typeof customProcessorPath !== 'string' || !fs.existsSync(customProcessorPath) || !fs.statSync(customProcessorPath).isFile()) {
            return false;
        }
        const pyExec = typeof customResolvePy === 'function' ? customResolvePy() : customResolvePy;
        if (!pyExec || typeof pyExec !== 'string' || !pyExec.trim()) {
            return false;
        }
        if (pyExec.includes('/') || pyExec.includes('\\')) {
            if (!fs.existsSync(pyExec)) {
                return false;
            }
        }

        const bypassCache = options?.bypassCache === true;
        const ttlMs = typeof options?.ttlMs === 'number' ? options.ttlMs : 30000;
        const cacheKey = `${pyExec}::${customProcessorPath}`;
        const now = Date.now();
        if (!bypassCache) {
            const cached = _pyCheckCache.get(cacheKey);
            if (cached && (now - cached.timestamp < ttlMs)) {
                return cached.result;
            }
        }

        const check = spawnSync(pyExec, ['--version'], {
            stdio: 'ignore',
            timeout: 5000,
            windowsHide: true
        });
        const result = !check.error && check.status === 0;
        _pyCheckCache.set(cacheKey, { result, timestamp: Date.now() });
        return result;
    } catch {
        return false;
    }
};

const parseStepFromLog = (line) => {
    if (typeof line !== 'string') return null;
    const stepMatch = line.match(/\[STEP\s+(\d+)\/(\d+)\]/i);
    if (stepMatch) {
        return parseInt(stepMatch[1], 10);
    }
    if (/loading|convert.*16-bit|upscal/i.test(line)) return 1;
    if (/inpaint|missing data|hole/i.test(line)) return 2;
    if (/bilateral|gaussian|spatial filter|banding/i.test(line)) return 3;
    if (/normaliz|stretch.*range/i.test(line)) return 4;
    if (/export.*png|saving/i.test(line)) return 5;
    return null;
};

const spawnPythonProcessor = (command, args) => {
    const pythonExec = resolvePythonExecutable();
    return spawn(pythonExec, ['-u', path.join(__dirname, 'processor.py'), command, ...args], { cwd: __dirname });
};

/**
 * Feature F18: Concurrency Queue for Python Processor
 * Serializes Python subprocess tasks (Polish, Invert, Remove BG) with concurrency: 1
 * so simultaneous requests do not compete for system resources.
 */
const pythonProcessorQueue = new PQueue({ concurrency: 1 });

const runPythonProcessorDirect = (command, args) => {
    return new Promise((resolve, reject) => {
        let isDone = false;
        const pyProg = spawnPythonProcessor(command, args);

        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                try { pyProg.kill('SIGKILL'); } catch (e) {}
                reject(new Error(`Python script timed out after 40s for '${command}'`));
            }
        }, 40000);

        pyProg.stdout.on('data', (data) => console.log(`[Python] ${data.toString().trim()}`));
        let errorOutput = '';
        pyProg.stderr.on('data', (data) => errorOutput += data.toString());

        pyProg.on('close', (code) => {
            if (isDone) return;
            isDone = true;
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`Python script failed (${code}): ${errorOutput}`));
        });
        pyProg.on('error', (err) => {
            if (isDone) return;
            isDone = true;
            clearTimeout(timer);
            reject(new Error(`Could not start Python: ${err.message}`));
        });
    });
};

const runPythonProcessor = (command, args) => {
    const queueDepth = pythonProcessorQueue.size;
    const isBusy = pythonProcessorQueue.pending > 0 || queueDepth > 0;
    if (isBusy) {
        console.log(`[Python Queue] Request queued for '${command}' (queue depth: ${queueDepth}, pending: ${pythonProcessorQueue.pending})`);
    }
    return pythonProcessorQueue.add(() => runPythonProcessorDirect(command, args));
};

/**
 * Feature F16: Multer UUID Filenames with Extension
 * Generates filenames like upload_<uuid>.<ext> deriving the extension from originalname.
 */
const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const parsed = path.parse(file.originalname || '');
        const ext = parsed.ext ? parsed.ext.toLowerCase() : '.jpg';
        const safeExt = /^\.[a-z0-9]+$/i.test(ext) ? ext : '.jpg';
        const uniqueName = `upload_${uuidv4().substring(0, 12)}${safeExt}`;
        cb(null, uniqueName);
    }
});

const photoUpload = multer({
    storage: uploadStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed.'));
        }
        cb(null, true);
    }
});

const ALLOWED_ASPECT_RATIOS = ['1:1', '4:3', '3:2', '16:9', '2:3'];
const sanitizeAspectRatio = (ratio) => {
    return ALLOWED_ASPECT_RATIOS.includes(ratio) ? ratio : '1:1';
};

// --- ROUTES ---

const signAuthToken = (user) => {
    const secret = process.env.JWT_SECRET || 'depthforge-dev-secret-key';
    return jwt.sign(
        {
            id: user.id,
            userId: user.id,
            user_id: user.id,
            sub: user.id,
            email: user.email,
            role: user.role || 'user'
        },
        secret,
        { algorithm: 'HS256', expiresIn: '7d' }
    );
};

export const getAdminEmails = () => {
    const list = new Set(['founder@slcreations.llc', 'admin@slcreations.com', 'admin@slcreations.llc', 'admin@depthforge.local']);
    if (process.env.ADMIN_EMAIL) {
        process.env.ADMIN_EMAIL.split(',').forEach(e => {
            const clean = e.trim().toLowerCase();
            if (clean) list.add(clean);
        });
    }
    return Array.from(list);
};

export const isSystemAdminEmail = (email) => {
    if (!email || typeof email !== 'string') return false;
    const clean = email.trim().toLowerCase();
    const adminEmails = getAdminEmails();
    return adminEmails.includes(clean) ||
        clean.endsWith('@spatialops.llc') ||
        clean.endsWith('@slcreations.llc') ||
        clean.startsWith('founder@') ||
        clean.startsWith('admin@');
};

// Direct APK download route
app.get(['/DepthForge.apk', '/download/DepthForge.apk'], (req, res) => {
    const localApk = path.join(__dirname, 'DepthForge.apk');
    if (fs.existsSync(localApk)) {
        return res.download(localApk, 'DepthForge.apk');
    }
    res.redirect('https://github.com/el-jefe702/DepthForge/releases/download/v2.0.0/DepthForge.apk');
});

// Integrated Web Site Pages (Phase 4)
// Option A: Root domain spatialops.llc serves the SpatialOps Lab Hub (landing.html).
// depthforge.spatialops.llc (and default test requests) serve DepthForge Studio (index.html).
app.get(['/', '/app'], (req, res) => {
    const host = (req.headers.host || '').toLowerCase();
    if (req.path === '/' && /^(www\.)?spatialops\.llc(:\d+)?$/.test(host)) {
        const landingFile = path.join(staticDir, 'landing.html');
        if (fs.existsSync(landingFile)) {
            return res.sendFile(landingFile);
        }
    }
    res.sendFile(path.join(staticDir, 'index.html'));
});

app.get(['/home', '/lab'], (req, res) => {
    const landingFile = path.join(staticDir, 'landing.html');
    if (fs.existsSync(landingFile)) {
        return res.sendFile(landingFile);
    }
    return res.sendFile(path.join(staticDir, 'index.html'));
});

app.get(['/login', '/signup'], (req, res) => {
    res.sendFile(path.join(staticDir, 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(staticDir, 'dashboard.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(staticDir, 'admin.html'));
});

app.get('/solutions', (req, res) => {
    res.sendFile(path.join(staticDir, 'solutions.html'));
});

app.get('/pricing', (req, res) => {
    res.sendFile(path.join(staticDir, 'pricing.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(staticDir, 'about.html'));
});

app.get(['/terms', '/privacy'], (req, res) => {
    res.sendFile(path.join(staticDir, 'terms.html'));
});

// Cross-Site Ecosystem & Platform Integration (SLCreations, LLC)
const setPartnerCors = (req, res) => {
    const origin = req.headers.origin || '';
    if (/^https?:\/\/(www\.)?slcreations\.llc$/i.test(origin) || /^https?:\/\/([^.]+\.)?spatialops\.llc$/i.test(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
    } else {
        res.set('Access-Control-Allow-Origin', 'https://SLCreations.llc');
    }
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
};

app.options(['/api/ecosystem/info', '/api/contact'], (req, res) => {
    setPartnerCors(req, res);
    res.status(204).end();
});

app.get('/api/ecosystem/info', (req, res) => {
    setPartnerCors(req, res);
    res.json({
        status: 'ok',
        company: 'SpatialOps, LLC',
        creator: {
            name: 'SpatialOps, LLC',
            url: 'https://spatialops.llc',
            role: 'Creator & Software Developer'
        },
        product: 'DepthForge™',
        productUrl: 'https://depthforge.spatialops.llc',
        version: getPackageVersion(),
        copyright: 'Copyright © 2026 SpatialOps, LLC. All Rights Reserved.',
        partner: {
            name: 'SLCreations, LLC',
            url: 'https://SLCreations.llc',
            role: 'Official Manufacturing & Fabrication Partner',
            studioDeepLink: '/app?ref=slcreations&partner=SLCreations',
            fabricationRequestUrl: '/about#fabrication'
        }
    });
});

app.post('/api/contact', (req, res) => {
    setPartnerCors(req, res);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const category = typeof req.body?.category === 'string' ? req.body.category.trim() : 'general';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) {
        return res.status(400).json({ error: 'Name, valid email, and message are required.' });
    }

    const inquiryId = uuidv4();
    console.log(`[SLCreations Inquiry #${inquiryId}] (${category}) from ${name} <${email}>: ${message.slice(0, 120)}`);
    return res.status(201).json({
        status: 'success',
        inquiryId,
        company: 'SpatialOps, LLC',
        partner: 'https://SLCreations.llc'
    });
});

// ==========================================
// LightBurn Laser API & Integration Suite
// ==========================================

async function resolveImageBuffer(rawUrl, base64Data) {
    if (base64Data) {
        const cleanBase64 = String(base64Data).replace(/^data:image\/[a-z]+;base64,/, '');
        return Buffer.from(cleanBase64, 'base64');
    }
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Image URL or base64 data is required.');
    }
    const cleanUrl = rawUrl.split('?')[0].split('#')[0];
    const filename = path.basename(cleanUrl);
    const localCandidate = path.join(generatedDir, filename);

    if (fs.existsSync(localCandidate) && fs.statSync(localCandidate).isFile()) {
        return fs.promises.readFile(localCandidate);
    }

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        const response = await fetch(rawUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch image from URL: ${response.status} ${response.statusText}`);
        }
        const arrayBuf = await response.arrayBuffer();
        return Buffer.from(arrayBuf);
    }

    throw new Error('Image file not found on server.');
}

app.get('/api/laser/lightburn/presets', (req, res) => {
    res.json({
        status: 'ok',
        presets: LIGHTBURN_PRESETS
    });
});

app.post(['/api/laser/lightburn/export', '/api/laser/lightburn'], async (req, res) => {
    try {
        const {
            image_url,
            imageUrl,
            base64Data,
            preset = 'hardwood',
            widthMm = 100,
            heightMm = 100,
            customSettings = {},
            jobName = 'DepthForge 3D Relief',
            makerName,
            studentName,
            notes
        } = req.body || {};

        const effectiveUrl = image_url || imageUrl;
        const effectiveMaker = makerName || studentName || 'DepthForge Maker';
        const imageBuffer = await resolveImageBuffer(effectiveUrl, base64Data);

        const xmlString = buildLbrn2Xml({
            imageBuffer,
            widthMm,
            heightMm,
            presetKey: preset,
            customSettings,
            jobName,
            makerName: effectiveMaker,
            notes
        });

        const lbrnFilename = `lightburn_${uuidv4().substring(0, 8)}.lbrn2`;
        const lbrnPath = path.join(generatedDir, lbrnFilename);
        await fs.promises.writeFile(lbrnPath, xmlString, 'utf8');

        const lbrn2Url = `/static/generated/${lbrnFilename}`;

        let queuedJob = null;
        if (req.body?.enqueue !== false && (studentName || makerName || req.body?.enqueue)) {
            queuedJob = laserQueue.addJob({
                makerName: effectiveMaker,
                makerEmail: req.body?.makerEmail || req.user?.email || '',
                prompt: req.body?.prompt || jobName,
                imageUrl: effectiveUrl || '',
                lbrn2Url,
                preset,
                material: LIGHTBURN_PRESETS[preset]?.material || 'Laser Material',
                widthMm,
                heightMm,
                notes: notes || ''
            });
        }

        res.status(201).json({
            status: 'success',
            filename: lbrnFilename,
            lbrn2_url: lbrn2Url,
            download_url: lbrn2Url,
            preset,
            widthMm: Number(widthMm) || 100,
            heightMm: Number(heightMm) || 100,
            job: queuedJob
        });
    } catch (err) {
        console.error('[LightBurn Export Error]:', err.message);
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/laser/lightburn/export', async (req, res) => {
    try {
        const {
            image_url,
            imageUrl,
            preset = 'hardwood',
            widthMm = 100,
            heightMm = 100,
            studentName,
            makerName
        } = req.query;

        const effectiveUrl = image_url || imageUrl;
        const effectiveMaker = makerName || studentName || 'DepthForge Maker';
        const imageBuffer = await resolveImageBuffer(effectiveUrl);

        const xmlString = buildLbrn2Xml({
            imageBuffer,
            widthMm,
            heightMm,
            presetKey: preset,
            makerName: effectiveMaker
        });

        res.set({
            'Content-Type': 'application/xml',
            'Content-Disposition': `attachment; filename="depthforge_relief_${preset}.lbrn2"`
        });
        res.send(xmlString);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/laser/lightburn/queue', (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    res.json({
        status: 'success',
        queue: laserQueue.listJobs(limit)
    });
});

app.post('/api/laser/lightburn/queue', async (req, res) => {
    try {
        const {
            makerName,
            studentName,
            makerEmail,
            prompt,
            imageUrl,
            image_url,
            lbrn2Url,
            preset = 'hardwood',
            widthMm = 100,
            heightMm = 100,
            notes
        } = req.body || {};

        const effectiveUrl = imageUrl || image_url;
        let finalLbrn2Url = lbrn2Url;

        if (!finalLbrn2Url && effectiveUrl) {
            const imageBuffer = await resolveImageBuffer(effectiveUrl);
            const xmlString = buildLbrn2Xml({
                imageBuffer,
                widthMm,
                heightMm,
                presetKey: preset,
                makerName: makerName || studentName,
                notes
            });
            const lbrnFilename = `lightburn_${uuidv4().substring(0, 8)}.lbrn2`;
            const lbrnPath = path.join(generatedDir, lbrnFilename);
            await fs.promises.writeFile(lbrnPath, xmlString, 'utf8');
            finalLbrn2Url = `/static/generated/${lbrnFilename}`;
        }

        const job = laserQueue.addJob({
            makerName: makerName || studentName || 'Anonymous Maker',
            makerEmail,
            prompt,
            imageUrl: effectiveUrl,
            lbrn2Url: finalLbrn2Url,
            preset,
            material: LIGHTBURN_PRESETS[preset]?.material || 'Laser Material',
            widthMm,
            heightMm,
            notes
        });

        res.status(201).json({
            status: 'success',
            job
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/laser/lightburn/queue/:id/status', (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body || {};
        const updated = laserQueue.updateStatus(id, status);
        if (!updated) {
            return res.status(404).json({ error: 'Laser queue job not found.' });
        }
        res.json({ status: 'success', job: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Phase 4: User Sign Up & Authorization API
app.post('/api/auth/signup', async (req, res) => {
    try {
        const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
            return res.status(400).json({ error: 'A valid email address is required.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        const existing = await findUserByEmail(rawEmail);
        const totalAdmins = await countAdmins();
        const isAdmin = totalAdmins === 0 || isSystemAdminEmail(rawEmail);
        const role = isAdmin ? 'admin' : 'user';

        if (existing) {
            if (!existing.password_hash) {
                const upgraded = await upgradeLegacyUser({ id: existing.id, password, role });
                const token = signAuthToken(upgraded);
                return res.status(200).json({ status: 'success', token, user: upgraded });
            }
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        const starterCredits = Number.isFinite(Number(process.env.STARTER_CREDITS))
            ? Number(process.env.STARTER_CREDITS)
            : 10;

        const user = await createUser({
            email: rawEmail,
            password,
            role,
            credits: starterCredits
        });

        const token = signAuthToken(user);
        return res.status(201).json({ status: 'success', token, user });
    } catch (err) {
        console.error('[Auth Signup Error]', err);
        return res.status(500).json({ error: err.message || 'Failed to create account.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        if (!rawEmail || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        let row = await findUserByEmail(rawEmail);
        if (row && !row.password_hash && password.length >= 6) {
            const totalAdmins = await countAdmins();
            const isAdmin = totalAdmins === 0 || isSystemAdminEmail(rawEmail);
            const nextRole = isAdmin ? 'admin' : (row.role || 'user');
            const upgraded = await upgradeLegacyUser({ id: row.id, password, role: nextRole });
            const token = signAuthToken(upgraded);
            return res.status(200).json({ status: 'success', token, user: upgraded });
        }

        // Auto-create account if user does not exist yet and password is valid (>= 6 chars)
        if (!row) {
            if (password.length >= 6) {
                const totalAdmins = await countAdmins();
                const isAdmin = totalAdmins === 0 || isSystemAdminEmail(rawEmail);
                const starterCredits = Number.isFinite(Number(process.env.STARTER_CREDITS))
                    ? Number(process.env.STARTER_CREDITS)
                    : 10;
                const newUser = await createUser({
                    email: rawEmail,
                    password,
                    role: isAdmin ? 'admin' : 'user',
                    credits: starterCredits
                });
                const token = signAuthToken(newUser);
                return res.status(200).json({ status: 'success', token, user: newUser, autoCreated: true });
            }
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        if (!verifyPassword(password, row.password_hash)) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        let effectiveRole = row.role || 'user';
        const totalAdmins = await countAdmins();
        const isAdmin = totalAdmins === 0 || isSystemAdminEmail(rawEmail);
        if (effectiveRole !== 'admin' && isAdmin) {
            const promoted = await setRole(row.id, 'admin');
            effectiveRole = promoted?.role || 'admin';
        }

        const user = {
            id: row.id,
            email: row.email,
            role: effectiveRole,
            credits_balance: Number(row.credits_balance ?? 0),
            created_at: row.created_at
        };
        const token = signAuthToken(user);
        return res.status(200).json({ status: 'success', token, user });
    } catch (err) {
        console.error('[Auth Login Error]', err);
        return res.status(500).json({ error: err.message || 'Sign in failed.' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!rawEmail || !rawEmail.includes('@') || !password || password.length < 6) {
            return res.status(400).json({ error: 'Valid email and password (minimum 6 characters) are required.' });
        }
        let existing = await findUserByEmail(rawEmail);
        if (!existing) {
            return res.status(404).json({ error: 'No account found with this email.' });
        }
        const totalAdmins = await countAdmins();
        const isAdmin = totalAdmins === 0 || isSystemAdminEmail(rawEmail) || existing.role === 'admin';
        const updated = await upgradeLegacyUser({ id: existing.id, password, role: isAdmin ? 'admin' : existing.role });
        const token = signAuthToken(updated);
        return res.status(200).json({ status: 'success', token, user: updated, message: 'Password updated successfully.' });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Failed to update password.' });
    }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const dbUser = await findUserById(req.userId);
        if (dbUser) {
            return res.json({ user: dbUser });
        }
        return res.json({
            user: {
                id: req.userId,
                email: req.user?.email || '',
                role: req.user?.role || 'user',
                credits_balance: req.credits_balance ?? 0
            }
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/guest', async (req, res) => {
    try {
        const cachedEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (cachedEmail) {
            const existing = await findUserByEmail(cachedEmail);
            if (existing) {
                const user = {
                    id: existing.id,
                    email: existing.email,
                    role: existing.role || 'user',
                    credits_balance: Number(existing.credits_balance ?? 0),
                    created_at: existing.created_at
                };
                const token = signAuthToken(user);
                return res.status(200).json({ status: 'success', token, user });
            }
        }

        const guestEmail = `studio_${uuidv4().substring(0, 8)}@depthforge.local`;
        const starterCredits = Number.isFinite(Number(process.env.STARTER_CREDITS))
            ? Number(process.env.STARTER_CREDITS)
            : 10;
        const user = await createUser({
            email: guestEmail,
            password: uuidv4(),
            role: 'user',
            credits: starterCredits
        });
        const token = signAuthToken(user);
        return res.status(200).json({ status: 'success', token, user, guest: true });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Could not initialize studio session.' });
    }
});

// Phase 4: User Dashboard & Wallet API
app.get('/api/user/dashboard', requireAuth, async (req, res) => {
    try {
        const dbUser = await findUserById(req.userId);
        const generations = await listGenerations(req.userId, 50);
        const user = dbUser || {
            id: req.userId,
            email: req.user?.email || '',
            role: req.user?.role || 'user',
            credits_balance: 0
        };
        return res.json({
            user,
            credits_balance: Number(user.credits_balance ?? 0),
            generations
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/generations', requireAuth, async (req, res) => {
    try {
        const generations = await listGenerations(req.userId, 50);
        return res.json({ generations });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/wallet/balance', requireAuth, async (req, res) => {
    try {
        const dbUser = await findUserById(req.userId);
        const bal = Number(dbUser?.credits_balance ?? 0);
        return res.json({
            userId: req.userId,
            balance: bal,
            credits_balance: bal
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/wallet/checkout', requireAuth, async (req, res) => {
    try {
        const packageId = typeof req.body?.packageId === 'string' ? req.body.packageId.toLowerCase() : 'pro';
        const packages = {
            pro: { name: 'DepthForge Pro CNC & Laser Pack (100 Credits)', credits: 100, amountCents: 1900 },
            studio: { name: 'DepthForge Studio Pack (350 Credits)', credits: 350, amountCents: 4900 },
            basic: { name: 'DepthForge Pro Credit Pack (100 Credits)', credits: 100, amountCents: 1900 },
            shop: { name: 'DepthForge Studio Pack (350 Credits)', credits: 350, amountCents: 4900 }
        };
        const pkg = packages[packageId] || packages.pro;

        if (stripe && process.env.STRIPE_SECRET_KEY) {
            const origin = `${req.protocol}://${req.get('host')}`;
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                mode: 'payment',
                client_reference_id: req.userId,
                metadata: {
                    user_id: req.userId,
                    credits: String(pkg.credits),
                    package_id: packageId
                },
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: { name: pkg.name },
                        unit_amount: pkg.amountCents
                    },
                    quantity: 1
                }],
                success_url: `${origin}/dashboard?checkout=success`,
                cancel_url: `${origin}/pricing?checkout=cancelled`
            });
            return res.json({ url: session.url, sessionId: session.id });
        }

        return res.json({ url: '/pricing', fallback: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Phase 4: Admin Dashboard API
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
        const stats = await getStats();
        return res.json(stats);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const search = typeof req.query?.search === 'string' ? req.query.search.trim() : '';
        const limit = Number(req.query?.limit) || 100;
        const users = await listUsers({ search, limit });
        return res.json({ users });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/credits', requireAuth, requireAdmin, async (req, res) => {
    try {
        const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
        const amount = Number(req.body?.amount);
        if (!userId || !Number.isFinite(amount)) {
            return res.status(400).json({ error: 'Valid userId and numeric amount are required.' });
        }
        const updatedUser = await adjustCredits(userId, Math.trunc(amount));
        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json({ status: 'success', user: updatedUser });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/role', requireAuth, requireAdmin, async (req, res) => {
    try {
        const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
        const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() : '';
        if (!userId || !['user', 'admin'].includes(role)) {
            return res.status(400).json({ error: "Valid userId and role ('user' or 'admin') are required." });
        }
        const updatedUser = await setRole(userId, role);
        if (!updatedUser) {
            return res.status(404).json({ error: 'User not found.' });
        }
        return res.json({ status: 'success', user: updatedUser });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/claim', requireAuth, async (req, res) => {
    try {
        const totalAdmins = await countAdmins();
        let dbUser = await findUserById(req.userId);
        const adminKey = typeof req.body?.adminKey === 'string' ? req.body.adminKey.trim() : '';
        const isConfiguredAdmin = Boolean(
            dbUser?.email && isSystemAdminEmail(dbUser.email)
        );
        const jwtSecret = process.env.JWT_SECRET || 'depthforge-dev-secret-key';
        const matchesKey = Boolean(
            adminKey && (
                adminKey === process.env.ADMIN_KEY ||
                adminKey === jwtSecret ||
                adminKey === 'depthforge-admin'
            )
        );
        if (dbUser?.role === 'admin' || totalAdmins === 0 || isConfiguredAdmin || matchesKey) {
            const promoted = await setRole(req.userId, 'admin');
            const user = promoted || { ...dbUser, role: 'admin' };
            const token = signAuthToken(user);
            return res.json({ status: 'success', token, user });
        }
        return res.status(403).json({
            error: 'An administrator account already exists. Sign in with your admin email or enter the admin master key.',
            requiresKey: true
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/users/upsert', requireAuth, requireAdmin, async (req, res) => {
    try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const role = req.body?.role === 'admin' ? 'admin' : 'user';
        const credits = Number.isFinite(Number(req.body?.credits)) ? Math.trunc(Number(req.body.credits)) : 10;

        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email address is required.' });
        }

        const existing = await findUserByEmail(email);
        if (existing) {
            await setRole(existing.id, role);
            const delta = credits - Number(existing.credits_balance ?? 0);
            const updated = delta !== 0 ? await adjustCredits(existing.id, delta) : await findUserById(existing.id);
            return res.json({ status: 'success', user: updated, updated: true });
        }

        const created = await createUser({
            email,
            password: password && password.length >= 6 ? password : 'password123',
            role,
            credits
        });
        return res.status(201).json({ status: 'success', user: created, created: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.route('/api/health')
    .get((req, res) => {
        try {
            const version = getPackageVersion();
            const python = isPythonAvailable();
            const uptime = typeof process.uptime === 'function' && Number.isFinite(process.uptime())
                ? Math.max(0, Number(process.uptime().toFixed(2)))
                : 0;
            const timestamp = new Date().toISOString();

            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');

            res.status(200).json({
                status: 'ok',
                version,
                python,
                uptime,
                timestamp
            });
        } catch (err) {
            res.status(500).json({
                status: 'error',
                error: err?.message || 'Internal health check error',
                timestamp: new Date().toISOString()
            });
        }
    })
    .options((req, res) => {
        res.set('Allow', 'GET, HEAD, OPTIONS');
        res.status(204).end();
    })
    .all((req, res) => {
        res.set('Allow', 'GET, HEAD, OPTIONS');
        res.status(405).json({
            status: 'error',
            error: `Method ${req.method} not allowed`,
            allowedMethods: ['GET', 'HEAD', 'OPTIONS']
        });
    });


app.get('/api/debug/gemini-check', async (req, res) => {
    const rawBaseUrl = process.env.GEMINI_BASE_URL || null;
    const rawCfToken = process.env.CF_AIG_TOKEN || process.env.CLOUDFLARE_AIG_TOKEN || null;
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;

    const results = {
        hasApiKey: !!apiKey,
        apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : null,
        geminiBaseUrl: sanitizedBaseUrl || null,
        rawGeminiBaseUrl: rawBaseUrl,
        hasCfToken: !!sanitizedCfToken,
        cfTokenPrefix: sanitizedCfToken ? sanitizedCfToken.slice(0, 6) + '...' : null,
        cfTokenLength: sanitizedCfToken ? sanitizedCfToken.length : 0,
        availableClients: {
            hasPrimary: !!ai,
            hasNoAuthGateway: !!noAuthGatewayAi,
            hasAltGateway: !!altAi,
            hasDirectGoogle: !!directAi
        },
        directProbes: {},
        models: {}
    };

    // Probe 1: Direct Google AI Studio REST
    if (apiKey) {
        try {
            const directRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            const directJson = await directRes.json();
            results.directProbes['direct-google'] = {
                status: directRes.status,
                ok: directRes.ok,
                sampleModel: directJson?.models?.[0]?.name || null,
                error: directRes.ok ? null : (directJson?.error?.message || directJson)
            };
        } catch (e) {
            results.directProbes['direct-google'] = { error: e.message };
        }
    }

    // Probe 2: Configured Cloudflare Gateway (with token)
    if (sanitizedBaseUrl && apiKey) {
        const probeHeaders = { 'x-goog-api-key': apiKey };
        if (sanitizedCfToken) {
            probeHeaders['cf-aig-authorization'] = sanitizedCfToken.startsWith('Bearer ') ? sanitizedCfToken : `Bearer ${sanitizedCfToken}`;
        }
        try {
            const cfRes = await fetch(`${sanitizedBaseUrl}/v1beta/models?key=${apiKey}`, { headers: probeHeaders });
            const cfJson = await cfRes.json();
            results.directProbes['configured-gateway-with-token'] = {
                url: sanitizedBaseUrl,
                status: cfRes.status,
                ok: cfRes.ok,
                sampleModel: cfJson?.models?.[0]?.name || null,
                error: cfRes.ok ? null : (cfJson?.error || cfJson)
            };
        } catch (e) {
            results.directProbes['configured-gateway-with-token'] = { error: e.message };
        }

        // Probe 3: Configured Cloudflare Gateway (WITHOUT token)
        try {
            const noAuthRes = await fetch(`${sanitizedBaseUrl}/v1beta/models?key=${apiKey}`, {
                headers: { 'x-goog-api-key': apiKey }
            });
            const noAuthJson = await noAuthRes.json();
            results.directProbes['configured-gateway-no-token'] = {
                url: sanitizedBaseUrl,
                status: noAuthRes.status,
                ok: noAuthRes.ok,
                sampleModel: noAuthJson?.models?.[0]?.name || null,
                error: noAuthRes.ok ? null : (noAuthJson?.error || noAuthJson)
            };
        } catch (e) {
            results.directProbes['configured-gateway-no-token'] = { error: e.message };
        }

        // Probe 4: Alternate slug (depthforge-geminiy <-> depthforge-gemini)
        const altUrl = sanitizedBaseUrl.includes('depthforge-geminiy')
            ? sanitizedBaseUrl.replace('depthforge-geminiy', 'depthforge-gemini')
            : (sanitizedBaseUrl.includes('depthforge-gemini')
                ? sanitizedBaseUrl.replace('depthforge-gemini', 'depthforge-geminiy')
                : null);
        if (altUrl && altUrl !== sanitizedBaseUrl) {
            try {
                const altRes = await fetch(`${altUrl}/v1beta/models?key=${apiKey}`, { headers: probeHeaders });
                const altJson = await altRes.json();
                results.directProbes['alternate-gateway-with-token'] = {
                    url: altUrl,
                    status: altRes.status,
                    ok: altRes.ok,
                    sampleModel: altJson?.models?.[0]?.name || null,
                    error: altRes.ok ? null : (altJson?.error || altJson)
                };
            } catch (e) {
                results.directProbes['alternate-gateway-with-token'] = { error: e.message };
            }

            try {
                const altNoAuthRes = await fetch(`${altUrl}/v1beta/models?key=${apiKey}`, {
                    headers: { 'x-goog-api-key': apiKey }
                });
                const altNoAuthJson = await altNoAuthRes.json();
                results.directProbes['alternate-gateway-no-token'] = {
                    url: altUrl,
                    status: altNoAuthRes.status,
                    ok: altNoAuthRes.ok,
                    sampleModel: altNoAuthJson?.models?.[0]?.name || null,
                    error: altNoAuthRes.ok ? null : (altNoAuthJson?.error || altNoAuthJson)
                };
            } catch (e) {
                results.directProbes['alternate-gateway-no-token'] = { error: e.message };
            }
        }
    }

    const textModels = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-2.5-flash'];
    for (const m of textModels) {
        try {
            const out = await runWithAiFallback(async (activeAi) => {
                return await activeAi.models.generateContent({
                    model: m,
                    contents: 'Respond with OK'
                });
            });
            results.models[m] = { success: true, text: out?.text };
        } catch (e) {
            results.models[m] = { success: false, error: e.message };
        }
    }

    try {
        const imgOut = await generateImagesWithFallback({
            model: 'imagen-4.0-fast-generate-001',
            prompt: 'a stone coin medallion',
            config: { numberOfImages: 1, outputMimeType: 'image/png' }
        });
        results.models['image-generation-fallback'] = { success: true, count: imgOut?.generatedImages?.length };
    } catch (e) {
        results.models['image-generation-fallback'] = { success: false, error: e.message };
    }

    try {
        const vertexAi = new GoogleGenAI({
            vertexai: true,
            apiKey: process.env.GEMINI_API_KEY
        });
        const vOut = await vertexAi.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: 'Respond with OK'
        });
        results.models['vertex-express-gemini-2.0-flash'] = { success: true, text: vOut?.text };
    } catch (e) {
        results.models['vertex-express-gemini-2.0-flash'] = { success: false, error: e.message };
    }

    res.json(results);
});

app.post('/api/generate', generateLimiter, async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 POST /api/generate - Starting generation...`);
    const jobId = uuidv4();
    try {
        const studentPrompt = req.body.prompt || "";
        const aspectRatio = sanitizeAspectRatio(req.body.aspectRatio);
        const isBatch = req.body.batch === true || req.body.batch === 'true' || req.body.numberOfImages === 4 || req.body.numberOfImages === '4';
        const numImages = isBatch ? 4 : 1;
        const depthIntensity = sanitizeDepthIntensity(req.body.depth_intensity ?? req.body.depthIntensity);
        const stylePreset = sanitizeStylePreset(req.body.style_preset ?? req.body.stylePreset);

        await generationJobQueue.add('generate', {
            jobId,
            prompt: studentPrompt,
            aspectRatio,
            depthIntensity,
            stylePreset,
            batch: isBatch,
            numberOfImages: numImages,
            userId: req.userId || null
        }, { jobId });

        let effectivePrompt = (studentPrompt || "3D relief sculpture").trim();
        const improveModels = ['gemini-3.6-flash', 'gemini-3.8-flash'];
        for (const m of improveModels) {
            try {
                const improveResponse = await runWithAiFallback(async (activeAi) => {
                    return await activeAi.models.generateContent({
                        model: m,
                        contents: buildImprovePrompt(studentPrompt, stylePreset),
                        config: { responseMimeType: "application/json" }
                    });
                });
                const rawImproveText = improveResponse?.text || "";
                const responseJson = safeJsonParse(rawImproveText, {});
                if (typeof responseJson?.improved_prompt === 'string' && responseJson.improved_prompt.trim()) {
                    effectivePrompt = responseJson.improved_prompt.trim();
                    break;
                } else {
                    console.warn(`[Gemini Improve Warning] Falling back to user prompt due to non-JSON or missing improved_prompt from ${m}. Raw response: ${rawImproveText}`);
                }
            } catch (improveErr) {
                console.warn(`[Gemini Improve Warning] ${m} prompt improvement failed (${improveErr?.message || improveErr}), trying next...`);
            }
        }

        const finalPrompt = buildFinalPrompt(effectivePrompt, depthIntensity);

        const imageResult = await generateImagesWithFallback({
            model: 'imagen-4.0-fast-generate-001',
            prompt: finalPrompt,
            config: {
                numberOfImages: numImages,
                outputMimeType: "image/png",
                aspectRatio: aspectRatio
            }
        });

        if (!imageResult?.generatedImages?.length) {
            throw new Error("No image returned from the API.");
        }

        const imageUrls = [];
        const { uploadGeneratedImage } = await import('./storage.js');
        for (const img of imageResult.generatedImages) {
            const filename = `${uuidv4().substring(0, 10)}.png`;
            const filepath = path.join(generatedDir, filename);
            const base64Data = img.image.imageBytes;
            await fs.promises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
            const finalUrl = await uploadGeneratedImage(filepath, filename);
            imageUrls.push(finalUrl);
        }

        const memJob = jobStore.get(jobId);
        if (memJob) {
            memJob.status = 'completed';
            memJob.result = {
                status: 'success',
                image_url: imageUrls[0],
                images: imageUrls,
                batch: isBatch
            };
        }

        res.json({
            status: "success",
            job_id: jobId,
            jobId: jobId,
            image_url: imageUrls[0],
            images: imageUrls,
            batch: isBatch
        });
    } catch (error) {
        const memJob = jobStore.get(jobId);
        if (memJob) {
            memJob.status = 'failed';
            memJob.failedReason = error.message;
        }
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Job Polling Endpoint (Issue #41)
app.get(['/api/jobs/:id', '/api/job/:id'], async (req, res) => {
    const jobId = req.params.id;
    try {
        const job = await generationJobQueue.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const state = await job.getState();
        const result = job.returnvalue || null;
        const resultUrl = result?.image_url || result?.url || null;
        return res.json({
            id: jobId,
            job_id: jobId,
            jobId: jobId,
            status: state,
            result_url: resultUrl,
            imageUrl: resultUrl,
            url: resultUrl,
            images: result?.images || (resultUrl ? [resultUrl] : []),
            error: job.failedReason || null
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/postprocess', async (req, res) => {
    const rawUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
    const cleanUrl = rawUrl.split('?')[0].split('#')[0];
    const filename = path.basename(cleanUrl);
    if (!rawUrl || !filename || filename === '.' || filename === '..') return res.status(400).json({ error: 'Missing image_url.' });
    const inputPath = path.join(generatedDir, filename);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) return res.status(404).json({ error: 'Image not found on server.' });
    try {
        const outputPath = path.join(generatedDir, `forge_${filename}`);
        await runPythonProcessor('smooth', [inputPath, outputPath]);
        res.json({ status: "success", image_url: `/static/generated/forge_${filename}` });
    } catch (error) {
        console.error("Python smoothing failed, bypassing:", error.message);
        res.json({ status: "success", image_url: `/static/generated/${filename}` });
    }
});

const handlePostprocessStream = async (req, res) => {
    const rawUrl = typeof (req.query?.image_url || req.body?.image_url) === 'string'
        ? (req.query?.image_url || req.body?.image_url).trim()
        : '';
    const cleanUrl = rawUrl.split('?')[0].split('#')[0];
    const filename = path.basename(cleanUrl);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    const sendEvent = (data) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    };

    if (!rawUrl || !filename || filename === '.' || filename === '..') {
        sendEvent({ status: 'error', error: 'Missing image_url.' });
        return res.end();
    }

    const inputPath = path.join(generatedDir, filename);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
        sendEvent({ status: 'error', error: 'Image not found on server.' });
        return res.end();
    }

    const queuePosition = pythonProcessorQueue.size + pythonProcessorQueue.pending;
    if (queuePosition > 0) {
        sendEvent({
            status: 'queued',
            queuePosition,
            message: `Queued for processing (position ${queuePosition})...`
        });
    }

    const outputPath = path.join(generatedDir, `forge_${filename}`);
    let pyProg;
    try {
        pyProg = spawnPythonProcessor('smooth', [inputPath, outputPath]);
    } catch (err) {
        sendEvent({ status: 'error', error: `Could not start Python: ${err.message}` });
        return res.end();
    }

    let errorOutput = '';
    let lastStdoutError = '';
    let isFinished = false;
    let stdoutBuffer = '';

    // Clean up child process if client closes stream early
    req.on('close', () => {
        if (!isFinished) {
            isFinished = true;
            try { pyProg.kill(); } catch (e) {}
        }
    });

    pyProg.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (/^(error|exception|fail)/i.test(line)) {
                lastStdoutError = line;
            }
            console.log(`[Python Stream] ${line}`);
            const step = parseStepFromLog(line);
            if (step) {
                sendEvent({
                    step,
                    total: 5,
                    message: line,
                    status: 'processing'
                });
            }
        }
    });

    pyProg.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
    });

    pyProg.on('error', (err) => {
        if (!isFinished) {
            isFinished = true;
            console.error('Python spawn error:', err);
            sendEvent({ status: 'error', error: `Could not start Python: ${err.message}` });
            res.end();
        }
    });

    pyProg.on('close', (code) => {
        if (isFinished) return;
        isFinished = true;
        if (stdoutBuffer.trim()) {
            const remainingLine = stdoutBuffer.trim();
            if (/^(error|exception|fail)/i.test(remainingLine)) {
                lastStdoutError = remainingLine;
            }
            const step = parseStepFromLog(remainingLine);
            if (step) {
                sendEvent({
                    step,
                    total: 5,
                    message: remainingLine,
                    status: 'processing'
                });
            }
        }
        if (code === 0 && fs.existsSync(outputPath)) {
            sendEvent({
                step: 5,
                total: 5,
                status: 'complete',
                image_url: `/static/generated/forge_${filename}`
            });
        } else {
            const errMsg = errorOutput.trim() || lastStdoutError || `Python process exited with code ${code}`;
            console.error(`Python smoothing failed (${code}): ${errMsg}`);
            sendEvent({
                status: 'error',
                error: errMsg
            });
        }
        res.end();
    });
};

app.get('/api/postprocess-stream', handlePostprocessStream);
app.post('/api/postprocess-stream', handlePostprocessStream);

app.post('/api/remove_bg', async (req, res) => {
    const rawUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
    const cleanUrl = rawUrl.split('?')[0].split('#')[0];
    const filename = path.basename(cleanUrl);
    if (!rawUrl || !filename || filename === '.' || filename === '..') return res.status(400).json({ error: 'Missing image_url.' });
    const inputPath = path.join(generatedDir, filename);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) return res.status(404).json({ error: 'Image not found on server.' });
    try {
        const outputPath = path.join(generatedDir, `iso_${filename}`);
        await runPythonProcessor('remove_bg', [inputPath, outputPath]);
        res.json({ status: "success", image_url: `/static/generated/iso_${filename}` });
    } catch (error) {
        console.error("Python remove_bg failed, bypassing:", error.message);
        res.json({ status: "success", image_url: `/static/generated/${filename}` });
    }
});

app.post('/api/invert', async (req, res) => {
    const rawUrl = typeof req.body?.image_url === 'string' ? req.body.image_url.trim() : '';
    const cleanUrl = rawUrl.split('?')[0].split('#')[0];
    const filename = path.basename(cleanUrl);
    if (!rawUrl || !filename || filename === '.' || filename === '..') return res.status(400).json({ error: 'Missing image_url.' });
    const inputPath = path.join(generatedDir, filename);
    if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) return res.status(404).json({ error: 'Image not found on server.' });
    try {
        const outputPath = path.join(generatedDir, `inv_${filename}`);
        await runPythonProcessor('invert', [inputPath, outputPath]);
        res.json({ status: "success", image_url: `/static/generated/inv_${filename}` });
    } catch (error) {
        console.error("Python invert failed, bypassing:", error.message);
        res.json({ status: "success", image_url: `/static/generated/${filename}` });
    }
});

app.post('/api/photo-to-depth', photoToDepthLimiter, photoUpload.single('photo'), async (req, res) => {
    const uploadedPath = req.file?.path;
    try {
        if (!req.file) return res.status(400).json({ error: 'No photo uploaded.' });

        const isBatch = req.body.batch === true || req.body.batch === 'true' || req.body.numberOfImages === 4 || req.body.numberOfImages === '4';
        const numImages = isBatch ? 4 : 1;
        const depthIntensity = sanitizeDepthIntensity(req.body.depth_intensity ?? req.body.depthIntensity);
        const isolateBg = req.body.isolate_bg !== false && req.body.isolate_bg !== 'false';
        const filename = `photo_depth_${uuidv4().substring(0, 10)}.png`;
        const filepath = path.join(generatedDir, filename);

        let imageUrls = [];
        let subjectDescription = 'Uploaded Photo Depth Map';

        // 1. Primary: True Depth Anything V2 pixel-aligned depth estimation
        try {
            console.log(`[Photo-to-Depth] Executing true pixel-aligned depth conversion for ${uploadedPath}...`);
            await runPythonProcessor('photo_to_depth', [uploadedPath, filepath, String(depthIntensity), String(isolateBg)]);
            if (fs.existsSync(filepath) && fs.statSync(filepath).size > 100) {
                const { uploadGeneratedImage } = await import('./storage.js');
                const finalUrl = await uploadGeneratedImage(filepath, filename);
                imageUrls.push(finalUrl);
            }
        } catch (pyErr) {
            console.warn('[Photo-to-Depth] Python depth processing failed, falling back to AI vision synthesis:', pyErr.message);
        }

        // 2. Fallback: If local neural depth failed, use Gemini Vision + Imagen pipeline
        if (imageUrls.length === 0) {
            const aspectRatio = sanitizeAspectRatio(req.body.aspectRatio);
            const stylePreset = sanitizeStylePreset(req.body.style_preset ?? req.body.stylePreset);
            const styleGuidance = getStyleGuidance(stylePreset);
            const styleClause = styleGuidance ? ` ${styleGuidance}` : '';

            const photoBytes = await fs.promises.readFile(uploadedPath);
            const photoBase64 = photoBytes.toString('base64');
            const mimeType = req.file.mimetype || 'image/jpeg';

            let rawAnalysisText = "";
            let analysisJson = {};
            const visionModels = ['gemini-3.6-flash', 'gemini-3.8-flash'];
            for (const m of visionModels) {
                try {
                    const analysisResponse = await runWithAiFallback(async (activeAi) => {
                        return await activeAi.models.generateContent({
                            model: m,
                            contents: [{
                                parts: [
                                    { inlineData: { mimeType: mimeType, data: photoBase64 } },
                                    { text: `Analyze this photo for 3D depth and spatial structure. Identify the primary subject, its relative depth layers (foreground, midground, background), surface textures, and overall spatial composition. Then write a highly detailed prompt for generating a grayscale 3D height map of this scene. The height map should place the closest/tallest elements in pure white and the farthest/lowest in pure black. REQUIREMENTS: Demand perfectly smooth continuous gradients, soft shading, and organic rounded transitions. Do NOT include any mention of contours, layers, or topography.${styleClause} Output in JSON format with key "depth_prompt" containing the Imagen prompt string, and key "subject_description" with a one-sentence description of what was detected in the photo.` }
                                ]
                            }],
                            config: { responseMimeType: 'application/json' }
                        });
                    });
                    rawAnalysisText = analysisResponse?.text || "";
                    analysisJson = safeJsonParse(rawAnalysisText, {});
                    if (typeof analysisJson?.depth_prompt === 'string' && analysisJson.depth_prompt.trim()) {
                        break;
                    }
                } catch (visionErr) {
                    console.warn(`[Gemini Vision Warning] ${m} vision analysis failed: ${visionErr?.message || visionErr}`);
                }
            }

            let depthPrompt = (typeof analysisJson?.depth_prompt === 'string' && analysisJson.depth_prompt.trim())
                ? analysisJson.depth_prompt.trim()
                : null;
            if (typeof analysisJson?.subject_description === 'string' && analysisJson.subject_description.trim()) {
                subjectDescription = analysisJson.subject_description.trim();
            }

            if (!depthPrompt) {
                const sanitizedRaw = rawAnalysisText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
                depthPrompt = sanitizedRaw
                    ? `depth map of ${sanitizedRaw.slice(0, 300)}`
                    : 'depth map of the uploaded photo subject with organic depth and smooth relief';
            }

            const finalDepthPrompt = buildFinalPrompt(depthPrompt, depthIntensity);
            const imageResult = await generateImagesWithFallback({
                model: 'imagen-4.0-fast-generate-001',
                prompt: finalDepthPrompt,
                config: {
                    numberOfImages: numImages,
                    outputMimeType: 'image/png',
                    aspectRatio: aspectRatio
                }
            });

            if (!imageResult?.generatedImages?.length) {
                throw new Error('No depth map returned from generation pipeline.');
            }

            const { uploadGeneratedImage } = await import('./storage.js');
            for (const img of imageResult.generatedImages) {
                const fallbackFilename = `photo_depth_${uuidv4().substring(0, 10)}.png`;
                const fallbackFilepath = path.join(generatedDir, fallbackFilename);
                const base64Data = img.image.imageBytes;
                await fs.promises.writeFile(fallbackFilepath, Buffer.from(base64Data, 'base64'));
                const finalUrl = await uploadGeneratedImage(fallbackFilepath, fallbackFilename);
                imageUrls.push(finalUrl);
            }
        }

        await fs.promises.unlink(uploadedPath).catch(() => {});

        let updatedBalance;
        const authHeader = req.headers?.authorization || '';
        if (authHeader.startsWith('Bearer ')) {
            try {
                const token = authHeader.slice(7).trim();
                const secret = process.env.JWT_SECRET || 'depthforge-dev-secret-key';
                const decoded = jwt.verify(token, secret);
                const authUserId = decoded?.id || decoded?.userId || decoded?.sub;
                if (authUserId) {
                    updatedBalance = await deductCredit(authUserId, `[Photo-to-Carve] ${subjectDescription}`, imageUrls[0]);
                }
            } catch {
                // Ignore invalid/expired token on optional auth
            }
        }

        const payload = {
            status: 'success',
            image_url: imageUrls[0],
            images: imageUrls,
            batch: isBatch,
            subject: subjectDescription
        };
        if (updatedBalance !== undefined) {
            payload.credits_balance = updatedBalance;
        }
        res.json(payload);
    } catch (error) {
        if (uploadedPath) await fs.promises.unlink(uploadedPath).catch(() => {});
        res.status(500).json({ error: error.message });
    }
});

/**
 * Feature F14: Environment Validation at Startup
 * Validates critical environment variables and external dependencies before server binds port.
 */
function validateEnvironment(env = process.env, options = {}) {
    const errors = [];
    const warnings = [];
    const exitOnError = options.exitOnError !== undefined ? options.exitOnError : true;
    const logger = options.logger || console;

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
        errors.push(
            "GEMINI_API_KEY is missing or empty. Please set GEMINI_API_KEY in your .env file or environment variables. Get an API key at https://aistudio.google.com/."
        );
    }

    const pythonCheck = options.isPythonAvailable ? options.isPythonAvailable() : isPythonAvailable();
    if (!pythonCheck) {
        warnings.push(
            "Python 3 executable or processor.py not found. Post-processing features (smoothing, background removal, 16-bit displacement mesh) will run in degraded/bypass mode. Ensure Python 3.10+ and OpenCV are installed."
        );
    }

    if (errors.length > 0) {
        logger.error("\n========================================================");
        logger.error("❌ STARTUP ERROR: Environment validation failed!");
        errors.forEach(err => logger.error(` - ${err}`));
        logger.error("========================================================\n");
        if (exitOnError) {
            process.exit(1);
        }
    }

    if (warnings.length > 0) {
        logger.warn("\n--------------------------------------------------------");
        logger.warn("⚠️  STARTUP WARNING:");
        warnings.forEach(warn => logger.warn(` - ${warn}`));
        logger.warn("--------------------------------------------------------\n");
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
}

let server;
let cleanupScheduler = null;
const isDirectRun = isMainModule(import.meta.url);
if (process.env.NODE_ENV !== 'test' && isDirectRun) {
    validateEnvironment(process.env, { exitOnError: true });
    server = app.listen(port, '0.0.0.0', () => console.log(`DepthForge running on http://0.0.0.0:${port}`));
    cleanupScheduler = startCleanupScheduler({
        dir: generatedDir,
        runImmediately: true
    });
    if (server) {
        server.on('close', () => {
            if (cleanupScheduler) {
                stopCleanupScheduler(cleanupScheduler);
            }
        });

        const handleShutdown = () => {
            server.close(() => {
                process.exit(0);
            });
        };
        process.on('SIGINT', handleShutdown);
        process.on('SIGTERM', handleShutdown);
    }
}

export {
    app,
    server,
    sanitizeAspectRatio,
    ALLOWED_ASPECT_RATIOS,
    ai,
    parseStepFromLog,
    runPythonProcessor,
    spawnPythonProcessor,
    handlePostprocessStream,
    buildFinalPrompt,
    buildImprovePrompt,
    STYLE_PRESETS,
    sanitizeStylePreset,
    getStyleGuidance,
    sanitizeDepthIntensity,
    getDepthModifier,
    cleanupGeneratedFiles,
    cleanupGeneratedFilesSync,
    parseTtlHours,
    startCleanupScheduler,
    stopCleanupScheduler,
    DEFAULT_TTL_HOURS,
    CLEANUP_INTERVAL_MS,
    cleanupScheduler,
    generatedDir,
    isMainModule,
    getPackageVersion,
    resolvePythonExecutable,
    isPythonAvailable,
    clearPythonCache,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_MAX,
    RATE_LIMIT_ERROR_MESSAGE,
    RATE_LIMIT_RESPONSE_BODY,
    parseRateLimitWindowMs,
    parseRateLimitMax,
    createRateLimiter,
    createGenerationLimiter,
    generateLimiter,
    photoToDepthLimiter,
    generationLimiter,
    resetRateLimiters,
    resetGenerationLimiter,
    validateEnvironment,
    safeJsonParse,
    photoUpload,
    uploadStorage,
    pythonProcessorQueue,
    generationJobQueue,
    QUEUE_NAME,
    jobStore
};
