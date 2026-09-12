"""Measured timing and overlap disagreement, before feather blending."""
from __future__ import annotations

import numpy as np
from PIL import Image
from skimage.color import rgb2lab

from .config import TILE


def seam_error(tiles: list[Image.Image | np.ndarray], x: list[int]) -> float:
    errors = []
    for index in range(len(tiles) - 1):
        overlap = x[index] + TILE - x[index + 1]
        if overlap <= 0:
            continue
        left = np.asarray(tiles[index], dtype=np.float32)[:, TILE - overlap:] / 255.0
        right = np.asarray(tiles[index + 1], dtype=np.float32)[:, :overlap] / 255.0
        delta = rgb2lab(left) - rgb2lab(right)
        errors.append(float(np.linalg.norm(delta, axis=-1).mean()))
    return round(float(np.mean(errors)), 5) if errors else 0.0


def seam_metrics(raw: list[Image.Image], matched: list[Image.Image],
                 originals: list[Image.Image], x: list[int]) -> dict:
    return {"raw": seam_error(raw, x), "after_color_match": seam_error(matched, x),
            "originals_floor": seam_error(originals, x)}


def timing_metrics(metrics: dict, finished_at: float) -> dict:
    start = metrics["started_at"]
    total = round(max(0.0, finished_at - start), 4)
    first_tile = metrics.get("first_tile_at")
    baseline = metrics.get("serial_baseline_s")
    return {"finished_at": finished_at, "total_s": total,
            "first_view_s": round(max(0, first_tile - start), 4) if first_tile else None,
            "speedup": round(baseline / total, 3) if baseline and total else None}
