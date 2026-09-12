"""Measured timing and overlap disagreement, before feather blending."""
from __future__ import annotations

import numpy as np
from PIL import Image

from .alignment import MAX_SHIFT_PX as MAX_PLAUSIBLE_SHIFT_PX
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


def integrity_metrics(tiles: list[dict]) -> dict:
    """How many tiles came back as two pictures, and how many were recovered.

    `unresolved` is the honest column: a retry is one more sample from the same
    model and it does not always land, so a panorama can finish with a break still
    in it. That is worth reporting rather than hiding behind the retry count.
    """
    records = [tile.get("integrity") for tile in tiles if isinstance(tile.get("integrity"), dict)]
    detected = [r for r in records if r.get("split") or r.get("retried")]
    return {"tested": len(records), "splits_detected": len(detected),
            "retries": sum(1 for r in records if r.get("retried")),
            "unresolved": sum(1 for r in records if r.get("split")),
            "worst_step_de": round(max((float(r.get("step_de") or 0.0) for r in records), default=0.0), 3)}


def timing_metrics(metrics: dict, finished_at: float) -> dict:
    start = metrics["started_at"]
    total = round(max(0.0, finished_at - start), 4)
    first_tile = metrics.get("first_tile_at")
    baseline = metrics.get("serial_baseline_s")
    return {"finished_at": finished_at, "total_s": total,
            "first_view_s": round(max(0, first_tile - start), 4) if first_tile else None,
            "speedup": round(baseline / total, 3) if baseline and total else None}


def alignment_metrics(tiles: list[dict]) -> dict:
    """Aggregate per-tile registration records into one panorama-level number.

    `mean_shift_px` averages only the registrations that were actually applied.
    A rejected estimate is a spurious phase-correlation peak — when a 2020s glass
    facade is reconstructed as 1900 brick the two edge maps share little
    structure, and the correlation peak can land hundreds of pixels away. Those
    are discarded rather than warped, so averaging them in reported a drift the
    panorama never had. They are counted instead, under `rejected`.
    """
    records = [tile.get("align") for tile in tiles if isinstance(tile.get("align"), dict)]
    if not records:
        return {"score_before": None, "score_after": None, "mean_shift_px": None,
                "applied": 0, "steady": 0, "rejected": 0}
    used = [r for r in records if r.get("applied")]
    magnitude = [float(np.hypot(r["dx"], r["dy"])) for r in records]
    rejected = sum(1 for r, size in zip(records, magnitude)
                   if not r.get("applied") and size > MAX_PLAUSIBLE_SHIFT_PX)
    return {"score_before": round(float(np.mean([r["score_before"] for r in records])), 4),
            "score_after": round(float(np.mean([r["score_after"] for r in records])), 4),
            "mean_shift_px": round(float(np.mean([float(np.hypot(r["dx"], r["dy"])) for r in used])), 2)
            if used else 0.0,
            "applied": len(used), "steady": len(records) - len(used) - rejected, "rejected": rejected}
