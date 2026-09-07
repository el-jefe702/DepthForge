<div align="center">
  <h1>⚡ DepthForge</h1>
  <p><strong>AI-Powered 16-bit 3D Relief & Depth Map Generator for CNC Laser Engraving</strong></p>

  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/Kotlin-Jetpack%20Compose-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white" alt="Kotlin" />
</div>

<hr />

## Overview

DepthForge generates flawless 16-bit 3D grayscale height maps optimized for CNC laser engraving. It combines **Google Gemini** for intelligent prompt expansion, **Google Imagen 4** for depth map generation, and an **OpenCV post-processing pipeline** for production-quality output.

### Core Features

- **Text-to-Depth**: Describe what you want to carve → AI generates a 16-bit height map
- **Photo-to-Depth**: Upload a photo → Gemini Vision analyzes spatial structure → generates matching depth map
- **Aspect Ratio Selector (F1)**: Choose from `1:1` (default), `4:3`, `3:2`, `16:9`, or `2:3` for both text prompt and photo-to-depth modes
- **Invert Depth Map (F2)**: Invert depth values (`65535 - pixel` for 16-bit, `255 - pixel` for 8-bit) to switch between convex/concave reliefs
- **Prompt History (F3)**: Automatically persists recent prompts in `localStorage` / `SharedPreferences` with quick selection and clear support
- **Real-Time Pipeline Progress via SSE (F4)**: Live 5-step progress streaming over Server-Sent Events (`/api/postprocess-stream`)
- **Session Gallery / History Panel (F5)**: Horizontal scrollable thumbnail strip below the preview area displaying all generated and post-processed versions in the session. Clicking any thumbnail restores that version to the active preview with all action buttons (Invert, Remove BG, Polish, Download) re-targeted to it. Includes Hide/Show and Clear controls, strict concurrency guards blocking race conditions during in-flight network requests, mobile viewport responsiveness down to <360px width, and native touch momentum scrolling.
- **Depth Intensity Slider (F6)**: Adjust carve depth and relief contrast from 0 to 100% (default 70%). Modulates prompts dynamically: 0–30% produces gentle, shallow relief with subtle height transitions; 31–69% applies standard relief depth; 70–100% generates dramatic, maximum-depth carving with extreme black-to-white contrast. Includes full WCAG 2.1 AA accessibility (ARIA value indicators, title tooltips, keyboard focus states) and automatic panel synchronization.
- **Side-by-Side Comparison View (F7)**: Interactive split-screen comparison mode showing "Before" and "After" depth maps side-by-side with a draggable vertical divider slider. Activates automatically or via the "⚖️ Compare" action button after any post-processing operation (Invert, Remove BG, Polish for CNC). Features high-contrast badges (Orange "Before", Indigo "After" with smooth edge fading), polygon clip-path rendering, unified PointerEvents drag (supporting mouse, multi-touch, and pen/stylus inputs with `touch-action: none`), complete keyboard slider accessibility (Left/Right/Home/End/PageUp/PageDown and `Escape` key dismissal), deadlock-free lifecycle teardown across view exits, window blur focus-loss protection, and a quick "✕ Close Comparison" / "👁️ Normal View" toggle.
- **Automatic Generated File Cleanup (F8)**: Automated background maintenance routine executing on server startup and hourly intervals. Automatically scans `static/generated/` and purges depth maps older than `GENERATED_TTL_HOURS` (defaulting to 24 hours) while preserving fresh images within the TTL window. Handles missing directories, empty folders, locked files, and non-file system artifacts gracefully without crashing, logging execution summaries cleanly to stdout.
- **Health Check Endpoint (F9)**: Production health check endpoint at `GET /api/health` returning HTTP 200 with dynamic `package.json` version resolution (BOM- and corruption-resilient), non-blocking TTL-cached Python and `processor.py` engine availability verification, process uptime, strict anti-caching HTTP headers (`Cache-Control: no-store, no-cache...`), and ISO timestamp. Supports `HEAD` and `OPTIONS` probes, returning `405 Method Not Allowed` with `Allow: GET, HEAD, OPTIONS` on disallowed methods. Fully integrated with Docker Compose container monitoring and Android `ApiClient.checkHealth()` / `isHealthy()` with malformed URL and non-JSON proxy error resilience.
- **Rate Limiting (F10)**: Configurable IP-based rate limiting protecting AI generation routes (`POST /api/generate` and `POST /api/photo-to-depth`) via `express-rate-limit`. Defaults to 10 requests per 15-minute window per IP, configurable via `RATE_LIMIT_WINDOW_MS` (default `900000` ms = 15 minutes) and `RATE_LIMIT_MAX` (default `10`). When exceeded, returns HTTP 429 Too Many Requests with JSON payload `{"error": "Too many requests. Please wait before generating again."}` and standard rate limit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`). Non-generation routes (`/api/health`, `/api/postprocess`, `/api/postprocess-stream`, `/api/invert`, `/api/remove_bg`, and all `/static/` assets) remain completely unthrottled. Handled cleanly in Web UI with user alerts and in Android with native snackbars and error state.
- **3D Live Preview (F11)**: Interactive WebGL 3D displacement preview powered by Three.js. Converts 2D grayscale height maps into interactive 3D relief meshes directly in the browser with real-time orbit controls (rotate, pan, zoom), directional lighting, camera reset, and clean 2D/3D state transitions. Android Native integration provides full feature visibility and informational dialog in Jetpack Compose.
- **Style Presets (F12)**: Selectable genre presets (`Portrait`, `Wildlife`, `Ornamental`, `Floral`, `Architecture`, `Abstract`) that inject CNC-specific style preambles into prompt enhancement, biasing depth transitions, relief volume, and contours appropriately for each carving domain without modifying user prompt text.
- **Batch Generation — Pick the Best (F13)**: Generate 4 candidate depth variations simultaneously with dedicated "⚡ Generate ×4" and "⚡ Convert ×4" buttons. Candidates render in an interactive 2×2 grid with numbered badges; clicking any candidate immediately sets it as active for polishing, 3D inspection, comparison, and export. All variations are automatically added to the session gallery.
- **Environment Validation at Startup (F14)**: Fails fast on server startup if `GEMINI_API_KEY` is missing or empty, outputting clear troubleshooting guidance and exiting with code 1 before binding ports. Non-critically validates Python 3 and `processor.py` availability, printing formatted warnings if post-processing runs in bypass mode. Exposes a standalone, unit-tested `validateEnvironment` helper.
- **Gemini Prompt Response Robustness (F15)**: Robust JSON parsing and fallback handling for Gemini prompt enhancement and Vision analysis. Strips markdown fences (```` ```json ````), logs raw parse errors, and falls back gracefully to the original user prompt or sanitized model output rather than crashing with HTTP 500.
- **Multer UUID Filenames with Extension (F16)**: Configures `multer.diskStorage` for photo uploads to generate collision-free UUID filenames that safely preserve original extensions (e.g. `upload_<uuid>.jpg`, `.png`, `.webp`) rather than extensionless defaults. Ensures automated unlinking/cleanup after processing.
- **Background Removal**: Isolate subjects onto pure black backgrounds with `rembg`
- **Lossless Export**: Export production-ready 16-bit PNG depth maps

### Platforms

- **Web**: Single-page static frontend served from Express with built-in aspect ratio selector, depth intensity slider, prompt history, session gallery, side-by-side comparison view, 3D live preview displacement mesh, real-time SSE progress, and action controls
- **Android**: Native Jetpack Compose app (single-screen forge with native chips, depth intensity slider, prompt history dropdown, session gallery LazyRow, before/after comparison split view with draggable divider, 3D preview dialog, real-time SSE animation, and action controls)

---

## Architecture

```
┌─────────────────────────┐       ┌────────────────────────────────┐
│  Web Browser            │       │  Android App (Kotlin/Compose)  │
│  static/index.html      │       │  Single-screen forge UI        │
└─────────┬───────────────┘       └──────────┬─────────────────────┘
          │ HTTP/REST / SSE                   │ HTTP/REST / SSE
          ▼                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│  Express Server (server.js)  — Port 8000                         │
│                                                                  │
│  GET  /api/health              → Health status, version & Python │
│  POST /api/generate            → Gemini + Imagen 4 (rate limited: 10/15m)         │
│  POST /api/photo-to-depth      → Gemini Vision + Imagen 4 (rate limited: 10/15m)  │
│  POST /api/invert              → spawns processor.py invert      │
│  GET  /api/postprocess-stream  → spawns processor.py smooth (SSE)│
│  POST /api/remove_bg           → spawns processor.py remove_bg   │
│  Scheduled Task (cleanup.js)   → Hourly TTL cleanup of generated/│
└───────────────────────────────┬──────────────────────────────────┘
                                │ child_process.spawn
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│  Python Processor (processor.py)                                 │
│                                                                  │
│  invert:     pixel inversion (65535 - pixel / 255 - pixel)       │
│  smooth:     8→16bit upscale → inpaint → bilateral → normalize   │
│  remove_bg:  rembg foreground isolation → black background       │
│  export:     16-bit PNG depth map                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- **Python** 3.10+ with `opencv-python`, `numpy`, `rembg`
- **Google Gemini API Key** (set in `.env`)

### Setup

```bash
# Clone
git clone https://github.com/el-jefe702/DepthForge.git
cd DepthForge

# Install Node dependencies
npm install

# Install Python dependencies
pip install opencv-python numpy rembg

# Configure environment (.env)
echo "GEMINI_API_KEY=your_key_here" > .env
# Optional: customize generated file TTL in hours (default: 24)
# echo "GENERATED_TTL_HOURS=24" >> .env
# Optional: customize AI generation rate limiting (defaults: 10 requests per 15-minute window per IP)
# echo "RATE_LIMIT_WINDOW_MS=900000" >> .env
# echo "RATE_LIMIT_MAX=10" >> .env
# Optional: trust reverse proxy headers (e.g., Nginx, Cloudflare, Docker) for accurate client IP rate limiting
# echo "TRUST_PROXY=true" >> .env

# Start the server (runs initial cleanup and schedules hourly maintenance)
npm start
```

Open **http://localhost:8000** in your browser.

### Development

```bash
npm run dev    # Hot-reload with --watch
npm test       # Run automated unit & integration test suite
node cleanup.js [dir] [ttlHours] # Run generated file cleanup manually via CLI (or --dir / --ttl flags)
```

---

## API Endpoints

| Endpoint | Method | Body / Params | Response | Description |
|---|---|---|---|---|
| `/api/health` | GET, HEAD, OPTIONS | None | `{"status": "ok", "version": "2.0.0", "python": true, "uptime": 12.34, "timestamp": "..."}` | Returns service health status, dynamic package.json version, Python engine availability, uptime, and timestamp. Disallowed methods (POST, PUT, DELETE, PATCH) return 405 Method Not Allowed with Allow header. |
| `/api/generate` | POST | `{"prompt": "...", "aspectRatio": "1:1", "depth_intensity": 70}` | `{"status": "success", "image_url": "/static/generated/xxx.png"}` (or HTTP 429: `{"error": "..."}`) | Generates depth map from text prompt. `aspectRatio` defaults to `1:1` (`1:1`, `4:3`, `3:2`, `16:9`, `2:3`). `depth_intensity` (0–100) defaults to `70`. Protected by rate limiter (default 10 req / 15 min per IP; configurable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`). |
| `/api/photo-to-depth` | POST | Multipart `photo` file, optional `aspectRatio`, optional `depth_intensity` | `{"status": "success", "image_url": "...", "subject": "..."}` (or HTTP 429: `{"error": "..."}`) | Analyzes photo and generates depth map with requested aspect ratio and depth intensity (default 70). Protected by rate limiter (default 10 req / 15 min per IP; configurable via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`). |
| `/api/invert` | POST | `{"image_url": "..."}` | `{"status": "success", "image_url": "/static/generated/inv_xxx.png"}` | Inverts depth map pixel values (16-bit or 8-bit). |
| `/api/postprocess-stream` | GET / POST | `?image_url=...` | `text/event-stream` | Streams 5-step smoothing progress in real-time over SSE. |
| `/api/remove_bg` | POST | `{"image_url": "..."}` | `{"status": "success", "image_url": "/static/generated/iso_xxx.png"}` | Isolates subject onto pure black background. |

---

## Post-Processing Pipeline

The Python processor (`processor.py`) applies a 5-stage pipeline:

1. **16-Bit Upscaling**: Converts 8-bit (0–255) → 16-bit (0–65535) via ×257 multiplication
2. **Inpainting**: Detects and fills zero-value holes using morphological closing + Telea inpainting
3. **Bilateral Filtering**: `cv2.bilateralFilter(d=9, sigmaColor=5000, sigmaSpace=5)` — removes banding while preserving edges
4. **Normalization**: Linear stretch to full 0–65535 range for maximum Z-axis depth utilization
5. **Lossless Export**: 16-bit PNG with compression level 9

---

## Android App

The Android app (`android_app/`) is a native Jetpack Compose application providing the same forge experience on mobile:

- Single-screen UI with text prompt and photo upload modes
- Native prompt history dropdown and aspect ratio chip selectors
- Horizontal session gallery thumbnail strip with restore and clear/hide controls
- Real-time SSE post-processing progress animation
- Save depth maps directly to device gallery
- Configurable server URL via settings dialog

---

## License

SLCreations, LLC © 2026