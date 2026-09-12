import numpy as np
import pytest
from PIL import Image

from app.config import H, TILE
from app.integrity import FULL_HEIGHT, STEP_DE, split_check, worse
from app.metrics import integrity_metrics


def _room(seed, brightness=1.0):
    """An interior with real vertical objects: window mullions and furniture edges."""
    rng = np.random.default_rng(seed)
    canvas = np.full((H, TILE, 3), 150, dtype=np.float32)
    canvas += np.linspace(-20, 20, TILE, dtype=np.float32)[None, :, None]
    for _ in range(6):
        x = int(rng.integers(60, TILE - 80))
        canvas[:, x:x + 14] = 40                       # a full-height mullion
    canvas[620:] = 90                                   # floor
    canvas[:200] = 185                                  # ceiling
    return np.clip(canvas * brightness, 0, 255).astype(np.uint8)


def _diptych(left_seed, right_seed, column):
    """Two unrelated pictures butted together along one hard vertical line."""
    canvas = _room(left_seed, 1.0).copy()
    canvas[:, column:] = _room(right_seed, 0.28)[:, column:]
    return canvas


def test_a_real_vertical_object_is_not_a_split():
    original = Image.fromarray(_room(1))
    # The generation keeps the structure and moves the palette, as the lock asks.
    generated = Image.fromarray(np.clip(_room(1) * .88 + 14, 0, 255).astype(np.uint8))
    record = split_check(original, generated)
    assert not record["split"]
    assert record["broken_rows"] < FULL_HEIGHT


def test_an_invented_full_height_break_is_caught():
    original = Image.fromarray(_room(2))
    generated = Image.fromarray(_diptych(2, 9, 460))
    record = split_check(original, generated)
    assert record["split"], record
    assert abs(record["column"] - 460) <= 6, "the reported column must locate the break"
    assert record["step_de"] >= STEP_DE
    assert record["broken_rows"] >= FULL_HEIGHT


def test_a_break_the_photograph_already_has_is_left_alone():
    """The pixel lock is doing its job; a hard edge in the source is not our bug.

    The panorama the user handed us can contain a genuine discontinuity -- the
    capture swept past a doorway, or a window frame really does divide the wall.
    Flagging that would spend an image call on every such photo and get the same
    edge back, correctly, every time.
    """
    source = _diptych(3, 11, 500)
    original = Image.fromarray(source)
    generated = Image.fromarray(np.clip(source * .9 + 10, 0, 255).astype(np.uint8))
    record = split_check(original, generated)
    assert not record["split"], record
    # It did not merely fail the threshold: the shared edge was never the worst
    # *invented* boundary, because the original accounts for all of it.
    assert abs(record["column"] - 500) > 20, record


def test_the_tile_edges_are_left_to_the_seam_carve():
    # A boundary in the overlap region is the stitcher's business, and carving it
    # is cheaper and better than spending another image call on it.
    original = Image.fromarray(_room(4))
    for column in (6, TILE - 6):
        generated = Image.fromarray(_diptych(4, 12, column))
        assert not split_check(original, generated)["split"]


def test_mismatched_sizes_report_rather_than_raise():
    record = split_check(Image.fromarray(_room(5)), Image.new("RGB", (300, H), (120, 120, 120)))
    assert record["split"] is False and "reason" in record


def test_worse_prefers_the_unsplit_attempt_then_the_smaller_step():
    split = {"split": True, "step_de": 30.0}
    clean = {"split": False, "step_de": 9.0}
    assert worse(split, clean) and not worse(clean, split)
    assert worse({"split": False, "step_de": 12.0}, {"split": False, "step_de": 8.0})
    assert not worse({"split": False, "step_de": 8.0}, {"split": False, "step_de": 12.0})


def test_integrity_metrics_report_an_unresolved_break_honestly():
    tiles = [
        {"integrity": {"split": False, "step_de": 7.1}},
        {"integrity": {"split": False, "step_de": 9.4, "retried": True}},   # retry fixed it
        {"integrity": {"split": True, "step_de": 26.0, "retried": True}},   # retry did not
        {"status": "error"},                                                 # never generated
    ]
    record = integrity_metrics(tiles)
    assert record == {"tested": 3, "splits_detected": 2, "retries": 2,
                      "unresolved": 1, "worst_step_de": 26.0}


@pytest.mark.parametrize("column", [200, 447, 800])
def test_the_break_is_found_wherever_it_falls(column):
    original = Image.fromarray(_room(6))
    record = split_check(original, Image.fromarray(_diptych(6, 13, column)))
    assert record["split"] and abs(record["column"] - column) <= 6


def test_a_break_hidden_on_top_of_a_real_edge_is_still_caught():
    """The editor likes to break the picture at something it was already redrawing.

    Scoring the boundaries and then testing only the best-scoring one lets that
    case through, because the photograph's own edge cancels part of the score.
    Every boundary is tested instead, so the break is found where it actually is.
    """
    original = _room(7).copy()
    column = 400
    original[:, column:column + 14] = 45            # a real mullion at the break
    generated = _diptych(7, 14, column)
    generated[:, column - 14:column] = 45           # and the generation keeps it
    record = split_check(Image.fromarray(original), Image.fromarray(generated))
    assert record["split"], record
    assert abs(record["column"] - column) <= 20, record
