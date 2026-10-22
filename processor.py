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

def create_mesh(input_path, output_path):
    print("Error: 3D mesh generation is not yet implemented.", file=sys.stderr, flush=True)
    print("To enable this, install 'trimesh' and implement displacement mesh generation here.", file=sys.stderr, flush=True)
    sys.exit(1)

def main():
    if len(sys.argv) < 4:
        print("Usage: python processor.py <command> <input_path> <output_path>", file=sys.stderr, flush=True)
        sys.exit(1)

    command = sys.argv[1]
    mode = command
    input_path = sys.argv[2]
    output_path = sys.argv[3]

    if command == "smooth":
        smooth_image(input_path, output_path)
    elif command == "remove_bg":
        if mode == "remove_bg":
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
