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


GAIN_LIMIT = (.92, 1.09)                       # a visible change beyond this is the model's, not ours
BIAS_LIMIT = np.array([4.0, 2.5, 2.5])         # Lab units: L, a, b
COMPENSATION_PASSES = 3
IDENTITY_PULL = 1.2


def compensate_exposure(tiles: list[Image.Image | np.ndarray], x: list[int], *,
                        fixed: set[int] | frozenset[int] = frozenset()) -> tuple[list[Image.Image], dict]:
    """Remove left-to-right exposure drift by solving one gain+bias per tile.

    Matching each tile to its own crop of the style anchor makes every tile
    plausible on its own but leaves neighbours free to drift apart, because
    nothing in that step looks at the seam. This does: for every adjacent pair it
    asks that the two tiles agree in median and spread inside their shared strip,
    and solves all tiles at once by least squares so a correction cannot be dumped
    on one end of the panorama.

    The solve is deliberately weak. Overlaps here are ~175 of 1024 pixels and the
    two tiles genuinely drew different content inside them, so the seam statistics
    are noisy evidence about exposure. Medians rather than means, a strong pull
    toward identity, a zero-mean gauge on the offsets and hard clamps keep this to
    what it is meant for — a nudge that removes drift — and leave the visible
    disagreement to the seam carve, which is the right tool for it.

    Tiles listed in `fixed` are returned untouched and the seams touching them are
    dropped from the solve. That is how a failed tile — which is the unedited
    present-day crop, not a reconstruction — stays identical to the photograph
    instead of being nudged into agreement with its generated neighbours.
    """
    count = len(tiles)
    if count < 2:
        return [_as_image(tile) for tile in tiles], {"applied": False, "reason": "single tile"}
    overlaps = [x[i] + TILE - x[i + 1] if (i not in fixed and i + 1 not in fixed) else 0
                for i in range(count - 1)]
    if not any(overlap > 0 for overlap in overlaps):
        return [_as_image(tile) for tile in tiles], {"applied": False, "reason": "no usable overlap"}

    labs = [_lab(tile) for tile in tiles]
    current = [lab.copy() for lab in labs]
    gain, bias = np.ones((count, 3)), np.zeros((count, 3))
    for _ in range(COMPENSATION_PASSES):
        for channel in range(3):
            rows, targets = [], []
            for index, overlap in enumerate(overlaps):
                if overlap <= 0:
                    continue
                left = current[index][:, TILE - overlap:, channel]
                right = current[index + 1][:, :overlap, channel]
                left_mid, right_mid = np.median(left), np.median(right)
                # Median absolute deviation: a robust stand-in for spread.
                left_spread = np.median(np.abs(left - left_mid)) + 1e-3
                right_spread = np.median(np.abs(right - right_mid)) + 1e-3
                row = np.zeros(2 * count)
                row[2 * index], row[2 * index + 1] = left_mid, 1.0
                row[2 * (index + 1)], row[2 * (index + 1) + 1] = -right_mid, -1.0
                rows.append(row)
                targets.append(0.0)
                row = np.zeros(2 * count)
                row[2 * index], row[2 * (index + 1)] = left_spread, -right_spread
                rows.append(row)
                targets.append(0.0)
            for index in range(count):
                # A fixed tile is pinned to the identity transform, not merely pulled.
                pull = 1e6 if index in fixed else IDENTITY_PULL * 50
                row = np.zeros(2 * count)
                row[2 * index] = pull
                rows.append(row)
                targets.append(pull)
                pull = 1e6 if index in fixed else IDENTITY_PULL * 4
                row = np.zeros(2 * count)
                row[2 * index + 1] = pull
                rows.append(row)
                targets.append(0.0)
            gauge = np.zeros(2 * count)
            gauge[1::2] = 3.0                      # offsets sum to zero: no global shift
            rows.append(gauge)
            targets.append(0.0)
            solution, *_ = np.linalg.lstsq(np.array(rows), np.array(targets), rcond=None)
            step_gain = np.clip(solution[0::2], *GAIN_LIMIT)
            step_bias = np.clip(solution[1::2], -BIAS_LIMIT[channel], BIAS_LIMIT[channel])
            gain[:, channel] *= step_gain
            bias[:, channel] = bias[:, channel] * step_gain + step_bias
            for index in range(count):
                current[index][..., channel] = current[index][..., channel] * step_gain[index] + step_bias[index]
    gain = np.clip(gain, *GAIN_LIMIT)
    bias = np.clip(bias, -BIAS_LIMIT, BIAS_LIMIT)
    gain[list(fixed)] = 1.0
    bias[list(fixed)] = 0.0
    output = []
    for index, lab in enumerate(labs):
        if index in fixed:
            output.append(_as_image(tiles[index]))
            continue
        adjusted = lab * gain[index] + bias[index]
        adjusted[..., 0] = np.clip(adjusted[..., 0], 0, 100)
        adjusted[..., 1:] = np.clip(adjusted[..., 1:], -128, 127)
        output.append(_from_lab(adjusted))
    record = {"applied": True, "fixed": sorted(fixed), "max_gain_deviation": round(float(np.abs(gain - 1).max()), 4),
              "max_bias": round(float(np.abs(bias).max()), 3),
              "gain_l": [round(float(value), 4) for value in gain[:, 0]],
              "bias_l": [round(float(value), 3) for value in bias[:, 0]]}
    return output, record


def _as_image(tile: Image.Image | np.ndarray) -> Image.Image:
    if isinstance(tile, Image.Image):
        return tile.convert("RGB")
    return Image.fromarray(np.round(np.clip(np.asarray(tile, dtype=np.float32), 0, 255)).astype(np.uint8))


def _lab(tile: Image.Image | np.ndarray) -> np.ndarray:
    array = np.asarray(tile, dtype=np.float32)
    return rgb2lab(np.clip(array / 255.0 if array.max(initial=0) > 1 else array, 0, 1))


def _from_lab(lab: np.ndarray) -> Image.Image:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        rgb = lab2rgb(lab)
    return Image.fromarray(np.round(np.clip(rgb, 0, 1) * 255).astype(np.uint8))


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
