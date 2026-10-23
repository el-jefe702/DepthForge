import sys
import os
import cv2
import numpy as np

def safe_imwrite(output_path, img, params=None):
    """Ensures destination directory exists and validates write status."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    success = cv2.imwrite(output_path, img, params) if params is not None else cv2.imwrite(output_path, img)
    if not success:
        print(f"Error: Failed to write image to {output_path}", file=sys.stderr, flush=True)
        sys.exit(1)

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

    # Record the source bit depth
    if raw_img.dtype == np.uint8:
        src_bits = 8
        max_val = 255.0
    elif raw_img.dtype == np.uint16:
        src_bits = 16
        max_val = 65535.0
    else:
        # Handle other dtypes by converting to uint16 or uint8
        if np.issubdtype(raw_img.dtype, np.integer):
            info = np.iinfo(raw_img.dtype)
            max_val = float(info.max)
            src_bits = 16 if max_val > 255 else 8
        else:
            # Assume float in [0, 1]
            max_val = 1.0
            src_bits = 16

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

    # ==========================================
    # STEP 3: SPATIAL FILTERING (SMOOTH GRADIENTS)
    # ==========================================
    print("[STEP 3/5] Applying bilateral spatial filtering to smooth while preserving edges...", flush=True)
    
    # Scale float32 [0, 1] to [0, 65535] for bilateral filter
    # (bilateralFilter works on intensity; scaling makes sigmaColor easier to reason about)
    scaled_depth = float_depth * 65535.0
    
    # Bilateral filter: d=9 (pixel neighborhood), sigmaColor=5000 (intensity variation),
    # sigmaSpace=5 (coordinate space). This smooths gradients while preserving edges.
    filtered_scaled = cv2.bilateralFilter(scaled_depth, d=9, sigmaColor=5000.0, sigmaSpace=5.0)
    
    # Optional minor Gaussian blur to smooth any micro-textures
    print("Applying Gaussian blur to smooth micro-textures...", flush=True)
    filtered_scaled = cv2.GaussianBlur(filtered_scaled, (3, 3), 0)
    
    # Scale back to [0, 1]
    filtered_float = filtered_scaled / 65535.0

    # ==========================================
    # STEP 4: NORMALIZE THE DEPTH RANGE
    # ==========================================
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
    # STEP 5: EXPORT AS LOSSLESS 16-BIT PNG
    # ==========================================
    print(f"[STEP 5/5] Exporting processed 16-bit PNG to {output_path}...", flush=True)
    
    # Quantize float32 [0, 1] to uint16 [0, 65535]
    final_16bit = (normalized_float * 65535.0).astype(np.uint16)
    
    # Explicitly use compression parameters for maximum file safety and write via safe_imwrite
    safe_imwrite(output_path, final_16bit, [cv2.IMWRITE_PNG_COMPRESSION, 9])

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
    safe_imwrite(output_path, black_bg)

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
        safe_imwrite(output_path, inverted, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    elif img.dtype == np.uint8:
        # Invert 8-bit depth map: 255 - pixel
        if len(img.shape) == 3 and img.shape[2] == 4:
            inverted = img.copy()
            inverted[:, :, :3] = (255 - img[:, :, :3].astype(np.uint16)).astype(np.uint8)
        else:
            inverted = (255 - img.astype(np.uint16)).astype(np.uint8)
        safe_imwrite(output_path, inverted)
    else:
        # Fallback for other dtypes
        max_val = np.iinfo(img.dtype).max if np.issubdtype(img.dtype, np.integer) else 1.0
        if len(img.shape) == 3 and img.shape[2] == 4:
            inverted = img.copy()
            inverted[:, :, :3] = (max_val - img[:, :, :3]).astype(img.dtype)
        else:
            inverted = (max_val - img).astype(img.dtype)
        safe_imwrite(output_path, inverted)
        
    print(f"Exporting inverted depth map to {output_path}...", flush=True)

# ==========================================
# DEPTH ANYTHING V2 MONOCULAR DEPTH ESTIMATION
# ==========================================
MODEL_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx"
MODEL_FILENAME = "depth_anything_v2_vits_quantized.onnx"

def get_model_path():
    """Locates or prepares destination path for Depth Anything V2 ONNX model."""
    search_dirs = [
        os.environ.get("DEPTH_MODEL_DIR"),
        "/app/models",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "models"),
        "/app/data/models"
    ]
    for d in search_dirs:
        if d and os.path.exists(os.path.join(d, MODEL_FILENAME)):
            return os.path.join(d, MODEL_FILENAME)

    dest_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    os.makedirs(dest_dir, exist_ok=True)
    return os.path.join(dest_dir, MODEL_FILENAME)

def ensure_model_downloaded(model_path):
    """Downloads model if missing, with safety fallback and strict timeout."""
    if os.path.exists(model_path) and os.path.getsize(model_path) > 1000000:
        return True
    print(f"Downloading Depth Anything V2 Small ONNX model (~27MB) to {model_path}...", flush=True)
    try:
        import urllib.request
        req = urllib.request.Request(MODEL_URL, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
            if len(data) > 1000000:
                with open(model_path, "wb") as f:
                    f.write(data)
                print("Model download complete.", flush=True)
                return True
    except Exception as e:
        print(f"Warning: Model download failed or timed out ({e}), using photometric shape-from-shading fallback.", file=sys.stderr, flush=True)
    return False

def get_foreground_mask(img_bgr):
    """Isolates foreground subject on black CNC bed. Uses rembg if fast/available, else fast GrabCut."""
    h, w = img_bgr.shape[:2]
    # Check if rembg is available and u2net is already downloaded
    u2net_home = os.path.expanduser("~/.u2net/u2net.onnx")
    if os.path.exists(u2net_home):
        try:
            import rembg
            rgba = rembg.remove(img_bgr)
            alpha = rgba[:, :, 3]
            return (alpha > 20).astype(np.uint8)
        except Exception:
            pass

    # Fast GrabCut segmentation (100ms, zero download)
    try:
        margin_h = max(2, int(h * 0.04))
        margin_w = max(2, int(w * 0.04))
        rect = (margin_w, margin_h, w - 2 * margin_w, h - 2 * margin_h)
        mask = np.zeros((h, w), np.uint8)
        bgd_model = np.zeros((1, 65), np.float64)
        fgd_model = np.zeros((1, 65), np.float64)
        cv2.grabCut(img_bgr, mask, rect, bgd_model, fgd_model, 2, cv2.GC_INIT_WITH_RECT)
        fg_mask = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 1, 0).astype(np.uint8)
        if np.any(fg_mask > 0):
            return fg_mask
    except Exception:
        pass

    # Luminance threshold fallback
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 20, 255, cv2.THRESH_BINARY)
    return (thresh > 0).astype(np.uint8)

def run_depth_anything_inference(img_bgr, model_path):
    """Executes Depth Anything V2 inference on input image."""
    try:
        import onnxruntime as ort
        session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        input_name = session.get_inputs()[0].name
        output_name = session.get_outputs()[0].name

        orig_h, orig_w = img_bgr.shape[:2]
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        input_size = 518
        resized = cv2.resize(img_rgb, (input_size, input_size), interpolation=cv2.INTER_CUBIC)
        norm_img = resized.astype(np.float32) / 255.0
        mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
        std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
        norm_img = (norm_img - mean) / std
        tensor_in = np.expand_dims(norm_img.transpose(2, 0, 1), axis=0)

        outputs = session.run([output_name], {input_name: tensor_in})
        raw_depth = outputs[0]
        while len(raw_depth.shape) > 2:
            raw_depth = raw_depth[0]

        return cv2.resize(raw_depth, (orig_w, orig_h), interpolation=cv2.INTER_CUBIC)
    except Exception as e:
        print(f"ONNX inference failed: {e}. Trying cv2.dnn fallback...", file=sys.stderr, flush=True)
        try:
            net = cv2.dnn.readNetFromONNX(model_path)
            orig_h, orig_w = img_bgr.shape[:2]
            blob = cv2.dnn.blobFromImage(
                img_bgr,
                scalefactor=1.0 / 255.0,
                size=(518, 518),
                mean=(123.675, 116.28, 103.53),
                swapRB=True,
                crop=False
            )
            net.setInput(blob)
            out = net.forward()
            while len(out.shape) > 2:
                out = out[0]
            return cv2.resize(out, (orig_w, orig_h), interpolation=cv2.INTER_CUBIC)
        except Exception as e2:
            print(f"cv2.dnn failed: {e2}. Falling back to photometric depth.", file=sys.stderr, flush=True)
            return None

def compute_photometric_depth_fallback(img_bgr):
    """Photometric shape-from-shading and morphological edge depth fallback."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY) if len(img_bgr.shape) == 3 else img_bgr
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    grad = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, kernel)
    return gray.astype(np.float32) * 0.7 + (255 - grad.astype(np.float32)) * 0.3

def photo_to_depth(input_path, output_path, depth_intensity=70, isolate_bg="true"):
    """
    Converts user-uploaded photo directly into a true 16-bit grayscale depth map.
    Preserves exact geometry and features of the user's photo with zero hallucination.
    """
    print(f"[STEP 1/5] Loading source image from {input_path}...", flush=True)
    img_bgr = cv2.imread(input_path, cv2.IMREAD_COLOR)
    if img_bgr is None:
        print(f"Error: Could not load {input_path}", file=sys.stderr, flush=True)
        sys.exit(1)

    orig_h, orig_w = img_bgr.shape[:2]

    should_isolate = str(isolate_bg).lower() in ("true", "1", "yes")
    fg_mask = None
    if should_isolate:
        print("[STEP 2/5] Isolating subject on pure black CNC background...", flush=True)
        try:
            fg_mask = get_foreground_mask(img_bgr)
        except Exception as e:
            print(f"Background isolation skipped or failed: {e}", flush=True)
            fg_mask = np.ones((orig_h, orig_w), dtype=np.uint8)
    else:
        fg_mask = np.ones((orig_h, orig_w), dtype=np.uint8)

    print("[STEP 3/5] Running Depth Anything V2 monocular depth estimation...", flush=True)
    model_path = get_model_path()
    has_model = ensure_model_downloaded(model_path)
    
    depth_map = None
    if has_model:
        depth_map = run_depth_anything_inference(img_bgr, model_path)
    
    if depth_map is None:
        print("Using photometric depth estimation...", flush=True)
        depth_map = compute_photometric_depth_fallback(img_bgr)

    print("[STEP 4/5] Normalizing depth range and applying depth intensity...", flush=True)
    depth_float = depth_map.astype(np.float32)

    if fg_mask is not None and np.any(fg_mask > 0):
        fg_pixels = depth_float[fg_mask > 0]
        fg_min = float(np.percentile(fg_pixels, 1))
        fg_max = float(np.percentile(fg_pixels, 99))
        if fg_max > fg_min:
            depth_norm = np.clip((depth_float - fg_min) / (fg_max - fg_min), 0.0, 1.0)
        else:
            depth_norm = np.clip(depth_float, 0.0, 1.0)

        # Baseline elevation: subject floats at least 5% above the pure black CNC bed
        depth_norm = 0.05 + depth_norm * 0.95
        depth_norm[fg_mask == 0] = 0.0
    else:
        d_min = float(np.min(depth_float))
        d_max = float(np.max(depth_float))
        if d_max > d_min:
            depth_norm = (depth_float - d_min) / (d_max - d_min)
        else:
            depth_norm = depth_float

    try:
        intensity_val = float(depth_intensity)
    except:
        intensity_val = 70.0
    intensity_factor = np.clip(intensity_val / 70.0, 0.3, 1.5)
    
    gamma = 1.0 / intensity_factor
    depth_adjusted = np.power(np.clip(depth_norm, 0.0, 1.0), gamma)
    if fg_mask is not None:
        depth_adjusted[fg_mask == 0] = 0.0

    print("[STEP 5/5] Applying 16-bit bilateral spatial smoothing and saving...", flush=True)
    scaled_uint16 = (depth_adjusted * 65535.0).astype(np.float32)
    smoothed = cv2.bilateralFilter(scaled_uint16, d=7, sigmaColor=3500.0, sigmaSpace=3.0)
    
    if fg_mask is not None:
        smoothed[fg_mask == 0] = 0.0

    final_16bit = np.clip(smoothed, 0, 65535).astype(np.uint16)
    safe_imwrite(output_path, final_16bit, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f"True 16-bit photo depth map successfully exported to {output_path}!", flush=True)

def create_mesh(input_path, output_path):
    print("Error: 3D mesh generation is not yet implemented.", file=sys.stderr, flush=True)
    print("To enable this, install 'trimesh' and implement displacement mesh generation here.", file=sys.stderr, flush=True)
    sys.exit(1)

def main():
    if len(sys.argv) < 4:
        print("Usage: python processor.py <command> <input_path> <output_path> [depth_intensity] [isolate_bg]", file=sys.stderr, flush=True)
        sys.exit(1)

    mode = sys.argv[1]
    command = mode
    input_path = sys.argv[2]
    output_path = sys.argv[3]
    depth_intensity = sys.argv[4] if len(sys.argv) > 4 else 70
    isolate_bg = sys.argv[5] if len(sys.argv) > 5 else "true"

    if mode == "remove_bg":
        remove_bg(input_path, output_path)
    elif mode == "smooth":
        smooth_image(input_path, output_path)
    elif mode == "photo_to_depth":
        photo_to_depth(input_path, output_path, depth_intensity, isolate_bg)
    elif command == "invert":
        invert_image(input_path, output_path)
    elif command == "mesh":
        create_mesh(input_path, output_path)
    else:
        print(f"Unknown command: {command}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
