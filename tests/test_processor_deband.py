import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import processor as p  # noqa: E402


def ramp8(w=512, h=64, levels=20):
    row = np.floor(np.linspace(0, levels, w, endpoint=False))
    return np.tile(row, (h, 1)).astype(np.uint8)


class TestDeband(unittest.TestCase):
    def test_shallow_ramp_loses_terracing(self):
        before = ramp8().astype(np.float32) / 255.0
        out = p.finish_depth(before, 8, report=False)
        core = out[32].astype(np.float64)[40:-40]
        step_in_out_units = 65535.0 / 20.0  # one source level after normalization
        self.assertLess(float(np.max(np.abs(np.diff(core)))), 0.2 * step_in_out_units)
        self.assertGreater(p.quality(out)["unique_levels"], 500)

    def test_baseline_without_deband_is_terraced(self):
        before = ramp8().astype(np.float32) / 255.0
        os.environ["DEPTH_DEBAND_ITERS"] = "0"
        try:
            out = p.finish_depth(before, 8, report=False)
        finally:
            del os.environ["DEPTH_DEBAND_ITERS"]
        core = out[32].astype(np.float64)[40:-40]
        step_in_out_units = 65535.0 / 20.0
        self.assertGreater(float(np.max(np.abs(np.diff(core)))), 0.2 * step_in_out_units)

    def test_real_edge_survives(self):
        img = np.zeros((64, 128), np.float32)
        img[:, 64:] = 0.5
        out = p.finish_depth(img, 8, report=False).astype(np.float32) / 65535.0
        self.assertLess(float(out[32, 56]), 0.1)
        self.assertGreater(float(out[32, 72]), 0.9)

    def test_detects_widened_8bit(self):
        a = (np.arange(256, dtype=np.uint16) * 257).reshape(16, 16)
        self.assertEqual(p.detect_src_bits(a)[0], 8)
        b = a.copy()
        b[0, 0] = 1234
        self.assertEqual(p.detect_src_bits(b)[0], 16)

    def test_quality_flags_fake(self):
        fake = (np.arange(256, dtype=np.uint16) * 257).reshape(16, 16)
        self.assertTrue(p.quality(fake)["is_fake_16bit"])

    def test_constant_image(self):
        out = p.finish_depth(np.full((32, 32), 0.5, np.float32), 8, report=False)
        self.assertEqual(out.dtype, np.uint16)


if __name__ == "__main__":
    unittest.main()
