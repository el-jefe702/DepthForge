import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import depth_float as df  # noqa: E402


def dome(n=512):
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    r2 = ((x - n / 2) ** 2 + (y - n / 2) ** 2) / (n / 2) ** 2
    d = np.clip(1.0 - r2, 0, 1)
    return np.round(d * 255).astype(np.uint8)


class TestDepthFloat(unittest.TestCase):
    def test_dome_has_real_depth_levels(self):
        src = dome().astype(np.float32) / 255.0
        out = df.process_array(src)
        q = df.quality(out)
        self.assertEqual(out.dtype, np.uint16)
        self.assertGreater(q["unique_levels"], 2000)
        self.assertFalse(q["is_fake_16bit"])

    def test_detector_flags_fake_16bit(self):
        fake = (np.arange(256, dtype=np.uint16) * 257).reshape(16, 16)
        self.assertTrue(df.quality(fake)["is_fake_16bit"])

    def test_hard_edge_preserved(self):
        img = np.zeros((64, 64), np.float32)
        img[:, 32:] = 1.0
        out = df.process_array(img).astype(np.float32) / 65535.0
        row = out[32]
        transition = int(np.sum((row > 0.1) & (row < 0.9)))
        self.assertLessEqual(transition, 3)

    def test_constant_image_does_not_crash(self):
        out = df.process_array(np.full((32, 32), 0.5, np.float32))
        self.assertEqual(out.shape, (32, 32))

    def test_small_interior_hole_filled_border_background_kept(self):
        img = np.full((64, 64), 0.6, np.float32)
        img[30:33, 30:33] = 0.0
        img[:, :8] = 0.0
        filled = df.fill_holes(img)
        self.assertGreater(filled[31, 31], 0.3)
        self.assertEqual(float(filled[10, 2]), 0.0)


if __name__ == "__main__":
    unittest.main()
