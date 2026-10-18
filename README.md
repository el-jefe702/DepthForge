<div align="center">
  <h1>⚡ DepthForge v2.0</h1>
  <p><strong>Industrial 16-Bit 3D Relief, Photo-to-Carve &amp; Spatial AI CAD/CAM Platform by SLCreations, LLC</strong></p>
  <p><em>Official Fabrication &amp; Creative Studio: <a href="https://SLCreations.llc">SLCreations.llc</a></em></p>

  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/Kotlin-Jetpack%20Compose-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white" alt="Kotlin" />
  <img src="https://img.shields.io/badge/License-Proprietary%20SLCreations%20LLC-0ea5e9?style=for-the-badge" alt="Proprietary License" />
</div>

<hr />

This repository is deployed on a live Linux VPS via automated GitHub Actions CI/CD (`.github/workflows/deploy.yml`) and Docker Compose.

## Overview

Engineered by **SLCreations, LLC**, **DepthForge** generates flawless 16-bit 3D grayscale height maps (`0–65535` Z-axis precision) and watertight 3D meshes (`STL` / `OBJ`) optimized for CNC routers, fiber/CO₂ laser engraving, and additive manufacturing. It combines **Google Gemini** for spatial prompt engineering and photo depth analysis, **Google Imagen 4** for heightmap synthesis, an **OpenCV 16-bit post-processing pipeline** for zero-banding surface smoothing, and direct physical fabrication integration with **[SLCreations.llc](https://SLCreations.llc)**.

---

## Project Updates & Release Timeline

| Phase | Milestone | Status | Key Deliverables |
|---|---|---|---|
| **Phase 1** | **Core 16-Bit AI Relief & OpenCV Pipeline** | ✅ **Completed** | Text-to-Depth (`/api/generate`), Photo-to-Carve (`/api/photo-to-depth`), 5-stage 16-bit OpenCV smoothing (`processor.py`), `rembg` subject isolation, depth inversion, SSE live progress streaming, session gallery, side-by-side comparison slider, and full `F1`–`F20` feature suite. |
| **Phase 2** | **3D CAD/CAM Mesh Engine & Native Mobile** | ✅ **Completed** | Interactive Three.js WebGL 3D relief inspector, client/server binary **STL** & **OBJ** watertight mesh exporter (`static/mesh-exporter.js`), Blender add-on (`blender_plugin/`), and Jetpack Compose Android app (`android_app/`). |
| **Phase 3** | **Production Infrastructure, Queueing & Ledger** | ✅ **Completed** | BullMQ + Redis job queue (`worker.js`), `PQueue` Python process serialization, IP rate limiting, SQLite/PostgreSQL credit wallet ledger, Stripe webhook integration, and automated GitHub Actions VPS deployment (`.github/workflows/deploy.yml`). |
| **Phase 4** | **SLCreations Web Suite, Auth, Consoles & LightBurn API** | ✅ **Live (v2.0)** | Self-hosted `crypto.scrypt` + `HS256` JWT authentication (`/login`, `/signup`, `/api/auth/*`) with automatic admin promotion & `401` session self-healing; User Dashboard (`/dashboard`); Admin Console (`/admin`) with live KPIs, user search, credit grants, role management & laser queue; **SLCreations, LLC** corporate website (`/`, `/solutions`, `/pricing`, `/about`, `/terms`, `/privacy`); direct **Photo-to-Carve** (`?mode=photo`) studio entry; **LightBurn Laser Integration API** (`/api/laser/lightburn/*`) with `.lbrn2` project file generation; and cross-site API (`/api/ecosystem/info`, `/api/contact`). |
| **Phase 5** | **Commercial Billing & Direct Fabrication Handoff** | 🗓️ **Next Up (v2.1)** | **T+1–2 Days**: Live Stripe production Price IDs & webhook secret activation for instant credit pack top-ups (`/api/wallet/checkout`) + production domain TLS/SSL.<br>**T+1–2 Weeks**: 1-click **"Send to SLCreations.llc for Physical Carving"** automated job ticket handoff (attaching 16-bit PNG + STL mesh directly to an SLCreations custom fabrication order) and CNC toolpath preview. |

### Latest v2.0 Platform Updates (October 2026)

- **SLCreations, LLC Corporate Web Suite (Direction A — Industrial Precision CAD/CAM)**:
  - `/` (`static/landing.html`): Interactive Z-Relief split-screen inspector, telemetry bar, 4-stage pipeline showcase, and direct CTAs for **✏️ Text to Relief Studio** (`/app`) and **📷 Photo to Carve** (`/app?mode=photo`).
  - `/solutions` (`static/solutions.html`): Deep dive into CNC 3-axis/4-axis routing, fiber/CO₂ laser 3D relief, additive manufacturing, and physical custom fabrication via **[SLCreations.llc](https://SLCreations.llc)**.
  - `/pricing` (`static/pricing.html`): Transparent **Starter (10 Free Credits)**, **Pro Maker (\$19 / 50 Credits)**, and **Shop Floor / Enterprise (\$79 / 250 Credits)** tiers.
  - `/about` (`static/about.html`): SLCreations, LLC company profile, studio fabrication services, and interactive contact/fabrication inquiry form (`POST /api/contact`).
  - `/terms` & `/privacy` (`static/terms.html`): Proprietary software licensing, customer output ownership, and data privacy policies under **Copyright © 2026 SLCreations, LLC. All Rights Reserved.**
- **LightBurn Laser Integration API & Operator Queue**:
  - Direct export of 16-bit relief depth maps to native LightBurn (`.lbrn2`) XML project files with embedded base64 bitmaps and calibrated grayscale power/speed cut layers (`POST /api/laser/lightburn/export`).
  - Material presets for Hardwood (Deep 3D), Cast Acrylic, Fiber Laser / Slate / Metal, and Softwood (`GET /api/laser/lightburn/presets`).
  - Laser operator job queue (`/api/laser/lightburn/queue`) with status tracking (`queued`, `engraving`, `completed`) in the Admin Console.
- **Self-Hosted Authentication, User Dashboard & Admin Console**:
  - Zero external auth vendor lock-in: `crypto.scrypt` password hashing + `HS256` JWT tokens stored in dual-mode PostgreSQL (`DATABASE_URL`) or SQLite (`SUBSCRIPTIONS_DB_PATH`) via `db/store.js`.
  - First registered account (or `ADMIN_EMAIL`) is automatically granted `admin` privileges, and legacy passwordless rows are seamlessly upgraded on first sign-in.
  - Multi-secret fallback verification (`verifyTokenWithFallbacks`) and automatic `401` session recovery (`POST /api/auth/guest`) ensure zero token-expiration interruptions in Forge Studio (`/app`).

---

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
- **`processor.py` Step Order & Structure (F17)**: Fully aligned, sequential step comments (STEP 1 through STEP 5) matching actual execution and SSE streaming stages: Load/16-bit conversion → Inpainting missing data → Bilateral spatial filtering → Depth normalization → Lossless 16-bit export.
- **Concurrency Queue for Python Processor (F18)**: Serializes resource-intensive Python subprocess calls (`runPythonProcessor` for Polish, Invert, Remove BG) through an in-memory `PQueue` with `concurrency: 1`. Prevents competing CPU/memory spikes and logs queue depth when tasks are queued behind an active operation.
- **Android Share Intent (F19)**: Native Android sharing via system share sheet (`Intent.ACTION_SEND`, `type = "image/png"`). Shares generated, polished, inverted, and background-removed depth maps using a secure Android FileProvider (`cacheDir/share/depth_share_<timestamp>.png`) with `FLAG_GRANT_READ_URI_PERMISSION`.
- **Comprehensive README Documentation Update (F20)**: Comprehensive, synchronized project documentation across Web, Node.js Express server, Python OpenCV pipeline, and native Jetpack Compose Android app. Fully documents all features (F1 through F20), REST and SSE API endpoints, prerequisites, installation workflows, environment variables, dependencies, and project directory structure with automated test suite verification (`tests/readme_verification.test.js`).
- **Background Removal**: Isolate subjects onto pure black backgrounds with `rembg`
- **Lossless Export**: Export production-ready 16-bit PNG depth maps
- **Modern Luxury Forge Aesthetic**: Custom 3D volcanic obsidian & molten laser gold branding, frosted glassmorphism interface (`backdrop-filter: blur(16px)`), specular border highlights, responsive blueprint grid preview canvas, glowing range sliders, animated status badges, and enhanced interactive states across Web and Android WebView mirroring.

### Platforms

- **Web**: Single-page static frontend served from Express (`static/index.html`, `static/style.css`) with built-in aspect ratio selector, depth intensity slider, prompt history, session gallery, side-by-side comparison view, 3D live preview displacement mesh, real-time SSE progress, luxury glassmorphic design system, and action controls
- **Android**: Native Jetpack Compose app (`android_app/`) (single-screen forge with native chips, depth intensity slider, prompt history dropdown, session gallery LazyRow, before/after comparison split view with draggable divider, 3D preview dialog, real-time SSE animation, Android Share Sheet integration, mirrored high-tech WebView assets, and action controls)

---

## Architecture

```
┌─────────────────────────────────────────────┐       ┌─────────────────────────────────────────────┐
│  Web Browser                                │       │  Android App (Kotlin & Jetpack Compose)     │
│  static/index.html & static/style.css       │       │  ForgeScreen & ApiClient                    │
└──────────────────────┬──────────────────────┘       └──────────────────────┬──────────────────────┘
                       │ HTTP / REST / SSE                                   │ HTTP / REST / SSE
                       ▼                                                     ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Express Server (server.js)  — Port 8000                                                          │
│                                                                                                   │
│  GET  /api/health              → Health status, package.json version & Python engine check        │
│  POST /api/generate            → Gemini prompt expansion + Imagen 4 (rate limited + credit gate)  │
│  POST /api/photo-to-depth      → Gemini Vision spatial analysis + Imagen 4 (rate limited)         │
│  GET  /api/jobs/:id            → Background job status polling for queued BullMQ jobs             │
│  POST /api/postprocess         → Serialized Python processor smooth (PQueue concurrency:1)        │
│  GET  /api/postprocess-stream  → Serialized Python processor smooth with live SSE events          │
│  POST /api/invert              → Serialized Python processor invert (PQueue concurrency:1)        │
│  POST /api/remove_bg           → Serialized Python processor remove_bg (rembg ML)                 │
│  POST /api/webhooks/stripe     → Stripe webhook credit fulfillment & ledger updates               │
│  Scheduled Task (cleanup.js)   → Automated hourly TTL cleanup of static/generated/                │
└─────────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                              │ child_process.spawn via PQueue (concurrency: 1)
                                              ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Python Processor (processor.py)                                                                  │
│                                                                                                   │
│  invert:     pixel inversion (65535 - pixel for 16-bit / 255 - pixel for 8-bit)                   │
│  smooth:     STEP 1 (float32 grayscale) → STEP 2 (inpaint) → STEP 3 (bilateral) →                 │
│              STEP 4 (normalize) → STEP 5 (lossless 16-bit PNG export)                             │
│  remove_bg:  rembg U2Net foreground segmentation → pure black background                          │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- **Node.js** 18+
- **Python** 3.10+ with `opencv-python`, `numpy`, and `rembg`
- **Google Gemini API Key** (configured as `GEMINI_API_KEY` in `.env`)

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
cp .env.example .env
```

### Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | String | *Required* | API key for Google Gemini and Google Imagen 4 access via `@google/genai`. Validated at startup (F14). |
| `JWT_SECRET` | String | *Optional in test* | Secret key used by `middleware/auth.js` (`creditGate`) to verify bearer JWT tokens. |
| `REDIS_URL` | String | `redis://127.0.0.1:6379` | Redis connection URL for BullMQ background job queue (`worker.js`). |
| `SUBSCRIPTIONS_DB_PATH` | String | `./subscriptions.db` | SQLite database file path for credit wallets and transaction ledger (`db/init.js`). |
| `GENERATED_TTL_HOURS` | Number / String | `24` | Time-to-live in hours for generated files in `static/generated/`. Purged by background cleanup scheduler (F8). |
| `RATE_LIMIT_WINDOW_MS` | Number / String | `900000` | Window size in milliseconds for IP rate limiting on AI generation endpoints (default: 15 minutes = `900000` ms) (F10). |
| `RATE_LIMIT_MAX` | Number / String | `10` | Maximum number of AI generation requests permitted per IP within the rate limit window (F10). |
| `TRUST_PROXY` | Boolean / String / Number | `false` | Express trust proxy setting (`true`, `false`, hop count, or subnet) for accurate client IP resolution behind reverse proxies (F10). |
| `PORT` | Number / String | `8000` | Port number for Express HTTP and SSE server binding. |

### Key Dependencies

#### Node.js (`package.json`)
- `@google/genai` (`^2.8.0`): Official Google Gen AI SDK for Gemini prompt enhancement and Imagen 4 generation.
- `express` (`^4.21.0`): Core HTTP web server and REST/SSE routing framework.
- `express-rate-limit` (`^8.7.0`): IP-based rate limiting protecting AI generation routes (`/api/generate`, `/api/photo-to-depth`).
- `multer` (`^1.4.5-lts.1`): Multipart form-data handling for photo uploads with UUID and extension preservation.
- `p-queue` (`^9.3.3`): Promise-based concurrency queue serializing Python subprocess execution (`concurrency: 1`).
- `bullmq` (`^5.7.0`) & `ioredis` (`^5.3.2`): Redis-backed background job queue for asynchronous image generation.
- `jsonwebtoken` (`^9.0.2`) & `sqlite3` (`^5.1.7`): JWT authentication and SQLite credit ledger management.
- `uuid` (`^14.0.0`): Cryptographically secure UUIDv4 generation for file naming.
- `dotenv` (`^16.4.5`): Environment variable loader from `.env`.

#### Python (`processor.py`)
- `opencv-python`: High-performance computer vision library for bilateral filtering, inpainting, and 16-bit PNG I/O.
- `numpy`: Fast multidimensional array math for 16-bit depth scaling, channel indexing, and normalization.
- `rembg`: Machine learning background removal model (U2Net) isolating foreground subjects onto black backgrounds.

### Starting the Server

```bash
# Start the server (runs initial cleanup and schedules hourly maintenance)
npm start

# Development mode with hot-reload
npm run dev

# Run automated test suites
npm test

# Run generated file cleanup manually via CLI
node cleanup.js [dir] [ttlHours]
```

Open **http://localhost:8000** in your browser.

### VPS Deployment (Docker Compose & Systemd)

DepthForge is deployed on a Linux VPS using Docker Compose (`docker-compose.yaml`) or native `systemd` service units (`systemd/`) alongside deployment helper scripts (`scripts/`) and database migrations (`supabase/migrations`).

```bash
# Start via Docker Compose
docker compose up --build -d
curl --fail http://localhost:8000/api/health
```

---

## API Endpoints

| Endpoint | Method | Body / Query Params | Response | Description |
|---|---|---|---|---|
| `/api/health` | GET, HEAD, OPTIONS | None | `{"status": "ok", "version": "2.0.0", "python": true, "uptime": 12.34, "timestamp": "..."}` | Returns service health status, dynamic package.json version, Python engine availability, uptime, and timestamp. Disallowed methods (POST, PUT, DELETE, PATCH) return 405 Method Not Allowed with Allow header. |
| `/api/generate` | POST | `{"prompt": "...", "aspectRatio": "1:1", "depth_intensity": 70, "style_preset": "Wildlife", "batch": false}` | `{"status": "success", "image_url": "/static/generated/xxx.png", "images": [...], "batch": false, "job_id": "..."}` | Generates depth map from text prompt. `aspectRatio` defaults to `1:1` (`1:1`, `4:3`, `3:2`, `16:9`, `2:3`). `depth_intensity` (0–100) defaults to `70`. Protected by JWT `creditGate` and rate limiter. |
| `/api/photo-to-depth` | POST | Multipart `photo` file, optional `aspectRatio`, optional `depth_intensity`, optional `style_preset`, optional `batch` | `{"status": "success", "image_url": "...", "images": [...], "batch": false, "subject": "..."}` | Analyzes photo and generates depth map with requested aspect ratio and depth intensity (default 70). Protected by JWT `creditGate` and rate limiter. |
| `/api/jobs/:id` | GET | `:id` URL param | `{"job_id": "...", "status": "completed", "result_url": "..."}` | Polls status and result URL of a background generation job in BullMQ (`queued`, `processing`, `completed`, `failed`). |
| `/api/postprocess` | POST | `{"image_url": "..."}` | `{"status": "success", "image_url": "/static/generated/forge_xxx.png"}` | Synchronously smooths depth map via 5-step Python processor pipeline. Serialized through PQueue. |
| `/api/postprocess-stream` | GET / POST | `?image_url=...` | `text/event-stream` | Streams 5-step smoothing progress in real-time over Server-Sent Events (SSE). |
| `/api/invert` | POST | `{"image_url": "..."}` | `{"status": "success", "image_url": "/static/generated/inv_xxx.png"}` | Inverts depth map pixel values (16-bit or 8-bit) via serialized Python processor. |
| `/api/remove_bg` | POST | `{"image_url": "..."}` | `{"status": "success", "image_url": "/static/generated/iso_xxx.png"}` | Isolates subject onto pure black background using rembg U2Net model. |
| `/api/auth/signup` | POST | `{"email": "...", "password": "..."}` | `{"status": "success", "token": "...", "user": {...}}` | Registers a new account with 10 starter credits (first user or `ADMIN_EMAIL` receives `admin` role). |
| `/api/auth/login` | POST | `{"email": "...", "password": "..."}` | `{"status": "success", "token": "...", "user": {...}}` | Authenticates user via `crypto.scrypt` and returns a 7-day `HS256` JWT token. |
| `/api/auth/guest` | POST | `{"email": "..."}` (optional) | `{"status": "success", "token": "...", "user": {...}}` | Provisions or refreshes a Studio session token for seamless `401` recovery in `/app`. |
| `/api/auth/me` | GET | Header `Authorization: Bearer <token>` | `{"user": {...}}` | Returns the currently authenticated user's profile, role, and credit balance. |
| `/api/user/dashboard` | GET | Header `Authorization: Bearer <token>` | `{"user": {...}, "credits_balance": 10, "generations": [...]}` | Returns user profile, live credit balance, and up to 50 recent depth map generations. |
| `/api/wallet/balance` | GET | Header `Authorization: Bearer <token>` | `{"userId": "...", "balance": 10, "credits_balance": 10}` | Returns live credit balance for the Studio header badge and User Dashboard. |
| `/api/wallet/checkout` | POST | `{"packageId": "basic" \| "shop"}` | `{"url": "..."}` | Creates a Stripe Checkout session (when configured) or redirects to `/pricing`. |
| `/api/admin/stats` | GET | Header `Authorization: Bearer <admin_token>` | `{"totalUsers": 12, "outstandingCredits": 120, "totalGenerations": 45}` | Admin-only platform KPI metrics for the `/admin` console. |
| `/api/admin/users` | GET | `?search=...&limit=100` | `{"users": [...]}` | Admin-only searchable user directory with roles and credit balances. |
| `/api/admin/credits` | POST | `{"userId": "...", "amount": 10}` | `{"status": "success", "user": {...}}` | Admin-only credit grant or deduction (`+10`, `-1`, or custom delta). |
| `/api/admin/role` | POST | `{"userId": "...", "role": "admin" \| "user"}` | `{"status": "success", "user": {...}}` | Admin-only role promotion or demotion. |
| `/api/laser/lightburn/presets` | GET | None | `{"status": "ok", "presets": {...}}` | Returns calibrated LightBurn material engraving presets (Hardwood, Acrylic, Fiber/Slate, Softwood). |
| `/api/laser/lightburn/export` | POST / GET | `{"image_url": "...", "preset": "hardwood", "widthMm": 100, "heightMm": 100}` | `{"status": "success", "lbrn2_url": "..."}` or XML download | Generates native LightBurn `.lbrn2` project file with embedded 16-bit depth map and grayscale power/speed settings. |
| `/api/laser/lightburn/queue` | GET / POST | `{"studentName": "...", "image_url": "...", "preset": "..."}` | `{"status": "success", "queue": [...]}` | Laser operator queue for CNC carving jobs from Web Studio and Android App. |
| `/api/laser/lightburn/queue/:id/status` | POST | `{"status": "engraving" \| "completed"}` | `{"status": "success", "job": {...}}` | Updates laser job progress status for the CNC operator console. |
| `/api/ecosystem/info` | GET | None (CORS enabled for `SLCreations.llc`) | `{"status": "ok", "company": "SLCreations, LLC", "partner": {...}}` | Cross-site ecosystem metadata for SLCreations, LLC integration. |
| `/api/contact` | POST | `{"name": "...", "email": "...", "category": "...", "message": "..."}` | `{"status": "success", "inquiryId": "..."}` | Records enterprise, support, and SLCreations.llc physical fabrication inquiries. |
| `/api/webhooks/stripe` | POST | Raw Stripe event payload | `{"received": true}` | Verifies Stripe webhook signatures and credits user wallets on `checkout.session.completed`. |

---

## Post-Processing Pipeline

The Python processor (`processor.py`) applies a 5-stage pipeline:

1. **STEP 1 — Load & Convert to Float32 Grayscale**: Loads 8-bit or 16-bit image into normalized `[0, 1]` float32 grayscale
2. **STEP 2 — Fill Holes (Inpainting)**: Detects and fills zero-value holes inside the foreground mask using morphological dilation + Telea inpainting
3. **STEP 3 — Spatial Filtering (Smooth Gradients)**: `cv2.bilateralFilter(d=9, sigmaColor=5000, sigmaSpace=5)` + minor Gaussian blur — removes banding while preserving crisp edges
4. **STEP 4 — Normalize the Depth Range**: Linear stretch to full `[0, 1]` range for maximum Z-axis depth utilization
5. **STEP 5 — Export as Lossless 16-Bit PNG**: Quantizes to `uint16` (`0–65535`) and writes 16-bit PNG with compression level 9

---

## Android App

The Android app (`android_app/`) is a native Jetpack Compose application providing the same forge experience on mobile:

- **Share Sheet**: Native Android system share sheet integration (`Intent.ACTION_SEND`, `type = "image/png"`) sharing depth maps with external apps via secure Android FileProvider (`cacheDir/share/`).
- **Session Gallery**: Horizontal scrollable thumbnail strip (`LazyRow`) displaying all session variations with one-tap restore and Hide/Show/Clear controls.
- **3D Preview WebView**: Fullscreen dialog hosting an embedded WebGL Three.js displacement engine in a native WebView, featuring orbit drag controls, pinch zoom, and lighting.
- **Aspect Ratio Selector**: Selectable chip controls (`1:1`, `4:3`, `3:2`, `16:9`, `2:3`) for custom dimensions in text prompt and photo modes.
- **Depth Intensity Slider**: Native Material 2 `Slider` (0–100%, default 70%) adjusting relief contrast and carving depth dynamically.
- **Style Presets**: Interactive chip selector for domain preambles (`Portrait`, `Wildlife`, `Ornamental`, `Floral`, `Architecture`, `Abstract`).
- **Batch Candidate Grid**: 2-column candidate grid (`BatchCandidateGrid`) displaying 4 generated variations simultaneously with candidate badges (`#1`–`#4`), selection borders, and one-tap preview assignment.
- **Side-by-Side Comparison View**: Split-screen comparison view (`BeforeAfterComparisonView`) with a draggable vertical divider slider and high-contrast badges.
- **Real-Time SSE Pipeline Animation**: Real-time progress bar and step indicators driven by live Server-Sent Events from `/api/postprocess-stream`.
- **Health Check & Service Status**: Automated backend health checks via `ApiClient.checkHealth()` and `ApiClient.isHealthy()`.
- **Configurable Server URL**: Settings dialog allowing dynamic updates to the backend URL for local or LAN-based development.

---

## Project Directory Tree Structure

```
DepthForge/
├── server.js                          # Express API server, Phase 4 routes, rate limiting, and PQueue runner
├── worker.js                          # BullMQ background worker for async Gemini/Imagen generation
├── cleanup.js                         # Automated TTL cleanup routine & background scheduler
├── credit-backend.js                  # Credit reservation, deduction, and ledger client
├── processor.py                       # OpenCV 16-bit post-processing pipeline & rembg integration
├── LICENSE                            # Proprietary Copyright © 2026 SLCreations, LLC. All Rights Reserved.
├── package.json                       # Node.js project manifest & script declarations
├── package-lock.json                  # Deterministic Node dependency lockfile
├── Dockerfile                         # Container definition with Node 20, Python 3, OpenCV, and rembg
├── docker-compose.yaml                # Multi-container VPS deployment definition (app, worker, redis)
├── lib/                               # Core platform modules & hardware adapters
│   └── lightburn.js                   # LightBurn (.lbrn2) XML project generator & laser operator queue
├── db/                                # Dual PostgreSQL / SQLite user, credit wallet & generation store
│   ├── init.js                        # Legacy SQLite wallet schema & helpers
│   └── store.js                       # Phase 4 unified user auth, RBAC, credit ledger & stats store
├── middleware/                        # Express authentication and request guards
│   └── auth.js                        # JWT verification (with fallback support), creditGate, requireAuth, requireAdmin
├── blender_plugin/                    # Blender add-on for direct 3D displacement mesh import
├── scripts/                           # VPS deployment, provisioning, and maintenance scripts
├── supabase/migrations/               # PostgreSQL schema and credit RPC migrations
├── systemd/                           # Linux systemd unit files for DepthForge service management
├── static/                            # Web frontend & SLCreations, LLC corporate site assets
│   ├── spatialops.css                 # Direction A Industrial Precision CAD/CAM design system
│   ├── landing.html                   # SLCreations, LLC corporate home page (/)
│   ├── solutions.html                 # CNC, Laser, 3D Printing & fabrication solutions (/solutions)
│   ├── pricing.html                   # Starter, Pro Maker & Shop Floor credit plans (/pricing)
│   ├── about.html                     # SLCreations, LLC company profile & contact form (/about)
│   ├── terms.html                     # Proprietary terms of service & privacy policy (/terms, /privacy)
│   ├── login.html                     # Self-hosted Sign In & Create Account UI (/login, /signup)
│   ├── dashboard.html                 # User Dashboard: credit wallet & depth map history (/dashboard)
│   ├── admin.html                     # Admin Console: platform KPIs, user search, credits & laser queue (/admin)
│   ├── auth.js                        # Client-side JWT session manager
│   ├── mesh-exporter.js               # Binary STL & Wavefront OBJ watertight 3D mesh generator
│   ├── index.html                     # DepthForge Studio UI (/app & /app?mode=photo)
│   └── style.css                      # Forge Studio dark-theme responsive stylesheet
├── tests/                             # Node.js native test runner test suites
│   ├── aspect_ratio.test.js           # F1: Aspect ratio selector tests
│   ├── invert.test.js                 # F2: Pixel inversion tests
│   ├── prompt_history.test.js         # F3: Prompt history persistence tests
│   ├── sse_pipeline.test.js           # F4: Server-Sent Events streaming tests
│   ├── session_gallery.test.js        # F5: Session gallery thumbnail tests
│   ├── depth_intensity.test.js        # F6: Depth intensity slider tests
│   ├── comparison_view.test.js        # F7: Side-by-side comparison slider tests
│   ├── cleanup.test.js                # F8: File TTL cleanup scheduler tests
│   ├── health.test.js                 # F9: Health check endpoint tests
│   ├── rate_limit.test.js             # F10: Rate limiting & HTTP 429 tests
│   ├── three_d_preview.test.js        # F11: Three.js 3D live preview tests
│   ├── style_presets.test.js          # F12: Style presets prompt injection tests
│   ├── batch_generation.test.js       # F13: Batch generation ×4 tests
│   ├── env_validation.test.js         # F14: Startup environment validation tests
│   ├── gemini_response_robustness.test.js # F15: Gemini JSON response robustness tests
│   ├── multer_uuid.test.js            # F16: Multer UUID filename preservation tests
│   ├── processor_steps.test.js        # F17: processor.py step comment alignment tests
│   ├── python_queue.test.js           # F18: Python processor concurrency queue tests
│   ├── android_share.test.js          # F19: Android Share Intent & FileProvider tests
│   ├── readme_verification.test.js    # F20: README documentation verification tests
│   ├── phase4_auth_dashboard.test.js  # Phase 4: Web site, Auth, Dashboard & Admin tests
│   └── lightburn_api.test.js          # LightBurn: .lbrn2 XML export & laser operator queue tests
└── android_app/                       # Native Android application
    ├── README.md                      # Android app architecture & setup guide
    └── app/
        └── src/
            ├── main/
            │   ├── AndroidManifest.xml# Manifest with FileProvider and network permissions
            │   ├── assets/            # Mirrored web assets for 3D WebView integration
            │   │   ├── index.html
            │   │   └── style.css
            │   ├── res/xml/
            │   │   └── file_paths.xml # FileProvider cache sharing paths
            │   └── kotlin/com/depthforge/app/
            │       ├── MainActivity.kt# Jetpack Compose UI, ForgeScreen & ShareSheet
            │       └── ApiClient.kt   # OkHttp3 HTTP/SSE client & Health API
            └── test/kotlin/com/depthforge/app/
                ├── AspectRatioTest.kt
                ├── BatchGenerationTest.kt
                ├── ComparisonViewTest.kt
                ├── HealthCheckTest.kt
                ├── InvertTest.kt
                ├── PromptHistoryTest.kt
                ├── RateLimitingTest.kt
                ├── SessionGalleryTest.kt
                ├── StylePresetsTest.kt
                └── ThreeDPreviewTest.kt
```

---

## License

**Copyright © 2026 SLCreations, LLC. All Rights Reserved.**

This software and all associated source code, documentation, and assets are proprietary and confidential to SLCreations, LLC. Unauthorized copying, distribution, modification, or use of any part of this repository without prior written permission is strictly prohibited. See [LICENSE](./LICENSE) for details.