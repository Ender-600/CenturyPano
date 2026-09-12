"""Global style anchor and deterministic Lab color transfer."""
from __future__ import annotations

import numpy as np
from PIL import Image

from .color import lab_to_image, rgb_to_lab
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


def _strip_stats(strip: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-channel median and median absolute deviation — robust to content."""
    middle = np.median(strip, axis=(0, 1))
    spread = np.median(np.abs(strip - middle), axis=(0, 1)) + 1e-3
    return middle.astype(np.float64), spread.astype(np.float64)


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

    Only the overlap strips are ever converted to Lab for the solve, and the
    iteration updates their statistics arithmetically rather than re-converting:
    the transform is affine, so a median maps to `gain * median + bias` and a
    spread to `gain * spread` exactly. Each tile is converted once, at the end,
    to apply the result.

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

    base = {}
    for index, overlap in enumerate(overlaps):
        if overlap <= 0:
            continue
        left = np.asarray(_as_image(tiles[index]))[:, TILE - overlap:]
        right = np.asarray(_as_image(tiles[index + 1]))[:, :overlap]
        base[index] = (_strip_stats(rgb_to_lab(left)), _strip_stats(rgb_to_lab(right)))

    gain, bias = np.ones((count, 3)), np.zeros((count, 3))
    for _ in range(COMPENSATION_PASSES):
        for channel in range(3):
            rows, targets = [], []
            for index, overlap in enumerate(overlaps):
                if overlap <= 0:
                    continue
                (left_mid, left_spread), (right_mid, right_spread) = base[index]
                neighbour = index + 1
                # Where the strips sit after everything applied so far.
                current_left = gain[index, channel] * left_mid[channel] + bias[index, channel]
                current_right = gain[neighbour, channel] * right_mid[channel] + bias[neighbour, channel]
                scaled_left = gain[index, channel] * left_spread[channel]
                scaled_right = gain[neighbour, channel] * right_spread[channel]
                row = np.zeros(2 * count)
                row[2 * index], row[2 * index + 1] = current_left, 1.0
                row[2 * neighbour], row[2 * neighbour + 1] = -current_right, -1.0
                rows.append(row)
                targets.append(0.0)
                row = np.zeros(2 * count)
                row[2 * index], row[2 * neighbour] = scaled_left, -scaled_right
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
    gain = np.clip(gain, *GAIN_LIMIT)
    bias = np.clip(bias, -BIAS_LIMIT, BIAS_LIMIT)
    gain[list(fixed)] = 1.0
    bias[list(fixed)] = 0.0
    output = []
    for index, tile in enumerate(tiles):
        if index in fixed:
            output.append(_as_image(tile))
            continue
        adjusted = rgb_to_lab(_as_image(tile))
        adjusted *= gain[index].astype(np.float32)
        adjusted += bias[index].astype(np.float32)
        np.clip(adjusted[..., 0], 0, 100, out=adjusted[..., 0])
        np.clip(adjusted[..., 1:], -128, 127, out=adjusted[..., 1:])
        output.append(lab_to_image(adjusted))
        del adjusted
    record = {"applied": True, "fixed": sorted(fixed), "max_gain_deviation": round(float(np.abs(gain - 1).max()), 4),
              "max_bias": round(float(np.abs(bias).max()), 3),
              "gain_l": [round(float(value), 4) for value in gain[:, 0]],
              "bias_l": [round(float(value), 3) for value in bias[:, 0]]}
    return output, record


def _as_image(tile: Image.Image | np.ndarray) -> Image.Image:
    if isinstance(tile, Image.Image):
        return tile.convert("RGB")
    return Image.fromarray(np.round(np.clip(np.asarray(tile, dtype=np.float32), 0, 255)).astype(np.uint8))


def color_match(tile_rgb: Image.Image | np.ndarray, ref_rgb: Image.Image | np.ndarray,
                k: float = COLOR_MATCH_K) -> Image.Image:
    """Apply the specified channel-wise Reinhard transfer in CIE Lab."""
    lab = rgb_to_lab(tile_rgb)
    target = rgb_to_lab(ref_rgb)
    for channel in range(3):
        values, ref = lab[..., channel], target[..., channel]
        mean, std = values.mean(), values.std() + 1e-6
        ref_mean, ref_std = ref.mean(), ref.std() + 1e-6
        lab[..., channel] = (values - mean) * (ref_std / std) * k + (ref_mean * k + mean * (1 - k))
    return lab_to_image(lab)
