import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI } from '@google/genai';
import { spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

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
app.use(express.json({ limit: '50kb' }));

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

const runPythonProcessor = (command, args) => {
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

const photoUpload = multer({
    dest: uploadsDir,
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
    try {
        const studentPrompt = req.body.prompt || "";
        const aspectRatio = sanitizeAspectRatio(req.body.aspectRatio);
        const depthIntensity = sanitizeDepthIntensity(req.body.depth_intensity ?? req.body.depthIntensity);
        const stylePreset = sanitizeStylePreset(req.body.style_preset ?? req.body.stylePreset);
        
        const improveResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: buildImprovePrompt(studentPrompt, stylePreset),
            config: { responseMimeType: "application/json" }
        });
        const responseJson = JSON.parse(improveResponse.text);
        const finalPrompt = buildFinalPrompt(responseJson.improved_prompt || studentPrompt, depthIntensity);
        
        const isBatch = req.body.batch === true || req.body.batch === 'true' || req.body.numberOfImages === 4 || req.body.numberOfImages === '4';
        const numImages = isBatch ? 4 : 1;

        const imageResult = await ai.models.generateImages({
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
        for (const img of imageResult.generatedImages) {
            const filename = `${uuidv4().substring(0, 10)}.png`;
            const filepath = path.join(generatedDir, filename);
            const base64Data = img.image.imageBytes;
            await fs.promises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
            imageUrls.push(`/static/generated/${filename}`);
        }

        res.json({ 
            status: "success", 
            image_url: imageUrls[0],
            images: imageUrls,
            batch: isBatch
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
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
            model: 'gemini-2.5-flash',
            contents: [{
                parts: [
                    { inlineData: { mimeType: mimeType, data: photoBase64 } },
                    { text: `Analyze this photo for 3D depth and spatial structure. Identify the primary subject, its relative depth layers (foreground, midground, background), surface textures, and overall spatial composition. Then write a highly detailed prompt for generating a grayscale 3D height map of this scene. The height map should place the closest/tallest elements in pure white and the farthest/lowest in pure black. REQUIREMENTS: Demand perfectly smooth continuous gradients, soft shading, and organic rounded transitions. Do NOT include any mention of contours, layers, or topography.${styleClause} Output in JSON format with key "depth_prompt" containing the Imagen prompt string, and key "subject_description" with a one-sentence description of what was detected in the photo.` }
                ]
            }],
            config: { responseMimeType: 'application/json' }
        });

        const analysisJson = JSON.parse(analysisResponse.text);
        const depthPrompt = analysisJson.depth_prompt;
        const subjectDescription = analysisJson.subject_description || 'photo subject';

        if (!depthPrompt) throw new Error('Gemini could not analyze depth structure.');

        const finalDepthPrompt = buildFinalPrompt(depthPrompt, depthIntensity);

        const isBatch = req.body.batch === true || req.body.batch === 'true' || req.body.numberOfImages === 4 || req.body.numberOfImages === '4';
        const numImages = isBatch ? 4 : 1;

        const imageResult = await ai.models.generateImages({
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
        for (const img of imageResult.generatedImages) {
            const filename = `photo_depth_${uuidv4().substring(0, 10)}.png`;
            const filepath = path.join(generatedDir, filename);
            const base64Data = img.image.imageBytes;
            await fs.promises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
            imageUrls.push(`/static/generated/${filename}`);
        }

        await fs.promises.unlink(uploadedPath).catch(() => {});

        res.json({
            status: 'success',
            image_url: imageUrls[0],
            images: imageUrls,
            batch: isBatch,
            subject: subjectDescription
        });
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
    validateEnvironment
};