# DepthForge

AI-assisted grayscale relief and depth-map generation for CNC carving and laser engraving, with a web interface and native Android client.

## Overview

DepthForge combines Google Gemini prompt enhancement and image generation with Python/OpenCV post-processing. Polishing exports 16-bit PNG height maps. AI-generated shading is an artistic approximation of relief, not a calibrated measurement of physical depth; inspect the result before machining.

## Deployment architecture

The deployment target is a VPS running the Express server, either directly or through Docker Compose. Browser and Android clients use the same REST/SSE API. Python processing runs on the server.

Vercel deployment configuration and its serverless wrapper have been removed in this branch. Legacy Vercel detection remains in server.js pending cleanup; do not set VERCEL or VERCEL_ENV on the VPS.

## Core Features

- Text-to-Depth: generate grayscale relief imagery from a prompt.
- Photo-to-Depth: analyze an uploaded photo and generate matching relief imagery.
- Aspect Ratio Selector (F1): 1:1, 4:3, 3:2, 16:9, and 2:3.
- Invert Depth Map (F2): invert 16-bit or 8-bit pixel values.
- Prompt History (F3): browser localStorage and Android SharedPreferences.
- Real-Time Pipeline Progress via SSE (F4): five-stage processing feedback.
- Session Gallery / History Panel (F5): select prior session images and processed variants.
- Depth Intensity Slider (F6): prompt-based relief contrast control from 0 to 100.
- Side-by-Side Comparison View (F7): compare original and processed imagery.
- Automatic Generated File Cleanup (F8): scheduled cleanup of expired generated files.
- Health Check Endpoint (F9): service, version, uptime, and Python availability information.
- Rate Limiting (F10): configurable IP-based limits on generation routes.
- 3D Live Preview (F11): Three.js displacement preview in the browser.
- Style Presets (F12): Portrait, Wildlife, Ornamental, Floral, Architecture, Abstract.
- Batch Generation (F13): generate four candidate images.
- Environment Validation at Startup (F14): environment validation helpers and diagnostics.
- Gemini Prompt Response Robustness (F15): JSON parsing and fallback handling.
- Multer UUID Filenames with Extension (F16): uniquely named image uploads.
- processor.py Step Order & Structure (F17): five-stage processing and progress labels.
- Concurrency Queue for Python Processor (F18): p-queue serialization for queued processing operations. The streaming route currently launches its subprocess directly; do not assume all processing is serialized.
- Android Share Intent (F19): share PNGs through Android FileProvider.
- Comprehensive README Documentation Update (F20): setup, deployment, API, and project reference.
- Background removal: rembg-based subject isolation.

## Local setup

### Prerequisites

The previous documentation specified Node.js 18+ and Python 3.10+. The Dockerfile uses Node.js 20; use a Node version supported by the installed dependencies rather than assuming Node 18 supports every package.

A Google API key with access to the configured generation models is required.

```bash
git clone https://github.com/el-jefe702/DepthForge.git
cd DepthForge
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Create .env only if it does not already exist. This command uses exclusive creation and will not overwrite existing secrets:

```bash
node --input-type=module -e 'import fs from "node:fs"; try { fs.writeFileSync(".env", "GEMINI_API_KEY=\nPORT=8000\n", {flag: "wx", mode: 0o600}); } catch (e) { if (e.code !== "EEXIST") throw e; console.log("Existing .env preserved"); }'
```

Edit .env and enter your key. Never commit it or paste it into an issue. Set PYTHON_EXEC to your virtual environment interpreter if needed.

```bash
npm start
# Development
npm run dev
# Tests
npm test
```

With PORT=8000, open http://localhost:8000.

## VPS deployment with Docker Compose

Keep the real .env on the VPS host, outside the image. This branch's Compose configuration forwards GEMINI_API_KEY and fixes the container port at 8080, exposed on host port 8000.

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 depthforge
curl --fail http://localhost:8000/api/health
```

Put a TLS reverse proxy in front of the service for public access. Restrict direct access to port 8000 according to your VPS firewall and proxy arrangement. Configure TRUST_PROXY to match the actual trusted proxy chain, rather than enabling unrestricted trust.

### Environment persistence changes in PR #3

PR #3 is separate from this branch. Once merged, it adds:

- .env.example as a secret-free template.
- Compose env_file loading from the host, with optional-file syntax requiring Docker Compose v2.24+.
- A named app_data volume at /app/data for the subscription database.
- Ignore rules for .env variants.

Do not assume these changes are present merely because this README was merged. The original Compose file only forwards selected variables; additional host .env settings are not automatically passed into the container.

With PR #3 merged, recreate the service after editing .env:

```bash
docker compose up -d --force-recreate depthforge
```

Image rebuilds do not update or delete a host-side .env. A new clone does not include secrets: restore the host file from your secure backup. Avoid overwrite commands such as echo ... > .env or unconditional copying of the template.

### Persistent data and backups

The generated_data volume stores /app/static/generated. Generated files remain subject to GENERATED_TTL_HOURS cleanup: persistence does not disable expiration. PR #3 adds app_data for /app/data. Uploads are not currently mounted on a persistent volume.

Keep secure backups of .env and persistent data. Do not run docker compose down -v unless you intend to delete named volumes. These changes do not recover secrets or data that were already lost.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| GEMINI_API_KEY | Required | Google generation API credential. |
| PORT | 8000 directly; 8080 in Compose | Express listening port. |
| PYTHON_EXEC | Auto-detected | Python interpreter override. Docker sets python3. |
| GENERATED_TTL_HOURS | 24 | Generated-file retention window. |
| RATE_LIMIT_WINDOW_MS | 900000 | Generation rate-limit window in milliseconds. |
| RATE_LIMIT_MAX | 10 | Requests per IP per window. |
| TRUST_PROXY | Disabled | Trusted proxy configuration for client IP handling. |
| SUBSCRIPTIONS_DB_PATH | ./data/subscriptions.db in PR #2 | SQLite location; PR #3 sets /app/data/subscriptions.db in Compose. |

## Dependencies

Node packages include @google/genai, express, express-rate-limit, multer, p-queue, uuid, and dotenv. Python processing uses opencv-python, numpy, and rembg; install requirements.txt for the declared dependency set.

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| /api/health | GET, HEAD, OPTIONS | Health, version, Python availability, uptime. |
| /api/generate | POST | Text generation; JSON prompt and optional aspectRatio, depth_intensity, style_preset, batch. |
| /api/photo-to-depth | POST | Multipart photo upload and optional generation settings. |
| /api/postprocess | POST | Polish the image identified by image_url. |
| /api/postprocess-stream | GET / POST | SSE progress for image_url. |
| /api/invert | POST | Invert the image identified by image_url. |
| /api/remove_bg | POST | Remove background from the image identified by image_url. |

Generation routes are rate limited. Image URLs are returned under /static/generated/. Inspect source and tests for full response contracts.

## Post-processing pipeline

The latest float32 pipeline replaces the previous 8-bit times-257 conversion:

1. Load the image into normalized float32 data.
2. Inpaint holes using a temporary uint8 representation and merge the results back.
3. Apply bilateral filtering and Gaussian smoothing while retaining floating-point data.
4. Normalize the depth range.
5. Quantize once to uint16 and export PNG.

Smoothing can interpolate between input levels but cannot recover true geometry missing from the source. Confirm toolpaths, scale, and relief depth in your CAM workflow.

## Android App

The native Jetpack Compose client includes Share Sheet, Session Gallery, 3D Preview WebView, Aspect Ratio controls, Depth Intensity, Style Presets, and a Batch Candidate Grid. Configure its server URL to your VPS endpoint. See android_app/README.md for client setup.

## Subscription database work in PR #2

PR #2 adds db/subscriptions.js with users, usage, subscriptions, initialization, and helper functions, plus better-sqlite3. This branch does not include that module.

The proposed free/pro/studio quotas are placeholders. The module is not wired into server.js, its lockfile update is outstanding, and tests have not been added. It does not yet provide production billing or quota enforcement.

## Project Directory Tree Structure

```text
DepthForge/
  server.js                         Express API and processing integration
  cleanup.js                        Generated-file cleanup scheduler
  processor.py                      Python/OpenCV processing
  package.json                      Node dependencies and scripts
  package-lock.json                 Node dependency lockfile
  requirements.txt                  Python dependencies
  Dockerfile                        Container build
  docker-compose.yaml               VPS service and generated-data volume
  static/                           Browser UI assets
  tests/                            Node test suites
    readme_verification.test.js      Documentation checks
    android_share.test.js           Android sharing checks
    python_queue.test.js            Queue checks
    processor_steps.test.js         Processing-step checks
  android_app/                      Native Android client
  blender_plugin/                   Blender integration
```

## Validation status

Documentation updates are not proof of a successful build or deployment. The recent database, environment persistence, and Vercel-removal changes have not been tested on the VPS in this work session. Run the test suite and deployment checks before release.

## License

See LICENSE. SLCreations, LLC, 2026.
