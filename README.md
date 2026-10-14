<div align="center">
  <h1>⚡ DepthForge</h1>
  <p><strong>AI-Powered 16-bit 3D Relief & Depth Map Generator for CNC Laser Engraving</strong></p>

  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python" />
  <img src="https://img.shields.io/badge/Kotlin-Jetpack%20Compose-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white" alt="Kotlin" />
</div>

<hr />

This repository is deployed on a VPS; Vercel config has been removed.

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
- **`processor.py` Step Order & Structure (F17)**: Fully aligned, sequential step comments (STEP 1 through STEP 5) matching actual execution and SSE streaming stages: Load/16-bit conversion → Inpainting missing data → Bilateral spatial filtering → Depth normalization → Lossless 16-bit export.
- **Concurrency Queue for Python Processor (F18)**: Serializes resource-intensive Python subprocess calls (`runPythonProcessor` for Polish, Invert, Remove BG) through an in-memory `PQueue` with `concurrency: 1`. Prevents competing CPU/memory spikes and logs queue depth when tasks are queued behind an active operation.
- **Android Share Intent (F19)**: Native Android sharing via system share sheet (`Intent.ACTION_SEND`, `type = "image/png"`). Shares generated, polished, inverted, and background-removed depth maps using a secure Android FileProvider (`cacheDir/share/depth_share_<timestamp>.png`) with `FLAG_GRANT_READ_URI_PERMISSION`.
- **Comprehensive README Documentation Update (F20)**: Comprehensive, synchronized project documentation across Web, Node.js Express server, Python OpenCV pipeline, and native Jetpack Compose Android app. Fully documents all features (F1 through F20), REST and SSE API endpoints, prerequisites, installation workflows, environment variables, dependencies, and project directory structure with automated test suite verification (`tests/readme_verification.test.js`).
- **Background Removal**: Isolate subjects onto pure black backgrounds with `rembg`
- **Lossless Export**: Export production-ready 16-bit PNG depth maps
- **Modern Luxury Forge Aesthetic**: Custom 3D volcanic obsidian & molten laser gold branding, frosted glassmorphism interface (`backdrop-filter: blur(16px)`), specular border highlights, responsive blueprint grid preview canvas, glowing range sliders, animated status badges, and enhanced interactive states across Web and Android WebView mirroring.
- **Stripe Webhook Integration**: Listens for `checkout.session.completed` events to automatically update user credit balances in the SQLite ledger.

### Testing Stripe Webhooks Locally

You can test the Stripe webhook integration locally using the Stripe CLI:

1. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli).
2. Log in to your Stripe account:
   ```bash
   stripe login
   ```
3. Forward webhook events to your local server:
   ```bash
   stripe listen --forward-to localhost:8000/api/webhooks/stripe
   ```
4. Note the webhook signing secret printed in the console and add it to your `.env` file:
   ```env
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. Trigger a mock `checkout.session.completed` event:
   ```bash
   stripe trigger checkout.session.completed --add checkout_session:metadata.user_id=test_user_123 --add checkout_session:metadata.credits=50
   ```

### Platforms

- **Web**: Single-page static frontend served from Express (`static/index.html`, `static/style.css`) with built-in aspect ratio selector, depth intensity slider, prompt history, session gallery, side-by-side comparison view, 3D live preview displacement mesh, real-time SSE progress, luxury glassmorphic design system, and action controls
- **Android**: Native Jetpack Compose app (`android_app/`) (single-screen forge with native chips, depth intensity slider, prompt history dropdown, session gallery LazyRow, before/after comparison split view with draggable divider, 3D preview dialog, real-time SSE animation, Android Share Sheet integration, mirrored high-tech WebView assets, and action controls)

---

## Architecture

```
┌─────────────────────────────────────────┐       ┌─────────────────────────────────────────┐
│  Web Browser                            │       │  Android App (Kotlin & Jetpack Compose) │
│  static/index.html & static/style.css   │       │  ForgeScreen & ApiClient                │
└────────────────────┬────────────────────┘       └────────────────────┬────────────────────┘
                     │ HTTP / REST / SSE                               │ HTTP / REST / SSE
                     ▼                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│  Express Server (server.js)  — Port 8000                                                  │
│                                                                                           │
│  GET  /api/health              → Health status, package.json version & Python engine check│
│  POST /api/generate            → Gemini prompt expansion + Imagen 4 (rate limited)        │
│  POST /api/photo-to-depth      → Gemini Vision spatial analysis + Imagen 4 (rate limited) │
│  POST /api/postprocess         → Serialized Python processor smooth (PQueue concurrency:1)│
│  GET  /api/postprocess-stream  → Serialized Python processor smooth with live SSE events  │
│  POST /api/invert              → Serialized Python processor invert (PQueue concurrency:1)│
│  POST /api/remove_bg           → Serialized Python processor remove_bg (rembg ML)         │
│  Scheduled Task (cleanup.js)   → Automated hourly TTL cleanup of static/generated/        │
└─────────────────────────────────────────────┬────────────────────────────────────────