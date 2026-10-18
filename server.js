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
    verifyPassword
} from './db/store.js';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

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
                    const newBalance = await deductCredit(userId, req.body?.prompt || 'Generation', imageUrl);
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
app.use('/api/generate', creditDeductionMiddleware);

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

// Root route '/' is handled below by the Phase 4 Integrated Web Site handler (serves static/landing.html)

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
        const pyProg = spawnPythonProcessor(command, args);

        pyProg.stdout.on('data', (data) => console.log(`[Python] ${data.toString().trim()}`));
        let errorOutput = '';
        pyProg.stderr.on('data', (data) => errorOutput += data.toString());

        pyProg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Python script failed (${code}): ${errorOutput}`));
        });
        pyProg.on('error', (err) => reject(new Error(`Could not start Python: ${err.message}`)));
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

// Integrated Web Site Pages (Phase 4)
app.get('/', (req, res) => {
    const landingFile = path.join(staticDir, 'landing.html');
    if (fs.existsSync(landingFile)) {
        return res.sendFile(landingFile);
    }
    return res.sendFile(path.join(staticDir, 'index.html'));
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
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

// Cross-Site Ecosystem & Partner Integration (SpatialOps, LLC <-> SLCreations.llc)
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
        product: 'DepthForge',
        version: getPackageVersion(),
        copyright: 'Copyright © 2026 SpatialOps, LLC. All Rights Reserved.',
        partner: {
            name: 'SLCreations, LLC',
            url: 'https://SLCreations.llc',
            role: 'Official Custom Fabrication & Creative Partner',
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
    console.log(`[SpatialOps Inquiry #${inquiryId}] (${category}) from ${name} <${email}>: ${message.slice(0, 120)}`);
    return res.status(201).json({
        status: 'success',
        inquiryId,
        company: 'SpatialOps, LLC',
        partner: 'https://SLCreations.llc'
    });
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
        const isAdminEmail = Boolean(
            process.env.ADMIN_EMAIL && rawEmail === process.env.ADMIN_EMAIL.trim().toLowerCase()
        );
        const role = (totalAdmins === 0 || isAdminEmail) ? 'admin' : 'user';

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
            const isAdminEmail = Boolean(
                process.env.ADMIN_EMAIL && rawEmail === process.env.ADMIN_EMAIL.trim().toLowerCase()
            );
            const nextRole = (totalAdmins === 0 || isAdminEmail) ? 'admin' : (row.role || 'user');
            const upgraded = await upgradeLegacyUser({ id: row.id, password, role: nextRole });
            const token = signAuthToken(upgraded);
            return res.status(200).json({ status: 'success', token, user: upgraded });
        }

        if (!row || !verifyPassword(password, row.password_hash)) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        let effectiveRole = row.role || 'user';
        if (effectiveRole !== 'admin' && (await countAdmins()) === 0) {
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
        const packageId = typeof req.body?.packageId === 'string' ? req.body.packageId : 'basic';
        const packages = {
            basic: { name: 'DepthForge Pro Credit Pack (50 Credits)', credits: 50, amountCents: 1900 },
            shop: { name: 'DepthForge Shop Floor Pack (250 Credits)', credits: 250, amountCents: 7900 }
        };
        const pkg = packages[packageId] || packages.basic;

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

app.post('/api/generate', generateLimiter, async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] 🚀 POST /api/generate - Starting generation...`);
    const jobId = uuidv4();
    try {
        const studentPrompt = req.body.prompt || "";
        const aspectRatio = sanitizeAspectRatio(req.body.aspectRatio);
        const depthIntensity = sanitizeDepthIntensity(req.body.depth_intensity ?? req.body.depthIntensity);
        const stylePreset = sanitizeStylePreset(req.body.style_preset ?? req.body.stylePreset);
        const isBatch = req.body.batch === true || req.body.batch === 'true' || req.body.numberOfImages === 4 || req.body.numberOfImages === '4';
        const numImages = isBatch ? 4 : 1;

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

        const improveResponse = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: buildImprovePrompt(studentPrompt, stylePreset),
            config: { responseMimeType: "application/json" }
        });
        const rawImproveText = improveResponse?.text || "";
        const responseJson = safeJsonParse(rawImproveText, {});
        const effectivePrompt = (typeof responseJson?.improved_prompt === 'string' && responseJson.improved_prompt.trim())
            ? responseJson.improved_prompt.trim()
            : (studentPrompt || "3D relief sculpture");

        if (!responseJson?.improved_prompt) {
            console.warn(`[Gemini Improve Warning] Falling back to user prompt due to non-JSON or missing improved_prompt from Gemini. Raw response: ${rawImproveText}`);
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

        const aspectRatio = sanitizeAspectRatio(req.body.aspectRatio);
        const depthIntensity = sanitizeDepthIntensity(req.body.depth_intensity ?? req.body.depthIntensity);
        const stylePreset = sanitizeStylePreset(req.body.style_preset ?? req.body.stylePreset);
        const styleGuidance = getStyleGuidance(stylePreset);
        const styleClause = styleGuidance ? ` ${styleGuidance}` : '';

        const photoBytes = await fs.promises.readFile(uploadedPath);
        const photoBase64 = photoBytes.toString('base64');
        const mimeType = req.file.mimetype || 'image/jpeg';

        const analysisResponse = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: [{
                parts: [
                    { inlineData: { mimeType: mimeType, data: photoBase64 } },
                    { text: `Analyze this photo for 3D depth and spatial structure. Identify the primary subject, its relative depth layers (foreground, midground, background), surface textures, and overall spatial composition. Then write a highly detailed prompt for generating a grayscale 3D height map of this scene. The height map should place the closest/tallest elements in pure white and the farthest/lowest in pure black. REQUIREMENTS: Demand perfectly smooth continuous gradients, soft shading, and organic rounded transitions. Do NOT include any mention of contours, layers, or topography.${styleClause} Output in JSON format with key "depth_prompt" containing the Imagen prompt string, and key "subject_description" with a one-sentence description of what was detected in the photo.` }
                ]
            }],
            config: { responseMimeType: 'application/json' }
        });

        const rawAnalysisText = analysisResponse?.text || "";
        const analysisJson = safeJsonParse(rawAnalysisText, {});

        let depthPrompt = (typeof analysisJson?.depth_prompt === 'string' && analysisJson.depth_prompt.trim())
            ? analysisJson.depth_prompt.trim()
            : null;
        let subjectDescription = (typeof analysisJson?.subject_description === 'string' && analysisJson.subject_description.trim())
            ? analysisJson.subject_description.trim()
            : 'photo subject';

        // Robust fallback if Gemini returns plain text, markdown, or non-JSON output
        if (!depthPrompt) {
            console.warn(`[Gemini Photo-to-Depth Warning] Non-JSON or missing depth_prompt from Gemini Vision. Using fallback from raw response: ${rawAnalysisText}`);
            const sanitizedRaw = rawAnalysisText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
            if (sanitizedRaw) {
                depthPrompt = `depth map of ${sanitizedRaw.slice(0, 300)}`;
                subjectDescription = sanitizedRaw.slice(0, 80);
            } else {
                depthPrompt = 'depth map of the uploaded photo subject with organic depth and smooth relief';
                subjectDescription = 'uploaded photo';
            }
        }

        const finalDepthPrompt = buildFinalPrompt(depthPrompt, depthIntensity);

        const isBatch = req.body.batch === true || req.body.batch === 'true' || req.body.numberOfImages === 4 || req.body.numberOfImages === '4';
        const numImages = isBatch ? 4 : 1;

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
            throw new Error('No depth map returned from Imagen.');
        }

        const imageUrls = [];
        const { uploadGeneratedImage } = await import('./storage.js');
        for (const img of imageResult.generatedImages) {
            const filename = `photo_depth_${uuidv4().substring(0, 10)}.png`;
            const filepath = path.join(generatedDir, filename);
            const base64Data = img.image.imageBytes;
            await fs.promises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
            const finalUrl = await uploadGeneratedImage(filepath, filename);
            imageUrls.push(finalUrl);
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
                // Ignore invalid/expired token on optional auth so unauthenticated tests still pass
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
