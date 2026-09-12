"""Seam-aware compositing: align overlaps, then carve or feather the cut.

Each tile is generated independently, so neighbours disagree inside their shared
overlap. Continuity is enforced in two stages:

1. `fuse_overlaps` registers neighbours (translation + edge-guided optical flow)
   and writes one shared, full-overlap feather strip so thin structures track
   without hard-pasting one tile's appearance onto the other.

2. `seam_plan` / `stitch` then choose a minimum-cost cut when residual structural
   disagreement remains, or a wide cosine feather when the leftover is only tonal.

Failed tiles stay as the original photograph and are left out of fusion.
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
STRUCTURAL_BLEND_MIN = .85 # wide feather only when aligned edge fields agree
DEFAULT_SHORT_FADE_PX = 24


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


def fuse_overlaps(
    tiles: list[Image.Image],
    x: list[int],
    *,
    fade_px: int | None = None,
    fixed: frozenset[int] | None = None,
) -> list[Image.Image]:
    """Align neighbours in every overlap, then share one smooth strip.

    1. Translate the whole right tile when the shift improves edge agreement
       (incl. a gated 1D height lock).
    2. Dense-warp the right strip onto the left strip (railings / wires follow).
    3. For structurally agreeing overlaps, cosine-blend left → warped-right
       across the full overlap. When the edge fields disagree, keep the left
       tile for most of the overlap and fade only the short tail. The latter
       prevents a different object from being averaged out across the seam.

    Tiles listed in `fixed` (typically failed originals) are left untouched and
    do not overwrite their neighbours.
    """
    from .alignment import (
        MAX_SHIFT_PX,
        MIN_SHIFT_PX,
        apply_shift,
        edge_agreement,
        estimate_shift,
        warp_to_reference,
    )

    if len(tiles) != len(x):
        raise ValueError("A tile is required for every planned position")
    skip = fixed or frozenset()
    arrays = [np.asarray(tile.convert("RGB"), dtype=np.float32).copy() for tile in tiles]
    for index in range(len(tiles) - 1):
        if index in skip or (index + 1) in skip:
            continue
        overlap = int(x[index] + TILE - x[index + 1])
        if overlap <= 0:
            continue
        left_img = Image.fromarray(np.round(np.clip(arrays[index][:, -overlap:], 0, 255)).astype(np.uint8))
        right_img = Image.fromarray(np.round(np.clip(arrays[index + 1][:, :overlap], 0, 255)).astype(np.uint8))
        before = edge_agreement(left_img, right_img)
        for _ in range(2):
            dx, dy = estimate_shift(left_img, right_img)
            if not (MIN_SHIFT_PX <= float(np.hypot(dx, dy)) <= MAX_SHIFT_PX):
                break
            right_tile = Image.fromarray(np.round(np.clip(arrays[index + 1], 0, 255)).astype(np.uint8))
            shifted = apply_shift(right_tile, dx, dy)
            shifted_strip = Image.fromarray(np.asarray(shifted)[:, :overlap])
            after = edge_agreement(left_img, shifted_strip)
            if after < before + 0.01:
                break
            arrays[index + 1] = np.asarray(shifted, dtype=np.float32)
            right_img = shifted_strip
            before = after
        warped_right = warp_to_reference(left_img, right_img, max_flow=12.0, scale=0.5)
        left = arrays[index][:, -overlap:]
        right = np.asarray(warped_right, dtype=np.float32)
        # A wide feather is safe for a tonal mismatch, but it averages two
        # different objects when the generated tiles disagree structurally.
        # Measure the aligned edge fields after the optical-flow step and use a
        # conservative short tail for that case. `None` means auto; an explicit
        # fade_px remains an escape hatch for callers that know their seam.
        structure_score = edge_agreement(left, right)
        if fade_px is None:
            span = (overlap if structure_score >= STRUCTURAL_BLEND_MIN
                    else min(DEFAULT_SHORT_FADE_PX, overlap))
        else:
            span = max(0, min(int(fade_px), overlap))
        if span >= overlap:
            ramp = (.5 - .5 * np.cos(np.pi * np.linspace(0.0, 1.0, overlap, dtype=np.float32)))[None, :, None]
            strip = left * (1.0 - ramp) + right * ramp
        elif span > 0:
            strip = left.copy()
            ramp = (.5 - .5 * np.cos(np.pi * np.linspace(0.0, 1.0, span, dtype=np.float32)))[None, :, None]
            strip[:, -span:] = left[:, -span:] * (1.0 - ramp) + right[:, -span:] * ramp
        else:
            strip = left.copy()
        arrays[index][:, -overlap:] = strip
        arrays[index + 1][:, :overlap] = strip
    return [Image.fromarray(np.round(np.clip(array, 0, 255)).astype(np.uint8)) for array in arrays]


def overlap_cost(left: Image.Image | np.ndarray, right: Image.Image | np.ndarray, overlap: int) -> np.ndarray:
    """Per-pixel Lab ΔE between the two tiles inside their shared strip."""
    a = rgb_to_lab(np.asarray(left.convert("RGB") if isinstance(left, Image.Image) else left)[:, -overlap:])
    b = rgb_to_lab(np.asarray(right.convert("RGB") if isinstance(right, Image.Image) else right)[:, :overlap])
    return delta_e(a, b)


def min_cut(cost: np.ndarray) -> np.ndarray:
    """Cheapest top-to-bottom path, moving at most one column per row."""
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
        extra = width - W
        if extra > 0:
            ramp = (.5 - .5 * np.cos(np.pi * np.linspace(0, 1, extra)))[None, :, None]
            result[:, :extra] = result[:, W:W + extra] * (1 - ramp) + result[:, :extra] * ramp
        result = result[:, :W]
    return Image.fromarray(np.round(np.clip(result, 0, 255)).astype(np.uint8))
