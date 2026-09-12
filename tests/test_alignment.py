import numpy as np
from PIL import Image

from app import alignment
from app.alignment import align_tile, edge_agreement, estimate_shift


def _scene(seed=3):
    rng = np.random.default_rng(seed)
    canvas = np.full((1024, 1024, 3), 210, dtype=np.uint8)
    for _ in range(14):
        x, y = rng.integers(40, 900, 2)
        w, h = rng.integers(60, 220, 2)
        canvas[y:y + h, x:x + w] = rng.integers(20, 180, 3)
    # Ground and a horizon line so the phase correlation has strong structure.
    canvas[700:] = (90, 80, 70)
    canvas[698:702] = 15
    return canvas


def _shifted(array, dx, dy, tint=(1.0, .92, .8)):
    moved = np.roll(np.roll(array, dy, axis=0), dx, axis=1).astype(np.float32)
    moved *= np.array(tint, dtype=np.float32)
    return Image.fromarray(np.clip(moved, 0, 255).astype(np.uint8))


def test_small_drift_is_recovered_and_improves_edge_agreement():
    original = Image.fromarray(_scene())
    drifted = _shifted(_scene(), 7, -4)
    dx, dy = estimate_shift(original, drifted)
    assert abs(dx + 7) <= 1.0 and abs(dy - 4) <= 1.0
    aligned, record = align_tile(original, drifted)
    assert record.applied
    assert record.score_after > record.score_before
    assert edge_agreement(original, aligned) >= record.score_after - 1e-6


def test_large_shift_is_reported_but_not_applied():
    original = Image.fromarray(_scene())
    drifted = _shifted(_scene(), alignment.MAX_SHIFT_PX + 40, 0)
    aligned, record = align_tile(original, drifted)
    assert not record.applied
    assert aligned is drifted
    assert record.score_before == record.score_after


def test_identical_tiles_are_left_untouched():
    original = Image.fromarray(_scene())
    same = Image.fromarray(_scene())
    aligned, record = align_tile(original, same)
    assert not record.applied and aligned is same
    assert record.score_before > 0.95
