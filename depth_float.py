"""depth_float.py - float32 depth smoothing with a real 16-bit export.

Standalone helpers meant to replace the x257 widening + bilateral step in
processor.py's `smooth` mode. Stays in float32 until the final export.
"""
import json
import os
import sys

import cv2
import numpy as np


def _env(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def load_float(path):
    """Return (float32 image in [0, 1], source bit depth)."""
    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise FileNotFoundError(path)
    if raw.ndim == 3:
        code = cv2.COLOR_BGRA2GRAY if raw.shape[2] == 4 else cv2.COLOR_BGR2GRAY
        raw = cv2.cvtColor(raw, code)
    if raw.dtype == np.uint8:
        return raw.astype(np.float32) / 255.0, 8
    return raw.astype(np.float32) / 65535.0, 16


def fill_holes(img, max_area_frac=0.005):
    """Fill small interior zero-value holes. Large or border-connected black
    regions (e.g. a removed background) are left alone."""
    mask = (img <= 0).astype(np.uint8)
    if not mask.any():
        return img
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    h, w = img.shape
    hole = np.zeros_like(mask)
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        touches_border = x == 0 or y == 0 or x + bw >= w or y + bh >= h
        if not touches_border and area <= max_area_frac * h * w:
            hole[labels == i] = 1
    if not hole.any():
        return img
    u8 = np.clip(img * 255.0, 0, 255).astype(np.uint8)
    filled = cv2.inpaint(u8, hole, 3, cv2.INPAINT_TELEA).astype(np.float32) / 255.0
    return np.where(hole == 1, filled, img).astype(np.float32)


def smooth_float(img, sigma=None, radius=None, eps=None, edge_threshold=None):
    sigma = _env("DEPTH_SMOOTH_SIGMA", 2.0) if sigma is None else sigma
    radius = int(_env("DEPTH_GUIDED_RADIUS", 8)) if radius is None else int(radius)
    eps = _env("DEPTH_GUIDED_EPS", 1e-4) if eps is None else eps
    edge_threshold = (
        _env("DEPTH_EDGE_THRESHOLD", 0.08) if edge_threshold is None else edge_threshold
    )
    img = img.astype(np.float32)
    blurred = cv2.GaussianBlur(img, (0, 0), sigma)
    try:
        smoothed = cv2.ximgproc.guidedFilter(img, blurred, radius, eps)
    except (AttributeError, cv2.error):
        print("warning: cv2.ximgproc unavailable, using float bilateral fallback",
              file=sys.stderr)
        smoothed = cv2.bilateralFilter(blurred, 9, 0.05, 5)
    # Gradient measured on a lightly blurred copy so 8-bit stair steps
    # are not mistaken for real edges.
    g = cv2.GaussianBlur(img, (0, 0), 1.0)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3) / 8.0
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3) / 8.0
    mag = np.hypot(gx, gy)
    edge = np.clip(mag / max(edge_threshold, 1e-6), 0.0, 1.0)
    return (edge * img + (1.0 - edge) * smoothed).astype(np.float32)


def normalize(img):
    lo, hi = float(img.min()), float(img.max())
    if hi - lo < 1e-9:
        return img
    return ((img - lo) / (hi - lo)).astype(np.float32)


def to_uint16(img, dither_amplitude=None, seed=0):
    amp = _env("DEPTH_DITHER_AMPLITUDE", 0.5 / 65535.0) if dither_amplitude is None \
        else dither_amplitude
    if amp > 0:
        rng = np.random.default_rng(seed)
        img = img + rng.normal(0.0, amp, img.shape).astype(np.float32)
    return np.round(np.clip(img, 0.0, 1.0) * 65535.0).astype(np.uint16)


def quality(out16):
    unique = int(len(np.unique(out16)))
    fake = unique <= 256 or bool(np.all(out16 % 257 == 0))
    return {"unique_levels": unique, "is_fake_16bit": fake}


def process_array(img, **kwargs):
    img = fill_holes(img)
    img = smooth_float(img, **kwargs)
    img = normalize(img)
    return to_uint16(img)


def process_file(in_path, out_path):
    img, src_bits = load_float(in_path)
    out = process_array(img)
    cv2.imwrite(out_path, out, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    result = quality(out)
    result["src_bits"] = src_bits
    return result


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: python depth_float.py <in.png> <out.png>")
    print(json.dumps(process_file(sys.argv[1], sys.argv[2])))
