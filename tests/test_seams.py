import numpy as np
import pytest
from PIL import Image

from app.config import H, TILE
from app.consistency import GAIN_LIMIT, compensate_exposure
from app.geometry import plan_tiles
from app.metrics import seam_error, seam_metrics
from app.stitch import min_cut, overlap_cost, seam_plan, stitch


OVERLAP = 175
POSITIONS = [0, TILE - OVERLAP]


def _structured(seed, shift=0):
    """A tile with strong vertical structure, so a cut has something to follow."""
    rng = np.random.default_rng(seed)
    canvas = np.full((H, TILE, 3), 200, dtype=np.uint8)
    for _ in range(10):
        x = int(rng.integers(30, TILE - 200))
        canvas[:, x:x + 90] = rng.integers(20, 120, 3)
    canvas[700:] = (95, 85, 75)
    return np.roll(canvas, shift, axis=1)


def _disagreeing_pair():
    """Two tiles whose overlap agrees at the edges and draws a different object mid-strip.

    This is the real failure mode in miniature: neighbouring tiles that each
    rendered a lamp post, in different places. A cut exists (the agreeing
    columns); the centre line the old feather straddled does not.
    """
    background = np.tile(np.linspace(120, 205, TILE, dtype=np.float32)[None, :, None], (H, 1, 3))
    left = background.copy()
    right = background.copy()
    left[:, TILE - OVERLAP + 100:TILE - OVERLAP + 140] = 25    # left drew its object here
    right[:, 60:100] = 25                                       # right drew it 40px earlier
    return (np.round(left).astype(np.uint8), np.round(right).astype(np.uint8))


def test_min_cut_follows_the_cheap_column():
    cost = np.full((64, 40), 5.0)
    cost[:, 12] = 0.1                       # one obviously cheap column
    path = min_cut(cost)
    assert set(path) == {12}
    assert cost[np.arange(64), path].mean() < 0.2


def test_min_cut_may_wander_to_avoid_a_blocked_column():
    cost = np.full((64, 40), 5.0)
    cost[:, 12] = 0.1
    cost[30:34, 12] = 50.0                  # the cheap column is interrupted
    path = min_cut(cost)
    assert path.min() < 12 or path.max() > 12, "the path must route around the block"
    assert cost[np.arange(64), path].mean() < 5.0


def test_structural_disagreement_is_carved_and_measurably_better():
    # Two tiles that drew different content in the same overlap.
    left, right = _disagreeing_pair()
    positions, overlap = POSITIONS, OVERLAP
    tiles = [Image.fromarray(left), Image.fromarray(right)]
    plan = seam_plan(tiles, positions)
    seam = plan[0]
    assert seam.carved, "a structural mismatch must be routed around, not averaged"
    assert seam.cut_de < seam.centre_de * 0.7
    # The stitched result must take one side or the other, never the average.
    cost = overlap_cost(tiles[0], tiles[1], seam.overlap)
    result = np.asarray(stitch(tiles, positions, overlap, plan=plan), dtype=np.float32)
    column = positions[1] + seam.overlap // 2
    strip = result[:, column]
    from_left = np.abs(strip - left[:, TILE - seam.overlap + seam.overlap // 2]).sum(axis=1)
    from_right = np.abs(strip - right[:, seam.overlap // 2]).sum(axis=1)
    assert np.minimum(from_left, from_right).mean() < 12, "carved pixels should come from one tile"
    assert cost.shape == (H, seam.overlap)


def test_flat_tonal_difference_keeps_the_wide_feather():
    # Nothing to route around: a hard cut would be more visible than a ramp.
    values = [30, 190, 80, 210]
    _, _, overlap, positions = plan_tiles(3072)
    tiles = [Image.new("RGB", (TILE, H), (v, v, v)) for v in values]
    plan = seam_plan(tiles, positions)
    assert not any(seam.carved for seam in plan)
    result = np.asarray(stitch(tiles, positions, overlap, plan=plan))
    assert np.max(np.abs(np.diff(result[H // 2, :, 0].astype(float)))) <= 2


def test_failed_tiles_still_fall_back_to_the_original_crop():
    values = [30, 190, 80, 210]
    _, _, overlap, positions = plan_tiles(3072)
    tiles = [Image.new("RGB", (TILE, H), (v, v, v)) for v in values]
    complete = np.asarray(stitch(tiles, positions, overlap))
    missing = tiles.copy()
    missing[1] = None
    assert np.array_equal(complete, np.asarray(stitch(missing, positions, overlap, originals=tiles)))
    with pytest.raises(ValueError):
        stitch(missing, positions, overlap)


def test_compensation_removes_drift_without_repainting_the_panorama():
    _, _, overlap, positions = plan_tiles(4 * 849 + TILE)
    base = _structured(7)
    drift = [1.0, 1.06, 1.12, 1.05, 0.97]            # a left-to-right exposure ramp
    tiles = [Image.fromarray(np.clip(base * factor, 0, 255).astype(np.uint8)) for factor in drift]
    before = seam_error(tiles, positions)
    compensated, record = compensate_exposure(tiles, positions)
    after = seam_error(compensated, positions)
    assert record["applied"] and after < before
    assert GAIN_LIMIT[0] <= 1 - record["max_gain_deviation"] or record["max_gain_deviation"] <= .09
    assert record["max_bias"] <= 4.0
    assert len(compensated) == len(tiles) and compensated[0].size == (TILE, H)


def test_seam_metrics_report_the_whole_chain():
    positions = POSITIONS
    # Originals are overlapping crops of one band, so they agree exactly: the floor is zero.
    band = np.concatenate([_structured(4), _structured(5)], axis=1)
    originals = [Image.fromarray(band[:, x:x + TILE]) for x in positions]
    tiles = [Image.fromarray(tile) for tile in _disagreeing_pair()]
    plan = seam_plan(tiles, positions)
    metrics = seam_metrics(tiles, tiles, originals, positions, tiles, plan)
    assert metrics["originals_floor"] == 0.0
    assert metrics["after_compensation"] == metrics["after_color_match"]
    assert metrics["carved_seams"] == 1
    assert 0 < metrics["at_seam_cut"] < metrics["raw"], "the cut must beat the averaged overlap"


def test_wrapped_panorama_still_returns_the_source_width():
    _, _, overlap, positions = plan_tiles(6298)
    tiles = [Image.new("RGB", (TILE, H), (110, 110, 110)) for _ in positions]
    assert stitch(tiles, positions, overlap, True, W=6144).size == (6144, H)
    with pytest.raises(ValueError):
        stitch(tiles, positions, overlap, True)


def test_a_failed_tile_is_never_repainted_to_match_its_neighbours():
    # A failed tile is the unedited present-day crop. Nudging its exposure so it
    # agrees with generated neighbours would make the fallback look reconstructed.
    _, _, overlap, positions = plan_tiles(4 * 849 + TILE)
    base = _structured(9)
    tiles = [Image.fromarray(np.clip(base * factor, 0, 255).astype(np.uint8))
             for factor in (1.0, 1.08, 1.0, 1.1, 0.95)]
    untouched = np.asarray(tiles[2]).copy()
    compensated, record = compensate_exposure(tiles, positions, fixed={2})
    assert record["fixed"] == [2]
    assert np.array_equal(np.asarray(compensated[2]), untouched)
    assert not np.array_equal(np.asarray(compensated[1]), np.asarray(tiles[1]))
