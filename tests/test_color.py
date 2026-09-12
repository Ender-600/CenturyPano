import importlib

import numpy as np
from PIL import Image
from skimage.color import lab2rgb, rgb2gray, rgb2lab

from app.alignment import align_tile, _gray
from app.color import delta_e, lab_to_rgb, rgb_to_lab
from app.config import H, TILE
from app.consistency import color_match, compensate_exposure
from app.metrics import seam_error
from app.stitch import seam_plan, stitch


def _noise(seed=0, shape=(192, 192, 3)):
    return np.random.default_rng(seed).integers(0, 256, shape).astype(np.uint8)


def test_lab_conversion_agrees_with_skimage():
    image = _noise()
    mine, reference = rgb_to_lab(image), rgb2lab(image / 255.0)
    assert np.abs(mine - reference).max() < 0.01, "Lab values must match the reference implementation"


def test_lab_round_trip_is_lossless_at_eight_bits():
    image = _noise(1)
    restored = lab_to_rgb(rgb_to_lab(image)) * 255.0
    assert np.abs(restored - image).max() < 0.5, "a round trip must not move any 8-bit level"


def test_inverse_agrees_with_skimage_and_clamps_out_of_gamut():
    lab = rgb2lab(_noise(2) / 255.0)
    assert np.abs(lab_to_rgb(lab) - np.clip(lab2rgb(lab), 0, 1)).max() < 0.005
    wild = np.array([[[50.0, 120.0, -120.0]]], dtype=np.float32)      # far outside sRGB
    assert lab_to_rgb(wild).min() >= 0.0 and lab_to_rgb(wild).max() <= 1.0


def test_grayscale_agrees_with_skimage():
    image = _noise(3)
    assert np.abs(_gray(image) - rgb2gray(image / 255.0)).max() < 1e-5


def test_extremes_and_shapes():
    for value, expected_l in ((0, 0.0), (255, 100.0)):
        lab = rgb_to_lab(np.full((4, 4, 3), value, dtype=np.uint8))
        assert lab.shape == (4, 4, 3) and lab.dtype == np.float32
        assert abs(float(lab[0, 0, 0]) - expected_l) < 0.01
    # A float input already in [0, 1] must not be divided by 255 a second time.
    assert abs(float(rgb_to_lab(np.ones((2, 2, 3), dtype=np.float32))[0, 0, 0]) - 100.0) < 0.01
    assert delta_e(np.zeros((5, 5, 3)), np.zeros((5, 5, 3))).shape == (5, 5)


def test_no_module_on_the_stitch_path_reintroduces_a_blas_conversion():
    """Apple's Accelerate BLAS segfaulted on a float64 matmul in a worker thread.

    scikit-image converts colour as `array @ matrix.T` in float64, so every
    module on the stitch and alignment path converts through app.color instead.
    The `@` operator dispatches in C and cannot be intercepted from Python, so
    this guards the thing that would actually regress: the import coming back.
    """
    forbidden = ("rgb2lab", "lab2rgb", "rgb2gray", "rgb2xyz", "xyz2lab", "skimage")
    for name in ("color", "stitch", "metrics", "alignment", "consistency"):
        module = importlib.import_module(f"app.{name}")
        bound = sorted(set(vars(module)) & set(forbidden))
        assert not bound, f"app/{name}.py binds {bound}; convert through app.color instead"


def test_the_whole_pass_runs_and_stays_numerically_sane():
    positions, overlap = [0, 849], 175
    rng = np.random.default_rng(4)
    tiles = []
    for _ in range(2):
        canvas = np.full((H, TILE, 3), 190, dtype=np.uint8)
        for _ in range(8):
            column = int(rng.integers(0, TILE - 80))
            canvas[:, column:column + 80] = rng.integers(20, 150, 3)
        tiles.append(Image.fromarray(canvas))
    compensated, record = compensate_exposure(tiles, positions)
    plan = seam_plan(compensated, positions)
    result = stitch(compensated, positions, overlap, plan=plan)
    assert record["applied"] and result.size == (positions[-1] + TILE, H)
    assert seam_error(compensated, positions) >= 0
    aligned, alignment = align_tile(tiles[0], tiles[1])
    assert aligned.size == (TILE, H) and -1 <= alignment.score_before <= 1


def test_color_match_still_moves_a_tile_toward_its_reference():
    reference = Image.new("RGB", (64, 64), (145, 132, 108))
    tile = Image.new("RGB", (64, 64), (180, 105, 90))
    matched = np.asarray(color_match(tile, reference), dtype=np.float32)
    before = np.abs(np.asarray(tile, dtype=np.float32) - np.asarray(reference, dtype=np.float32)).mean()
    after = np.abs(matched - np.asarray(reference, dtype=np.float32)).mean()
    assert after < before * 0.5
