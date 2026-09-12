"""Global style anchor and deterministic Lab color transfer."""
from __future__ import annotations

import warnings
import numpy as np
from PIL import Image
from skimage.color import lab2rgb, rgb2lab

from .config import ANCHOR_MAX_ASPECT, COLOR_MATCH_K, H, TILE


def squeeze_anchor(band: Image.Image) -> Image.Image:
    height = min(H, band.height)
    width = min(band.width, round(height * ANCHOR_MAX_ASPECT))
    return band.resize((width, height), Image.Resampling.LANCZOS)


def anchor_crop(anchor: Image.Image, x: int, W: int, *, wrap: bool = False) -> Image.Image:
    """Map original horizontal coordinates through the squeezed style reference."""
    anchor = anchor.convert("RGB")
    # PIL EXTENT supports fractional bounds and avoids subpixel discontinuities.
    if wrap and x + TILE > W:
        tiled = Image.new("RGB", (anchor.width * 2, anchor.height))
        tiled.paste(anchor, (0, 0))
        tiled.paste(anchor, (anchor.width, 0))
        source = tiled
    else:
        source = anchor
    scale = anchor.width / W
    left = (x % W if wrap else x) * scale
    right = left + TILE * scale
    return source.transform((TILE, H), Image.Transform.EXTENT,
                            (left, 0, right, anchor.height),
                            resample=Image.Resampling.BICUBIC)


def color_match(tile_rgb: Image.Image | np.ndarray, ref_rgb: Image.Image | np.ndarray,
                k: float = COLOR_MATCH_K) -> Image.Image:
    """Apply the specified channel-wise Reinhard transfer in CIE Lab."""
    tile = np.asarray(tile_rgb, dtype=np.float32)
    reference = np.asarray(ref_rgb, dtype=np.float32)
    if tile.max(initial=0) > 1:
        tile /= 255.0
    if reference.max(initial=0) > 1:
        reference /= 255.0
    lab = rgb2lab(np.clip(tile, 0, 1))
    target = rgb2lab(np.clip(reference, 0, 1))
    for channel in range(3):
        values, ref = lab[..., channel], target[..., channel]
        mean, std = values.mean(), values.std() + 1e-6
        ref_mean, ref_std = ref.mean(), ref.std() + 1e-6
        lab[..., channel] = (values - mean) * (ref_std / std) * k + (ref_mean * k + mean * (1 - k))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        output = lab2rgb(lab)
    return Image.fromarray(np.round(np.clip(output, 0, 1) * 255).astype(np.uint8))
