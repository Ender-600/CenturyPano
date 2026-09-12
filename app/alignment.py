"""Pixel alignment between an original tile and its generated counterpart.

Image editors drift: even with a "keep the composition" instruction the output
can come back shifted by a few pixels. Across a panorama that drift shows up
twice — as a mismatch under the before/after slider, and as a structural seam
between neighbouring tiles that each drifted differently. Both are corrected
here with a deterministic, translation-only registration on edge maps, and
both are measured so the manifest can report how aligned the result really is.

Rotation and scale drift are deliberately not corrected: they are rare with
img2img at moderate strength, and a wrong warp is worse than no warp. When the
estimated shift is implausibly large the tile is left untouched and the
measurement records that structure changed rather than merely moved.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy.ndimage import shift as nd_shift
from skimage.color import rgb2gray
from skimage.feature import canny
from skimage.filters import gaussian, sobel
from skimage.registration import phase_cross_correlation

MAX_SHIFT_PX = 48          # beyond this the model changed structure; do not warp
MIN_SHIFT_PX = 0.75        # below this a warp only adds resampling blur
EDGE_SIGMA = 1.6


@dataclass(frozen=True)
class Alignment:
    dx: float
    dy: float
    score_before: float
    score_after: float
    applied: bool

    def to_dict(self) -> dict:
        return {"dx": round(self.dx, 2), "dy": round(self.dy, 2),
                "score_before": round(self.score_before, 4), "score_after": round(self.score_after, 4),
                "applied": self.applied}


def _gray(image: Image.Image | np.ndarray) -> np.ndarray:
    array = np.asarray(image, dtype=np.float32)
    if array.ndim == 3:
        array = rgb2gray(array / 255.0 if array.max(initial=0) > 1 else array)
    elif array.max(initial=0) > 1:
        array = array / 255.0
    return array.astype(np.float32)


def edge_map(image: Image.Image | np.ndarray) -> np.ndarray:
    """Smoothed gradient magnitude: robust to palette and material changes."""
    gray = gaussian(_gray(image), sigma=EDGE_SIGMA, preserve_range=True)
    edges = sobel(gray)
    peak = float(edges.max(initial=0))
    return (edges / peak).astype(np.float32) if peak > 0 else edges.astype(np.float32)


def edge_agreement(a: Image.Image | np.ndarray, b: Image.Image | np.ndarray) -> float:
    """Normalised cross-correlation of edge maps in [−1, 1]; 1 means identical structure."""
    ea, eb = edge_map(a), edge_map(b)
    ea = ea - ea.mean()
    eb = eb - eb.mean()
    denominator = float(np.sqrt((ea * ea).sum() * (eb * eb).sum()))
    if denominator <= 1e-9:
        return 0.0
    return float(np.clip((ea * eb).sum() / denominator, -1.0, 1.0))


def estimate_shift(original: Image.Image | np.ndarray, generated: Image.Image | np.ndarray) -> tuple[float, float]:
    """Return (dx, dy) that moves `generated` onto `original`, sub-pixel."""
    ref = canny(_gray(original), sigma=EDGE_SIGMA).astype(np.float32)
    mov = canny(_gray(generated), sigma=EDGE_SIGMA).astype(np.float32)
    if ref.sum() < 50 or mov.sum() < 50:
        return 0.0, 0.0
    shift, _error, _phase = phase_cross_correlation(ref, mov, upsample_factor=4, normalization=None)
    dy, dx = float(shift[0]), float(shift[1])
    return dx, dy


def apply_shift(image: Image.Image, dx: float, dy: float) -> Image.Image:
    array = np.asarray(image.convert("RGB"), dtype=np.float32)
    moved = np.empty_like(array)
    for channel in range(3):
        moved[..., channel] = nd_shift(array[..., channel], (dy, dx), order=1, mode="nearest")
    return Image.fromarray(np.round(np.clip(moved, 0, 255)).astype(np.uint8))


def align_tile(original: Image.Image, generated: Image.Image) -> tuple[Image.Image, Alignment]:
    """Register `generated` onto `original`; return the (possibly) shifted tile and the record."""
    before = edge_agreement(original, generated)
    dx, dy = estimate_shift(original, generated)
    magnitude = float(np.hypot(dx, dy))
    if magnitude < MIN_SHIFT_PX or magnitude > MAX_SHIFT_PX:
        return generated, Alignment(dx, dy, before, before, applied=False)
    shifted = apply_shift(generated, dx, dy)
    after = edge_agreement(original, shifted)
    if after <= before:
        # The registration did not help; keep the untouched generation.
        return generated, Alignment(dx, dy, before, before, applied=False)
    return shifted, Alignment(dx, dy, before, after, applied=True)
