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
    fused = fuse_overlaps(tiles, x)
    assert seam_error(fused, x) < 1e-3
    left_strip = np.asarray(fused[0])[:, -200:]
    right_strip = np.asarray(fused[1])[:, :200]
    assert np.array_equal(left_strip, right_strip)
    # Auto mode selects the short tail for this structural disagreement.
    assert np.allclose(left_strip[:, :20], np.asarray(left)[:, -200:-180], atol=8)


def test_fuse_default_short_fade_preserves_structural_disagreement():
    left = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    right = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    left[:, -200:] = (0, 255, 0)
    right[:, :200] = (255, 0, 0)
    fused = fuse_overlaps([Image.fromarray(left), Image.fromarray(right)], [0, 824])
    mid = np.asarray(fused[0])[:, -100]
    # The default must not average a disagreement across the whole overlap.
    assert mid[:, 1].mean() > 200
    assert mid[:, 0].mean() < 30


def test_fuse_explicit_wide_feather_remains_available():
    left = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    right = np.zeros((TILE, TILE, 3), dtype=np.uint8)
    left[:, -200:] = (0, 255, 0)
    right[:, :200] = (255, 0, 0)
    fused = fuse_overlaps([Image.fromarray(left), Image.fromarray(right)], [0, 824], fade_px=200)
    mid = np.asarray(fused[0])[:, -100]
    assert 40 < mid[:, 1].mean() < 220
    assert 40 < mid[:, 0].mean() < 220


def test_fuse_overlaps_connects_shifted_railing():
    """A horizontal railing offset between tiles must become one continuous line."""
    left = np.full((TILE, TILE, 3), 30, dtype=np.uint8)
    right = np.full((TILE, TILE, 3), 30, dtype=np.uint8)
    left[400:404, :] = 255
    right[408:412, :] = 255  # railing drifted down by 8 px on the right tile
    fused = fuse_overlaps([Image.fromarray(left), Image.fromarray(right)], [0, 824])
    strip = np.asarray(fused[0])[:, -200:]
    peak = int(np.argmax(strip.mean(axis=(1, 2))))
    assert abs(peak - 402) <= 6
    assert np.array_equal(np.asarray(fused[0])[:, -200:], np.asarray(fused[1])[:, :200])


def test_fuse_propagates_height_into_tile_body():
    """Vertical drift must be corrected past the overlap, not only inside the strip."""
    rng = np.random.default_rng(2)

    def tile(rail_y: int, tint) -> np.ndarray:
        canvas = np.full((TILE, TILE, 3), 70, dtype=np.float32) * np.array(tint, dtype=np.float32)
        canvas += rng.normal(0, 12, canvas.shape)
        for x in range(0, TILE, 48):
            canvas[:, x:x + 10] *= 0.35
        canvas[rail_y:rail_y + 4, :] = 240
        canvas[600:] *= 0.65
        canvas[598:602] = 18
        return np.clip(canvas, 0, 255).astype(np.uint8)

    left = tile(380, (1.0, 1.0, 1.0))
    right = tile(400, (1.25, 0.88, 0.72))  # 20 px down + different palette
    fused = fuse_overlaps([Image.fromarray(left), Image.fromarray(right)], [0, 824])
    right_arr = np.asarray(fused[1])
    peak_overlap = int(np.argmax(right_arr[:, :200].mean(axis=(1, 2))))
    peak_body = int(np.argmax(right_arr[:, 400:600].mean(axis=(1, 2))))
    assert abs(peak_overlap - 382) <= 6
    assert abs(peak_body - peak_overlap) <= 6
