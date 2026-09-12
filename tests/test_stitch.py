import numpy as np
from PIL import Image

from app.config import TILE
from app.metrics import seam_error
from app.stitch import fuse_overlaps


def test_fuse_overlaps_makes_shared_strip_identical():
    left = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    right = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    left[:, :] = (40, 80, 120)
    right[:, :] = (200, 160, 90)
    # Distinct structure in the would-be overlap so disagreement is obvious.
    left[:, -200:] = (10, 200, 30)
    right[:, :200] = (220, 20, 180)
    tiles = [Image.fromarray(left), Image.fromarray(right)]
    # Step of 824 → overlap 200 for 1024-wide tiles.
    x = [0, 824]
    assert seam_error(tiles, x) > 50
    fused = fuse_overlaps(tiles, x, fade_px=32)
    assert seam_error(fused, x) < 1e-3
    left_strip = np.asarray(fused[0])[:, -200:]
    right_strip = np.asarray(fused[1])[:, :200]
    assert np.array_equal(left_strip, right_strip)
    # Most of the overlap stays the left tile (no mid-strip double exposure).
    assert np.allclose(left_strip[:, :150], np.asarray(left)[:, -200:-50], atol=1)


def test_fuse_overlaps_hard_copy_avoids_mid_blend_ghost():
    left = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    right = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    left[:, -200:] = (0, 255, 0)
    right[:, :200] = (255, 0, 0)
    fused = fuse_overlaps([Image.fromarray(left), Image.fromarray(right)], [0, 824], fade_px=24)
    mid = np.asarray(fused[0])[:, -150]
    # Mid-overlap must be green (left), not an average yellow ghost.
    assert mid[:, 1].mean() > 200
    assert mid[:, 0].mean() < 30


def test_fuse_overlaps_connects_shifted_railing():
    """A horizontal railing offset between tiles must become one continuous line."""
    left = np.full((TILE, TILE, 3), 30, dtype=np.uint8)
    right = np.full((TILE, TILE, 3), 30, dtype=np.uint8)
    left[400:404, :] = 255
    right[408:412, :] = 255  # railing drifted down by 8 px on the right tile
    fused = fuse_overlaps([Image.fromarray(left), Image.fromarray(right)], [0, 824], fade_px=16)
    strip = np.asarray(fused[0])[:, -200:]
    # After fuse both sides share the left railing row band.
    assert strip[400:404].mean() > 200
    assert np.array_equal(np.asarray(fused[0])[:, -200:], np.asarray(fused[1])[:, :200])
