"""Seam-aware compositing: carve the cut where tiles agree, feather where they don't.

Each tile is generated independently, so neighbours disagree inside their shared
overlap in two different ways, and the two need opposite treatments.

A *tonal* disagreement — one tile a little brighter or cooler than the next — is
spread out: a wide cosine feather turns the step into a gradient nobody can see.
That is what this module used to do for every seam, and for tonal differences it
is still the right answer.

A *structural* disagreement — the two tiles drew a different lamp post, a
different bench, a different clock face in the same strip — is the opposite. A
wide feather averages two different objects and produces a ghosted double
exposure, the single most visible defect in the panorama. The fix is the one
panorama stitchers use for parallax: find the vertical path through the overlap
along which the two tiles agree most (a minimum-cost cut, by dynamic
programming), take the left tile on one side of it and the right tile on the
other, and feather only a dozen pixels around the cut. The mismatch is not
averaged away, it is routed around.

Which of the two a seam needs is measured, not assumed: the cut is used only
when it is materially cheaper than the centre line. On flat or purely tonal
overlaps the cut saves nothing, the seam falls back to the wide feather, and the
plan records why — so the manifest can show, per seam, what was done and what it
bought.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from .color import delta_e, rgb_to_lab
from .config import H, TILE

CARVE_GAIN_MIN = .70       # carve only if the cut costs <= 70% of the centre line
CARVE_FEATHER_PX = 12      # narrow blend around the cut, to hide resampling only
MIN_CARVE_OVERLAP = 24     # below this there is nothing to route around


@dataclass(frozen=True)
class Seam:
    """What was decided for one pair of neighbouring tiles, and what it bought."""
    index: int
    overlap: int
    centre_de: float
    cut_de: float
    carved: bool
    cut: np.ndarray | None = None

    def to_dict(self) -> dict:
        return {"i": self.index, "overlap": self.overlap, "centre_de": round(self.centre_de, 3),
                "cut_de": round(self.cut_de, 3), "carved": self.carved,
                "gain": round(1 - self.cut_de / self.centre_de, 4) if self.centre_de > 1e-6 else 0.0}


def feather_weights(index: int, x: list[int], tile_w: int = TILE) -> np.ndarray:
    """Cosine ramps that sum to exactly one across each overlap."""
    weights = np.ones(tile_w, dtype=np.float32)
    if index > 0:
        left = max(0, min(tile_w, x[index - 1] + tile_w - x[index]))
        if left:
            ramp = .5 - .5 * np.cos(np.pi * np.linspace(0, 1, left, dtype=np.float32))
            weights[:left] *= ramp
    if index + 1 < len(x):
        right = max(0, min(tile_w, x[index] + tile_w - x[index + 1]))
        if right:
            ramp = .5 - .5 * np.cos(np.pi * np.linspace(1, 0, right, dtype=np.float32))
            weights[-right:] *= ramp
    return weights


def overlap_cost(left: Image.Image | np.ndarray, right: Image.Image | np.ndarray, overlap: int) -> np.ndarray:
    """Per-pixel Lab ΔE between the two tiles inside their shared strip.

    The strips are sliced before conversion, not after: only ~17% of each tile
    lies in the overlap, and converting the whole tile to throw most of it away
    was the bulk of this pass's memory traffic.
    """
    a = rgb_to_lab(np.asarray(left.convert("RGB") if isinstance(left, Image.Image) else left)[:, -overlap:])
    b = rgb_to_lab(np.asarray(right.convert("RGB") if isinstance(right, Image.Image) else right)[:, :overlap])
    return delta_e(a, b)


def min_cut(cost: np.ndarray) -> np.ndarray:
    """Cheapest top-to-bottom path, moving at most one column per row.

    Standard seam-carving dynamic program: `acc[y, c]` is the cheapest cost of
    reaching column `c` on row `y`, and `back` remembers which of the three
    predecessors was taken so the path can be walked back from the bottom.
    """
    rows, columns = cost.shape
    acc = cost.astype(np.float64, copy=True)
    back = np.zeros((rows, columns), dtype=np.int8)
    for y in range(1, rows):
        previous = acc[y - 1]
        left = np.roll(previous, 1)
        left[0] = np.inf
        right = np.roll(previous, -1)
        right[-1] = np.inf
        candidates = np.stack([left, previous, right])
        pick = np.argmin(candidates, axis=0)
        back[y] = pick.astype(np.int8) - 1
        acc[y] += candidates[pick, np.arange(columns)]
    path = np.empty(rows, dtype=int)
    path[-1] = int(np.argmin(acc[-1]))
    for y in range(rows - 1, 0, -1):
        path[y - 1] = path[y] + back[y, path[y]]
    return path


def seam_plan(tiles: list[Image.Image | np.ndarray], x: list[int]) -> list[Seam]:
    """Decide, per seam, between a carved cut and a wide feather — by measurement."""
    plan = []
    for index in range(len(tiles) - 1):
        overlap = x[index] + TILE - x[index + 1]
        if overlap < MIN_CARVE_OVERLAP:
            plan.append(Seam(index, max(0, overlap), 0.0, 0.0, carved=False))
            continue
        cost = overlap_cost(tiles[index], tiles[index + 1], overlap)
        centre = float(cost[:, overlap // 2].mean())
        cut = min_cut(cost)
        cut_de = float(cost[np.arange(cost.shape[0]), cut].mean())
        # A cut that is no cheaper than the centre line means the disagreement is
        # tonal, not structural; a hard cut would then be more visible than a ramp.
        carved = centre > 1e-6 and cut_de <= centre * CARVE_GAIN_MIN
        plan.append(Seam(index, overlap, centre, cut_de, carved, cut if carved else None))
    return plan


def stitch(tiles: list[Image.Image | np.ndarray | None], x: list[int], overlap: float | None = None,
           wrap: bool = False, *, W: int | None = None,
           originals: list[Image.Image | np.ndarray] | None = None,
           plan: list[Seam] | None = None) -> Image.Image:
    if not tiles or len(tiles) != len(x):
        raise ValueError("A tile is required for every planned position")
    width = x[-1] + TILE
    if wrap and W is None:
        raise ValueError("Original panorama width W is required when wrap is enabled")
    resolved = []
    for index, tile in enumerate(tiles):
        if tile is None:
            if originals is None:
                raise ValueError("Missing tiles require original fallback crops")
            tile = originals[index]
        array = np.asarray(tile, dtype=np.float32)
        if array.shape != (H, TILE, 3):
            raise ValueError(f"Tile {index} has invalid shape {array.shape}")
        resolved.append(array)
    if plan is None:
        plan = seam_plan(resolved, x)
    carved = {seam.index: seam.cut for seam in plan if seam.carved and seam.cut is not None}

    # Composite left to right: every tile blends against whatever already covers
    # its left overlap, so a carved seam and a feathered seam can coexist.
    canvas = np.zeros((H, width, 3), dtype=np.float32)
    covered = np.zeros(width, dtype=bool)
    canvas[:, x[0]:x[0] + TILE] = resolved[0]
    covered[x[0]:x[0] + TILE] = True
    for index in range(1, len(resolved)):
        start = x[index]
        strip = max(0, min(TILE, x[index - 1] + TILE - start))
        strip = min(strip, int(covered[start:start + TILE].sum()))
        if strip <= 0:
            canvas[:, start:start + TILE] = resolved[index]
        else:
            columns = np.arange(strip, dtype=np.float32)[None, :]
            cut = carved.get(index - 1)
            if cut is not None:
                ramp = np.clip((columns - cut[:, None]) / CARVE_FEATHER_PX + .5, 0, 1)
            else:
                ramp = (.5 - .5 * np.cos(np.pi * np.linspace(0, 1, strip, dtype=np.float32)))[None, :]
            ramp = ramp[..., None]
            left = canvas[:, start:start + strip]
            canvas[:, start:start + strip] = left * (1 - ramp) + resolved[index][:, :strip] * ramp
            canvas[:, start + strip:start + TILE] = resolved[index][:, strip:]
        covered[start:start + TILE] = True
    if not covered.all():
        raise ValueError("The tile plan left uncovered pixels")
    result = canvas
    if wrap:
        # The right extension and original left edge represent the same pixels.
        # Fold them together before cropping to avoid a hard wrap seam.
        extra = width - W
        if extra > 0:
            ramp = (.5 - .5 * np.cos(np.pi * np.linspace(0, 1, extra)))[None, :, None]
            result[:, :extra] = result[:, W:W + extra] * (1 - ramp) + result[:, :extra] * ramp
        result = result[:, :W]
    return Image.fromarray(np.round(np.clip(result, 0, 255)).astype(np.uint8))
