import sys
import os
import json
import cv2
import numpy as np


def _env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def detect_src_bits(raw_img):
    """Return (src_bits, max_val). 16-bit files that only hold multiples of 257
    (8-bit data widened by x257) are reported as 8-bit."""
    if raw_img.dtype == np.uint8:
        return 8, 255.0
    if raw_img.dtype == np.uint16:
        if np.all(raw_img % 257 == 0):
            return 8, 65535.0
        return 16, 65535.0
    if np.issubdtype(raw_img.dtype, np.integer):
        info = np.iinfo(raw_img.dtype)
        max_val = float(info.max)
        return (16 if max_val > 255 else 8), max_val
    return 16, 1.0


def deband_float(depth, src_bits, tol_levels=None, sigma=None, iterations=None):
    """Remove terracing from quantized depth data.

    Repeatedly blurs the image, then clamps every pixel to within +/- tol of the
    input. The true surface lies within about half a quantization step of the
    stored value, so the result is smooth on gentle slopes while real edges
    (jumps larger than the tolerance) cannot move and stay sharp.
    """
    tol_levels = _env_float("DEPTH_DEBAND_TOL_LEVELS", 1.0) if tol_levels is None else tol_levels
    sigma = _env_float("DEPTH_DEBAND_SIGMA", 4.0) if sigma is None else sigma
    iterations = int(_env_float("DEPTH_DEBAND_ITERS", 20)) if iterations is None else int(iterations)
    if iterations <= 0 or tol_levels <= 0:
        return depth
    level = 1.0 / (255.0 if src_bits == 8 else 65535.0)
    tol = tol_levels * level
    lo = depth - tol
    hi = depth + tol
    x = depth.astype(np.float32)
    for _ in range(iterations):
        x = cv2.GaussianBlur(x, (0, 0), sigma)
        x = np.minimum(np.maximum(x, lo), hi)
    return np.clip(x, 0.0, 1.0).astype(np.float32)


def to_uint16(depth, dither_amplitude=None, seed=0):
    amp = _env_float("DEPTH_DITHER_AMPLITUDE", 0.5 / 65535.0) if dither_amplitude is None else dither_amplitude
    if amp > 0:
        rng = np.random.default_rng(seed)
        depth = depth + rng.normal(0.0, amp, depth.shape).astype(np.float32)
    return np.round(np.clip(depth, 0.0, 1.0) * 65535.0).astype(np.uint16)


def quality(out16):
    unique = int(len(np.unique(out16)))
    fake = unique <= 256 or bool(np.all(out16 % 257 == 0))
    return {"unique_levels": unique, "is_fake_16bit": fake}


def finish_depth(float_depth, src_bits, report=True):
    """STEPS 3-5 on a float32 [0, 1] depth array. Returns uint16 image."""
    # ==========================================
    # STEP 3: SPATIAL FILTERING (SMOOTH GRADIENTS)
    # ==========================================
    if report:
        print("[STEP 3/5] Applying bilateral spatial filtering to smooth while preserving edges...", flush=True)

    # Scale float32 [0, 1] to [0, 65535] for bilateral filter
    # (bilateralFilter works on intensity; scaling makes sigmaColor easier to reason about)
    scaled_depth = float_depth * 65535.0

    # Bilateral filter: d=9 (pixel neighborhood), sigmaColor=5000 (intensity variation),
    # sigmaSpace=5 (coordinate space). This smooths gradients while preserving edges.
    filtered_scaled = cv2.bilateralFilter(scaled_depth, d=9, sigmaColor=5000.0, sigmaSpace=5.0)

    # Optional minor Gaussian blur to smooth any micro-textures
    if report:
        print("Applying Gaussian blur to smooth micro-textures...", flush=True)
    filtered_scaled = cv2.GaussianBlur(filtered_scaled, (3, 3), 0)

    # Scale back to [0, 1]
    filtered_float = filtered_scaled / 65535.0

    # Quantization-aware de-banding: removes the stair steps left by 8-bit sources
    if report:
        print("Removing quantization terracing (edge-safe de-banding)...", flush=True)
    filtered_float = deband_float(filtered_float, src_bits)

    # ==========================================
    # STEP 4: NORMALIZE THE DEPTH RANGE
    # ==========================================
    if report:
        print("[STEP 4/5] Normalizing depth values to full 16-bit range...", flush=True)

    # Find the lowest and highest values in the filtered image
    min_val = np.min(filtered_float)
    max_val = np.max(filtered_float)

    # Stretch the values to fill the full [0, 1] range
    if max_val > min_val:
        normalized_float = (filtered_float - min_val) / (max_val - min_val)
    else:
        normalized_float = filtered_float

    # ==========================================
    # STEP 5: QUANTIZE (ROUND + DITHER)
    # ==========================================
    return to_uint16(normalized_float)


def smooth_image(input_path, output_path):
    # ==========================================
    # STEP 1: LOAD & CONVERT TO FLOAT32 GRAYSCALE
    # ==========================================
    print("[STEP 1/5] Loading image and converting to grayscale...", flush=True)
    raw_img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)

    if raw_img is None:
        print(f"Error: Could not load {input_path}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Convert to single-channel grayscale if needed
    if len(raw_img.shape) == 3:
        if raw_img.shape[2] == 3:
            raw_img = cv2.cvtColor(raw_img, cv2.COLOR_BGR2GRAY)
        elif raw_img.shape[2] == 4:
            raw_img = cv2.cvtColor(raw_img, cv2.COLOR_BGRA2GRAY)

    # Record the source bit depth (16-bit files that are really x257 8-bit count as 8-bit)
    src_bits, max_val = detect_src_bits(raw_img)

    # Convert to float32 in [0, 1]
    float_depth = raw_img.astype(np.float32) / max_val

    # ==========================================
    # STEP 2: FILL HOLES (INPAINTING)
    # ==========================================
    print("[STEP 2/5] Identifying and cleaning up missing data (inpainting)...", flush=True)

    # Build a mask of the foreground region (any non-zero pixel is subject matter).
    # We only want to inpaint holes *within* the subject, not the intentional
    # pure-black background. Dilate the foreground to establish its bounding region,
    # then find pixels that are zero *inside* that region — those are the real holes.
    fg_mask = (float_depth > 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    fg_dilated = cv2.dilate(fg_mask, kernel, iterations=3)
    # Holes are pixels that are zero AND inside the dilated foreground region
    missing_mask = ((float_depth == 0) & (fg_dilated > 0)).astype(np.uint8)

    if np.any(missing_mask):
        print("Large missing data holes detected; applying telea inpainting...", flush=True)
        # Convert float to temporary uint8 for inpainting
        tmp_8bit = (float_depth * 255.0).astype(np.uint8)
        inpainted_8bit = cv2.inpaint(tmp_8bit, missing_mask, inpaintRadius=3, flags=cv2.INPAINT_TELEA)
        # Copy only the filled hole pixels back into the float array
        filled_mask = missing_mask > 0
        float_depth[filled_mask] = inpainted_8bit[filled_mask].astype(np.float32) / 255.0

    final_16bit = finish_depth(float_depth, src_bits)

    # ==========================================
    # STEP 5: EXPORT AS LOSSLESS 16-BIT PNG
    # ==========================================
    print(f"[STEP 5/5] Exporting processed 16-bit PNG to {output_path}...", flush=True)

    # Explicitly use compression parameters for maximum file safety
    cv2.imwrite(output_path, final_16bit, [cv2.IMWRITE_PNG_COMPRESSION, 9])

    q = quality(final_16bit)
    q["src_bits"] = src_bits
    print("[QUALITY] " + json.dumps(q), flush=True)


def remove_bg(input_path, output_path):
    print(f"Removing background from {input_path}...", flush=True)
    import rembg
    img_8bit = cv2.imread(input_path, cv2.IMREAD_COLOR)

    if img_8bit is None:
        print(f"Error: Could not load {input_path}", file=sys.stderr, flush=True)
        sys.exit(1)

    # Apply rembg
    # rembg expects RGB or BGR image, returns RGBA
    isolated_rgba = rembg.remove(img_8bit)

    # Extract alpha channel
    alpha = isolated_rgba[:, :, 3]

    # Create pure black background
    black_bg = np.zeros_like(img_8bit)

    # Composite the foreground onto the black background
    # Normalize alpha to 0.0 - 1.0
    alpha_float = alpha.astype(np.float32) / 255.0

    # Multiply foreground by alpha and background by (1 - alpha)
    # Since background is 0, we just multiply foreground by alpha
    for c in range(3):
        black_bg[:, :, c] = (isolated_rgba[:, :, c].astype(np.float32) * alpha_float).astype(np.uint8)

    print(f"Exporting background-removed PNG to {output_path}...", flush=True)
    cv2.imwrite(output_path, black_bg)

def invert_image(input_path, output_path):
    print(f"Inverting depth map from {input_path}...", flush=True)
    img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)

    if img is None:
        print(f"Error: Could not load {input_path}", file=sys.stderr, flush=True)
        sys.exit(1)

    if img.dtype == np.uint16:
        # Invert 16-bit depth map: 65535 - pixel
        if len(img.shape) == 3 and img.shape[2] == 4:
            inverted = img.copy()
            inverted[:, :, :3] = (65535 - img[:, :, :3].astype(np.uint32)).astype(np.uint16)
        else:
            inverted = (65535 - img.astype(np.uint32)).astype(np.uint16)
        cv2.imwrite(output_path, inverted, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    elif img.dtype == np.uint8:
        # Invert 8-bit depth map: 255 - pixel
        if len(img.shape) == 3 and img.shape[2] == 4:
            inverted = img.copy()
            inverted[:, :, :3] = (255 - img[:, :, :3].astype(np.uint16)).astype(np.uint8)
        else:
            inverted = (255 - img.astype(np.uint16)).astype(np.uint8)
        cv2.imwrite(output_path, inverted)
    else:
        # Fallback for other dtypes
        max_val = np.iinfo(img.dtype).max if np.issubdtype(img.dtype, np.integer) else 1.0
        if len(img.shape) == 3 and img.shape[2] == 4:
            inverted = img.copy()
            inverted[:, :, :3] = (max_val - img[:, :, :3]).astype(img.dtype)
        else:
            inverted = (max_val - img).astype(img.dtype)
        cv2.imwrite(output_path, inverted)

    print(f"Exporting inverted depth map to {output_path}...", flush=True)

def create_mesh(input_path, output_path):
    print("Error: 3D mesh generation is not yet implemented.", file=sys.stderr, flush=True)
    print("To enable this, install 'trimesh' and implement displacement mesh generation here.", file=sys.stderr, flush=True)
    sys.exit(1)

def main():
    if len(sys.argv) < 4:
        print("Usage: python processor.py <command> <input_path> <output_path>", file=sys.stderr, flush=True)
        sys.exit(1)

    command = sys.argv[1]
    input_path = sys.argv[2]
    output_path = sys.argv[3]

    if command == "smooth":
        smooth_image(input_path, output_path)
    elif command == "remove_bg":
        remove_bg(input_path, output_path)
    elif command == "invert":
        invert_image(input_path, output_path)
    elif command == "mesh":
        create_mesh(input_path, output_path)
    else:
        print(f"Unknown command: {command}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
