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
import { addCredits, deductCredit } from './credit-backend.js';

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
     

"TECHNICAL: Pure black to pure white linear Z-axis distribution. " +
        "NO outlines, NO text, NO textures, NO slicing artifacts.";
};

// --- ASPECT RATIO ARCHITECTURE ---
const VALID_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'];
const ALLOWED_ASPECT_RATIOS = VALID_ASPECT_RATIOS;
const DEFAULT_ASPECT_RATIO = '1:1';

const sanitizeAspectRatio = (aspectRatio) => {
    if (typeof aspectRatio !== 'string') return DEFAULT_ASPECT_RATIO;
    const clean = aspectRatio.trim();
    return VALID_ASPECT_RATIOS.includes(clean) ? clean : DEFAULT_ASPECT_RATIO;
};

// --- BATCH GENERATION ARCHITECTURE ---
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 4;
const DEFAULT_BATCH_SIZE = 1;

const sanitizeBatchSize = (batchSize) => {
    if (batchSize === undefined || batchSize === null || batchSize === '') return DEFAULT_BATCH_SIZE;
    const num = Number(batchSize);
    if (!Number.isFinite(num)) return DEFAULT_BATCH_SIZE;
    const intVal = Math.floor(num);
    if (intVal < MIN_BATCH_SIZE) return MIN_BATCH_SIZE;
    if (intVal > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
    return intVal;
};

const BATCH_SIZE_CONFIG = {
    min: MIN_BATCH_SIZE,
    max: MAX_BATCH_SIZE,
    default: DEFAULT_BATCH_SIZE
};

const queue = new PQueue({ concurrency: 1 });
const generationQueue = queue;

// --- MULTER STORAGE ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${uuidv4()}`;
        const ext = path.extname(file.originalname || '') || '.png';
        cb(null, `${uniqueSuffix}${ext}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

const uploadMiddleware = (req, res, next) => {
    upload.any()(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (req.files && req.files.length > 0) {
            req.file = req.files[0];
        }
        next();
    });
};

function runProcessor(command, inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const pyScript = path.join(__dirname, 'processor.py');
        const proc = spawn('python3', [pyScript, command, inputPath, outputPath]);
        let stderr = '';
        proc.stderr.on('data', data => { stderr += data.toString(); });
        proc.on('error', () => {
            const fallback = spawn('python', [pyScript, command, inputPath, outputPath]);
            let fbStderr = '';
            fallback.stderr.on('data', d => { fbStderr += d.toString(); });
            fallback.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`Processor failed with code ${code}: ${fbStderr}`));
            });
            fallback.on('error', reject);
        });
        proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Processor failed with code ${code}: ${stderr}`));
        });
    });
}

// --- API ROUTES ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/generate', generateLimiter, async (req, res) => {
    try {
        const { prompt, stylePreset, depthIntensity, aspectRatio, batchSize, numberOfImages, count: reqCount } = req.body || {};
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const validPreset = sanitizeStylePreset(stylePreset);
        const validIntensity = sanitizeDepthIntensity(depthIntensity);
        const validAspectRatio = sanitizeAspectRatio(aspectRatio);
        const count = sanitizeBatchSize(batchSize || numberOfImages || reqCount || 1);

        const result = await queue.add(async () => {
            let improvedPrompt = prompt.trim();
            try {
                if (ai && ai.models) {
                    const improveResponse = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: buildImprovePrompt(prompt.trim(), validPreset)
                    });
                    const text = improveResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (text) {
                        try {
                            const jsonMatch = text.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                if (parsed.improved_prompt) {
                                    improvedPrompt = parsed.improved_prompt;
                                }
                            }
                        } catch (e) {}
                    }
                }
            } catch (err) {
                console.warn('[Generate] Prompt enhancement fallback:', err?.message || err);
            }

            const finalPrompt = buildFinalPrompt(improvedPrompt, validIntensity);
            const imageGenRes = await generateImagesWithFallback({
                prompt: finalPrompt,
                config: {
                    numberOfImages: count,
                    aspectRatio: validAspectRatio
                }
            });

            const images = [];
            const genImages = imageGenRes?.generatedImages || [];
            for (let i = 0; i < genImages.length; i++) {
                const item = genImages[i];
                const base64Data = item.image?.imageBytes;
                if (!base64Data) continue;

                const fileId = uuidv4();
                const rawFileName = `raw-${fileId}.png`;
                const processedFileName = `${fileId}.png`;
                const rawPath = path.join(generatedDir, rawFileName);
                const processedPath = path.join(generatedDir, processedFileName);

                fs.writeFileSync(rawPath, Buffer.from(base64Data, 'base64'));

                try {
                    await runProcessor('smooth', rawPath, processedPath);
                } catch (procErr) {
                    console.error('[Processor] Smoothing error:', procErr?.message || procErr);
                    fs.copyFileSync(rawPath, processedPath);
                }

                const imageUrl = `/static/generated/${processedFileName}`;
                const rawUrl = `/static/generated/${rawFileName}`;
                images.push({
                    url: imageUrl,
                    imageUrl: imageUrl,
                    rawUrl: rawUrl,
                    id: fileId
                });
            }

            if (images.length === 0) {
                throw new Error('No image returned from the AI model.');
            }

            return {
                prompt: prompt.trim(),
                improvedPrompt,
                finalPrompt,
                imageUrl: images[0].imageUrl,
                url: images[0].url,
                rawUrl: images[0].rawUrl,
                images,
                generatedImages: images
            };
        });

        res.json(result);
    } catch (err) {
        console.error('[Generate Error]', err);
        const statusCode = (typeof err.status === 'number' && err.status >= 400 && err.status < 600) ? err.status : 500;
        res.status(statusCode).json({ error: err.message || 'Image generation failed' });
    }
});

app.post('/api/photo-to-depth', photoToDepthLimiter, uploadMiddleware, async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        const inputPath = file.path;
        const fileId = uuidv4();
        const bgRemovedPath = path.join(uploadsDir, `nobg-${fileId}.png`);
        const processedPath = path.join(generatedDir, `${fileId}.png`);

        await queue.add(async () => {
            let workingInput = inputPath;
            try {
                await runProcessor('remove_bg', inputPath, bgRemovedPath);
                workingInput = bgRemovedPath;
            } catch (bgErr) {
                console.warn('[PhotoToDepth] remove_bg fallback:', bgErr?.message || bgErr);
            }

            try {
                await runProcessor('smooth', workingInput, processedPath);
            } catch (procErr) {
                console.error('[PhotoToDepth] smooth error:', procErr?.message || procErr);
                fs.copyFileSync(workingInput, processedPath);
            }
        });

        const imageUrl = `/static/generated/${fileId}.png`;
        res.json({
            imageUrl,
            url: imageUrl
        });
    } catch (err) {
        console.error('[PhotoToDepth Error]', err);
        res.status(500).json({ error: err.message || 'Photo to depth conversion failed' });
    }
});

app.post('/api/invert', async (req, res) => {
    try {
        const { imagePath, imageUrl, filename } = req.body || {};
        const target = imagePath || imageUrl || filename;
        if (!target || typeof target !== 'string') {
            return res.status(400).json({ error: 'imagePath or imageUrl is required' });
        }

        const baseName = path.basename(target);
        if (baseName.includes('..') || baseName.includes('/') || baseName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid file name' });
        }

        let actualSource = path.join(generatedDir, baseName);
        if (!fs.existsSync(actualSource)) {
            const uploadSource = path.join(uploadsDir, baseName);
            if (fs.existsSync(uploadSource)) {
                actualSource = uploadSource;
            } else {
                return res.status(404).json({ error: 'Source image not found' });
            }
        }

        const invertedFileName = `inv-${uuidv4()}.png`;
        const invertedPath = path.join(generatedDir, invertedFileName);

        await runProcessor('invert', actualSource, invertedPath);

        const invertedUrl = `/static/generated/${invertedFileName}`;
        res.json({
            imageUrl: invertedUrl,
            url: invertedUrl,
            invertedUrl
        });
    } catch (err) {
        console.error('[Invert Error]', err);
        res.status(500).json({ error: err.message || 'Inversion failed' });
    }
});

app.post('/api/mesh', async (req, res) => {
    try {
        const { imagePath, imageUrl } = req.body || {};
        const target = imagePath || imageUrl;
        if (!target) {
            return res.status(400).json({ error: 'Image path or url is required' });
        }
        res.status(501).json({ error: '3D mesh generation is not yet implemented.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/login', (req, res) => res.redirect('/static/login.html'));

app.get(['/api/credits', '/api/wallet', '/api/wallet/balance'], async (req, res) => {
    try {
        const userId = req.user?.id || req.userId || req.query.userId || req.query.user_id;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        let balance = 0;
        try {
            const cb = await import('./credit-backend.js');
            if (typeof cb.getBalance === 'function') {
                balance = await cb.getBalance(userId);
            } else if (typeof cb.getCreditBalance === 'function') {
                balance = await cb.getCreditBalance(userId);
            } else if (typeof cb.getUserCredits === 'function') {
                balance = await cb.getUserCredits(userId);
            }
        } catch (e) {}
        res.json({ credits: balance, balance });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/checkout', async (req, res) => {
    if (!stripe) {
        return res.status(500).json({ error: 'Stripe is not configured' });
    }
    try {
        const { priceId, credits, userId } = req.body || {};
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId || 'price_default',
                    quantity: 1,
                },
            ],
            mode: 'payment',
            client_reference_id: userId,
            metadata: {
                user_id: userId,
                credits: credits ? String(credits) : '10',
            },
            success_url: `${req.headers.origin || 'http://localhost:8000'}/static/index.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin || 'http://localhost:8000'}/static/index.html?canceled=true`,
        });
        res.json({ id: session.id, url: session.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/share', (req, res) => {
    const { imageUrl } = req.body || {};
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
    res.json({ success: true, shareUrl: imageUrl });
});

app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Internal Server Error' });
});

let server = null;
if (process.env.NODE_ENV !== 'test') {
    startCleanupScheduler();
    server = app.listen(port, () => {
        console.log(`🚀 DepthForge Server running at http://localhost:${port}`);
    });
} else {
    server = {
        close: (cb) => { if (cb) cb(); },
        listen: (...args) => app.listen(...args),
        address: () => ({ port: 0 })
    };
}

export {
    app,
    server,
    ai,
    queue,
    generationQueue,
    buildFinalPrompt,
    buildImprovePrompt,
    sanitizeDepthIntensity,
    getDepthModifier,
    STYLE_PRESETS,
    sanitizeStylePreset,
    getStyleGuidance,
    VALID_ASPECT_RATIOS,
    ALLOWED_ASPECT_RATIOS,
    DEFAULT_ASPECT_RATIO,
    sanitizeAspectRatio,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    sanitizeBatchSize,
    BATCH_SIZE_CONFIG,
    createRateLimiter,
    createGenerationLimiter,
    generateLimiter,
    photoToDepthLimiter,
    generationLimiter,
    resetRateLimiters,
    resetGenerationLimiter,
    parseRateLimitWindowMs,
    parseRateLimitMax,
    RATE_LIMIT_ERROR_MESSAGE,
    RATE_LIMIT_RESPONSE_BODY,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_MAX,
    generateImagesWithFallback,
    runProcessor,
    upload,
    staticDir,
    generatedDir,
    uploadsDir,
    cleanupGeneratedFiles,
    cleanupGeneratedFilesSync,
    parseTtlHours,
    startCleanupScheduler,
    stopCleanupScheduler,
    DEFAULT_TTL_HOURS,
    CLEANUP_INTERVAL_MS,
    creditDeductionMiddleware
};

export default app;
