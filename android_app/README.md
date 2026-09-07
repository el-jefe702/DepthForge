# Native Android App (Kotlin & Jetpack Compose)

This directory contains the native Android application for **DepthForge**. Built with Jetpack Compose, it features a complete user interface and direct backend API connections.

## 🌟 Key Features

* **Landing Page & Lead Form:** Visual entry screen showing the brand logo. Includes a popup mailing list registration form (Full Name, Email, Premium Interest checkbox) that records entries via `/api/lead` and skips prompting on subsequent app launches.
* **The Forge (Depth-Map Generator):** 
  * Generates 16-bit depth maps using prompt entries via the cloud `/api/generate` route.
  * **Prompt History:** Automatically persists the last 10 successful prompts in `SharedPreferences` (`depthforge_prompt_history`), rendered as clickable items with clear history support.
  * **Aspect Ratio Selector:** Native selectable chips (`1:1`, `4:3`, `3:2`, `16:9`, `2:3`) for custom aspect ratios in both text prompt and photo upload modes.
  * **Depth Intensity Slider (F6):** Native `Slider` control (0–100%, default 70%) adjusting carve relief depth and contrast in both Text and Photo modes. Dynamically displays the live percentage indicator (`Depth Intensity: 70%`), disables during active processing via `!isBusy`, and propagates `depth_intensity` / `depthIntensity` via `ApiClient.generate` and `ApiClient.photoToDepth`.
  * **Before/After Comparison View (F7):** Interactive split-screen comparison mode (`BeforeAfterComparisonView`) with a horizontal draggable vertical divider slider, Before (Orange) and After (Indigo) badges with dynamic alpha edge-fading, and close button. Seamlessly toggled via the "Compare" / "Normal" action button whenever a post-processing operation (Invert, Remove BG, Polish) completes, with native `BackHandler` integration allowing system back gestures/buttons to dismiss comparison mode cleanly.
  * **Invert Depth Map:** Direct action button to invert depth maps via `/api/invert`.
  * **Session Gallery (History Panel):** Horizontal scrollable thumbnail strip (`LazyRow`) showing all images generated and processed in the current session. Clicking any thumbnail restores that map to the preview with active post-processing controls. Includes Hide/Show toggle and Clear controls, guarded by `!isBusy` across all interactions.
  * **Post-Processing Pipeline (Real-Time SSE Streaming):** Real-time visual sequence demonstrating the bilateral filtering, inpainting, scaling, normalization, and export stages streaming live over Server-Sent Events (`/api/postprocess-stream`) with zero fake delay loops.
  * **Admin Queue Submission:** Prompts for student name and exports the LightBurn project file to `/api/laser/lightburn` on the server.
  * **Direct Spindle Control:** Strict safety check dialog verifying laser pathway clear and exhaust active. Authenticated with typed `CONFIRM` verification. It initiates the Ruida mock sequence and streams status updates over WebSockets (`/ws`) or fallback HTTP status polling.
* **Support AI:** Direct chat connection with the SLCreations studio assistant (via `/api/chat`), with unique local session persistence.
* **Admin Dashboard:** Access to the Student Queue (with direct "Open in LightBurn" triggers) and Login Leads tracker.
* **Dynamic Connection Settings:** Tap the **Settings (Gear)** icon in the top-right corner of any screen to quickly adjust the API Base URL.
* **Health Check & Service Status:** Remote backend health verification via `ApiClient.checkHealth()` and `ApiClient.isHealthy()`, querying `GET /api/health` with automatic status parsing, dynamic semver reporting, Python engine validation, strict HTTP success checks, safe base URL trimming, and safe error handling that preserves HTTP status codes on non-JSON error pages and catches malformed URLs cleanly.
* **Rate Limiting & 429 Error Handling (F10):** Robust error handling across text prompt generation and photo conversion. When backend returns HTTP 429 Too Many Requests (`ApiClient.isRateLimited()`), the exact error message (`"Too many requests. Please wait before generating again."`) is parsed from the error stream and displayed to the user via native Snackbar notifications and visible error state, preventing silent or generic failures.
* **3D Live Preview (F11):** Interactive WebGL 3D displacement preview powered by Three.js, embedded via a fullscreen `WebView` dialog in Jetpack Compose. Loads the bundled `index.html` asset containing the complete Three.js displacement engine, automatically injects JavaScript to set the current depth map image and enter 3D preview mode on open. Features interactive orbit controls (drag to rotate), pinch/scroll zoom, directional lighting for relief shadow accentuation, camera reset, and a styled close button with `BackHandler` integration for clean dismissal. The `WebView` enables JavaScript, DOM storage, and file access for full WebGL rendering of the 256×256 vertex displacement mesh.
* **Style Presets (F12):** Interactive chip selector (`StylePresetSelector`) allowing users to bias generation towards specific carving styles (`Portrait`, `Wildlife`, `Ornamental`, `Floral`, `Architecture`, `Abstract`). Tapping a chip toggles selection on/off, cleanly propagating `style_preset` through `ApiClient.generate` and `ApiClient.photoToDepth` without clobbering custom prompt text.

---

## 🚀 Getting Started

### 1. Open the Project
Open the `android_app/` folder directly in **Android Studio**.

### 2. Sync and Build
Let Gradle sync project dependencies, and build the `app` configuration.

### 3. Setup Connection Address
* **Android Emulator:** The emulator automatically routes localhost of your computer to `http://10.0.2.2:8000/`. This is the default.
* **Physical Device:** Ensure your phone is connected to the same Wi-Fi network as your host machine. Tap the gear icon in the top-right corner of the app's landing screen and enter your computer's LAN IP address (e.g. `http://192.168.1.100:8000/`).

---

## 🛠️ Tech Stack & Dependencies
* **Core:** Kotlin & Jetpack Compose (Material 2 Theme)
* **Networking & Parsing:** OkHttp3 & Gson (using coroutines for asynchronous calls)
* **Status Updates:** WebSocket connections for Ruida job updates, with regular HTTP polling fallbacks.
* **Testing:** JUnit unit tests (`ComparisonViewTest`, `SessionGalleryTest`, `PromptHistoryTest`, `AspectRatioTest`, `InvertTest`, `HealthCheckTest`, `RateLimitingTest`, `ThreeDPreviewTest`) covering core math, state managers, WebView integration, and contracts.
