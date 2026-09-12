"""Cosine feathering with original-image fallback for failed tiles."""
from __future__ import annotations

import numpy as np
from PIL import Image

from .config import H, TILE


def feather_weights(index: int, x: list[int], tile_w: int = TILE) -> np.ndarray:
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


def stitch(tiles: list[Image.Image | np.ndarray | None], x: list[int], overlap: float | None = None,
           wrap: bool = False, *, W: int | None = None,
           originals: list[Image.Image | np.ndarray] | None = None) -> Image.Image:
    if not tiles or len(tiles) != len(x):
        raise ValueError("A tile is required for every planned position")
    width = x[-1] + TILE
    if wrap and W is None:
        raise ValueError("Original panorama width W is required when wrap is enabled")
    accumulation = np.zeros((H, width, 3), dtype=np.float32)
    weight_sum = np.zeros((1, width, 1), dtype=np.float32)
    for index, tile in enumerate(tiles):
        if tile is None:
            if originals is None:
                raise ValueError("Missing tiles require original fallback crops")
            tile = originals[index]
        array = np.asarray(tile, dtype=np.float32)
        if array.shape != (H, TILE, 3):
            raise ValueError(f"Tile {index} has invalid shape {array.shape}")
        weights = feather_weights(index, x)[None, :, None]
        accumulation[:, x[index]:x[index] + TILE, :] += array * weights
        weight_sum[:, x[index]:x[index] + TILE, :] += weights
    if np.any(weight_sum <= 0):
        raise ValueError("The tile plan left uncovered pixels")
    result = accumulation / weight_sum
    if wrap:
        # The right extension and original left edge represent the same pixels.
        # Fold them together before cropping to avoid a hard wrap seam.
        extra = width - W
        if extra > 0:
            ramp = (.5 - .5 * np.cos(np.pi * np.linspace(0, 1, extra)))[None, :, None]
            result[:, :extra] = result[:, W:W + extra] * (1 - ramp) + result[:, :extra] * ramp
        result = result[:, :W]
    return Image.fromarray(np.round(np.clip(result, 0, 255)).astype(np.uint8))
