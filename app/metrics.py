"""Measured timing and overlap disagreement, before feather blending."""
from __future__ import annotations

import numpy as np
from PIL import Image

from .color import delta_e, rgb_to_lab
from .config import TILE


def seam_error(tiles: list[Image.Image | np.ndarray], x: list[int]) -> float:
    errors = []
    for index in range(len(tiles) - 1):
        overlap = x[index] + TILE - x[index + 1]
        if overlap <= 0:
            continue
        left = rgb_to_lab(np.asarray(tiles[index])[:, TILE - overlap:])
        right = rgb_to_lab(np.asarray(tiles[index + 1])[:, :overlap])
        errors.append(float(delta_e(left, right).mean()))
    return round(float(np.mean(errors)), 5) if errors else 0.0


def seam_metrics(raw: list[Image.Image], matched: list[Image.Image],
                 originals: list[Image.Image], x: list[int],
                 compensated: list[Image.Image] | None = None,
                 plan: list | None = None) -> dict:
    """The full chain, each step measured on the same overlaps.

    `at_seam_cut` is the number that matters: the disagreement along the path the
    stitcher actually cuts on, rather than across the whole overlap it used to
    average. The earlier columns are kept so the improvement is auditable.
    """
    result = {"raw": seam_error(raw, x), "after_color_match": seam_error(matched, x),
              "originals_floor": seam_error(originals, x),
              "after_compensation": None, "at_seam_cut": None, "carved_seams": None}
    if compensated is not None:
        result["after_compensation"] = seam_error(compensated, x)
    if plan:
        cuts = [seam for seam in plan if seam.overlap > 0]
        if cuts:
            result["at_seam_cut"] = round(float(np.mean([seam.cut_de if seam.carved else seam.centre_de
                                                         for seam in cuts])), 5)
            result["carved_seams"] = sum(1 for seam in cuts if seam.carved)
    return result


def timing_metrics(metrics: dict, finished_at: float) -> dict:
    start = metrics["started_at"]
    total = round(max(0.0, finished_at - start), 4)
    first_tile = metrics.get("first_tile_at")
    baseline = metrics.get("serial_baseline_s")
    return {"finished_at": finished_at, "total_s": total,
            "first_view_s": round(max(0, first_tile - start), 4) if first_tile else None,
            "speedup": round(baseline / total, 3) if baseline and total else None}


def alignment_metrics(tiles: list[dict]) -> dict:
    """Aggregate per-tile registration records into one panorama-level number."""
    records = [tile.get("align") for tile in tiles if isinstance(tile.get("align"), dict)]
    if not records:
        return {"score_before": None, "score_after": None, "mean_shift_px": None, "applied": 0}
    before = float(np.mean([r["score_before"] for r in records]))
    after = float(np.mean([r["score_after"] for r in records]))
    shift = float(np.mean([float(np.hypot(r["dx"], r["dy"])) for r in records]))
    return {"score_before": round(before, 4), "score_after": round(after, 4),
            "mean_shift_px": round(shift, 2), "applied": sum(1 for r in records if r.get("applied"))}
