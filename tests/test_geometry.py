import numpy as np
import pytest
from PIL import Image

from app.config import H, N_MAX, TILE
from app.consistency import anchor_crop, color_match
from app.geometry import plan_tiles, preprocess, viewport_priority
from app.metrics import seam_error
from app.stitch import stitch


@pytest.mark.parametrize("width", [2048, 3072, 4096, 6300])
def test_tile_contract(width):
    n, step, overlap, positions = plan_tiles(width)
    assert 3 <= n <= 8
    assert positions[-1] + TILE == width
    assert overlap == TILE - step
    assert all(abs(position - i * step) <= .5 for i, position in enumerate(positions))
    assert all(b <= a + TILE for a, b in zip(positions, positions[1:]))


@pytest.mark.parametrize("size", [(64, 128), (24000, 300), (3000, 1000)])
def test_unusual_inputs_still_have_full_tile_coverage(size):
    prepared = preprocess(Image.new("RGB", size, (120, 140, 160)), is_360=False)
    geometry = prepared.geometry
    assert geometry["H"] == H
    assert TILE <= geometry["W"] <= TILE + (N_MAX - 1) * 870
    assert geometry["x"][0] == 0
    assert geometry["x"][-1] + TILE == geometry["W_ext"]
    assert geometry["overlap"] >= 0


def test_360_keeps_middle_third_and_exact_left_extension():
    source = Image.new("RGB", (600, 300), "green")
    source.paste("red", (0, 0, 600, 100))
    source.paste("blue", (0, 200, 600, 300))
    prepared = preprocess(source, is_360=True)
    g = prepared.geometry
    assert g["band"] == [H, 2 * H]
    assert g["W_ext"] == g["W"] + 154
    assert prepared.band.getpixel((100, H // 2)) == (0, 128, 0)
    assert np.array_equal(np.asarray(prepared.band)[:, :154], np.asarray(prepared.band_ext)[:, g["W"]:])


def test_feather_is_continuous_and_failed_tiles_use_original():
    _, _, overlap, positions = plan_tiles(3072)
    values = [30, 190, 80, 210]
    tiles = [Image.new("RGB", (TILE, H), (v, v, v)) for v in values]
    result = np.asarray(stitch(tiles, positions, overlap))
    assert np.max(np.abs(np.diff(result[H // 2, :, 0].astype(float)))) <= 2
    missing = tiles.copy()
    missing[1] = None
    fallback = np.asarray(stitch(missing, positions, overlap, originals=tiles))
    assert np.array_equal(result, fallback)


def test_anchor_transfer_reduces_measured_overlap_disagreement():
    reference = Image.new("RGB", (TILE, H), (145, 132, 108))
    tiles = [Image.new("RGB", (TILE, H), (180, 105, 90)),
             Image.new("RGB", (TILE, H), (90, 140, 180))]
    corrected = [color_match(tile, reference) for tile in tiles]
    assert seam_error(corrected, [0, 870]) < seam_error(tiles, [0, 870]) * .4


def test_wrapped_anchor_crop_and_result_keep_source_width():
    anchor = Image.new("RGB", (1200, H), (160, 145, 100))
    crop = anchor_crop(anchor, 5500, 6144, wrap=True)
    assert crop.size == (TILE, H)
    assert crop.getpixel((TILE - 1, H // 2)) == (160, 145, 100)
    _, _, overlap, positions = plan_tiles(6298)
    tiles = [Image.new("RGB", (TILE, H), (110, 110, 110)) for _ in positions]
    assert stitch(tiles, positions, overlap, True, W=6144).size == (6144, H)


def test_heading_prioritizes_visible_tiles_and_wrap_neighbors():
    positions = [0, 870, 1740, 2610, 3480, 4350, 5220]
    assert viewport_priority(positions, 0, 6244, False)[0] == 0
    assert viewport_priority(positions, 0, 6244, False)[-1] == 2
    assert viewport_priority(positions, 0, 6244, True)[-1] == 0
