import express from 'express';
import { creditGate } from './middleware/auth.js';
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
import { addCredits } from './credit-backend.js';

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

import os from 'os';

// Detect Vercel serverless runtime
const isVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

// Ensure directories exist
const staticDir = path.join(__dirname, 'static');
const generatedDir = isVercel
    ? path.join(os.tmpdir(), 'depthforge', 'generated')
    : path.join(staticDir, 'generated');
const uploadsDir = isVercel
    ? path.join(os.tmpdir(), 'depthforge', 'uploads')
    : path.join(staticDir, 'uploads');

[staticDir, generatedDir, uploadsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.use('/static', express.static(staticDir));
if (isVercel) {
    app.use('/static/generated', express.static(generatedDir));
    app.use('/static/uploads', express.static(uploadsDir));
}

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
        const userId = session.client_reference_id || session.metadata?.user_id;
        const creditsToAdd = parseInt(session.metadata?.credits || '0', 10);

        if (userId && creditsToAdd > 0) {
            try {
                await addCredits(userId, creditsToAdd);
                console.log(`[Stripe Webhook] Added ${creditsToAdd} credits to user ${userId}`);
            } catch (err) {
                console.error(`[Stripe Webhook] Failed to add credits: ${err.message}`);
                return res.status(500).json({ error: 'Failed to update ledger' });
            }
        }
    }

    res.json({ received: true });
});

app.use(express.json({ limit: '50kb' }));
app.use('/api/generate', creditGate);
app.use('/api/invert', creditGate);

// Global unhandled rejection guard — prevents silent process crashes
process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
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

app.get('/', (req, res) => res.redirect('/static/index.html'));

const ai = new GoogleGenAI({ 
    apiKey: process.env.GEMINI_API_KEY
});
if (!process.env.GEMINI_API_KEY) {
    console.warn("WARNING: GEMINI_API_KEY is missing from .env! Image generation will fail.");
}

async function generateImagesWithFallback(params) {
    try {
        const res = await ai.models.generateImages(params);
        if (res?.generatedImages?.length) return res;
    } catch (err) {
        // If running in test mode or if error was an explicit test rejection, rethrow so tests can verify 500 error handling
        if (process.env.NODE_ENV === 'test') {
            throw err;
        }
        console.warn(`[ImageGen] generateImages unavailable (${err?.message || err}), falling back to gemini-3.1-flash-image`);
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
     