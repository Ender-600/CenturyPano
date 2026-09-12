"""Pixel alignment between an original tile and its generated counterpart.

Image editors drift and locally reshape thin structures (railings, wires, kerbs).
A translation-only fix removes global drift; a clamped dense optical-flow warp then
pulls the generation onto the original edge field so neighbouring tiles that share
the same original geometry agree on those lines. Measurements are kept so the
manifest can report how aligned the result really is.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy.ndimage import shift as nd_shift
from skimage.feature import canny
from skimage.filters import gaussian, sobel
from skimage.registration import optical_flow_tvl1, phase_cross_correlation
from skimage.transform import rescale, resize, warp

MAX_SHIFT_PX = 48          # beyond this the model changed structure; do not translate
MIN_SHIFT_PX = 0.75        # below this a warp only adds resampling blur
EDGE_SIGMA = 1.6
FLOW_SCALE = 0.5           # compute flow at half resolution, then upsample
FLOW_MAX_PX = 20           # clamp per-pixel warp so appearance is not destroyed
FLOW_MIN_IMPROVE = 0.015   # require a real edge-agreement gain before keeping flow


@dataclass(frozen=True)
class Alignment:
    dx: float
    dy: float
    score_before: float
    score_after: float
    applied: bool
    flow_applied: bool = False

    def to_dict(self) -> dict:
        return {"dx": round(self.dx, 2), "dy": round(self.dy, 2),
                "score_before": round(self.score_before, 4), "score_after": round(self.score_after, 4),
                "applied": self.applied, "flow_applied": self.flow_applied}


# Rec. 709 luma, as scikit-image uses. Written out rather than called as a
# matrix product: `rgb2gray` is `array @ coeffs` in float64, and this runs on
# every tile inside a worker thread, which is exactly the BLAS path that
# segfaulted the stitch pass. See app/color.py.
_LUMA = (0.2125, 0.7154, 0.0721)


def _gray(image: Image.Image | np.ndarray) -> np.ndarray:
    array = np.asarray(image, dtype=np.float32)
    if array.max(initial=0) > 1:
        array = array / np.float32(255.0)
    if array.ndim == 3:
        gray = array[..., 0] * np.float32(_LUMA[0])
        gray += array[..., 1] * np.float32(_LUMA[1])
        gray += array[..., 2] * np.float32(_LUMA[2])
        return gray
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


def _clamp_flow(v: np.ndarray, u: np.ndarray, max_flow: float) -> tuple[np.ndarray, np.ndarray]:
    magnitude = np.sqrt(v * v + u * u)
    too_far = magnitude > max_flow
    if not np.any(too_far):
        return v, u
    scale = max_flow / np.maximum(magnitude, 1e-6)
    return np.where(too_far, v * scale, v), np.where(too_far, u * scale, u)


def warp_to_reference(
    reference: Image.Image,
    moving: Image.Image,
    *,
    max_flow: float = FLOW_MAX_PX,
    scale: float = FLOW_SCALE,
) -> Image.Image:
    """Dense-register `moving` onto `reference` with clamped optical flow.

    Thin structures (railings, cables) rarely share one global translation. Flow
    bends the generation onto the reference edge field so every tile of one
    panorama lands in the same geometry and neighbouring strips can fuse cleanly.
    """
    ref_rgb = np.asarray(reference.convert("RGB"), dtype=np.float32) / 255.0
    mov_rgb = np.asarray(moving.convert("RGB"), dtype=np.float32) / 255.0
    if mov_rgb.shape != ref_rgb.shape:
        mov_rgb = np.asarray(
            moving.convert("RGB").resize(reference.size, Image.Resampling.LANCZOS),
            dtype=np.float32,
        ) / 255.0
    ref_gray = _gray(ref_rgb)
    mov_gray = _gray(mov_rgb)
    # Prefer edge energy so thin rails / wires dominate the flow field over flat walls.
    ref_edge = edge_map(ref_gray)
    mov_edge = edge_map(mov_gray)
    ref_small = rescale(ref_edge, scale, anti_aliasing=True)
    mov_small = rescale(mov_edge, scale, anti_aliasing=True)
    try:
        v_small, u_small = optical_flow_tvl1(
            ref_small, mov_small, attachment=5.0, tightness=0.2, n_warp=5, n_iter=60,
        )
    except Exception:
        return moving.convert("RGB")
    height, width = ref_gray.shape
    v = resize(v_small, (height, width), anti_aliasing=True, preserve_range=True) / scale
    u = resize(u_small, (height, width), anti_aliasing=True, preserve_range=True) / scale
    v, u = _clamp_flow(v.astype(np.float32), u.astype(np.float32), max_flow)
    rows, cols = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
    warped = np.empty_like(mov_rgb)
    coords = np.array([rows + v, cols + u])
    for channel in range(3):
        warped[..., channel] = warp(mov_rgb[..., channel], coords, mode="edge")
    return Image.fromarray(np.round(np.clip(warped * 255.0, 0, 255)).astype(np.uint8))


def preserve_structure(
    original: Image.Image,
    generated: Image.Image,
    *,
    sigma: float = 10.0,
    appearance: float = 1.0,
    mix: float = 0.35,
    edge_band: int = 0,
) -> Image.Image:
    """Harmonise overlap lighting without stacking a second silhouette."""
    from scipy.ndimage import gaussian_filter

    source = np.asarray(original.convert("RGB"), dtype=np.float32)
    edited = np.asarray(generated.convert("RGB"), dtype=np.float32)
    if source.shape != edited.shape:
        edited = np.asarray(
            generated.convert("RGB").resize(original.size, Image.Resampling.LANCZOS),
            dtype=np.float32,
        )
    amount = float(np.clip(appearance, 0.0, 1.0))
    lf_mix = float(np.clip(mix, 0.0, 1.0))
    low_source = np.stack([gaussian_filter(source[..., channel], sigma=sigma) for channel in range(3)], axis=-1)
    low_edited = np.stack([gaussian_filter(edited[..., channel], sigma=sigma) for channel in range(3)], axis=-1)
    high_edited = edited - low_edited
    low_mixed = low_edited * (1.0 - lf_mix * amount) + low_source * (lf_mix * amount)
    combined = high_edited + low_mixed

    width = combined.shape[1]
    band = max(0, min(int(edge_band), width // 2))
    if band <= 0 or lf_mix <= 0:
        return generated.convert("RGB") if isinstance(generated, Image.Image) else Image.fromarray(
            np.round(np.clip(edited, 0, 255)).astype(np.uint8)
        )
    ramp = np.zeros(width, dtype=np.float32)
    ramp[:band] = np.linspace(1.0, 0.0, band, endpoint=False)
    ramp[-band:] = np.linspace(0.0, 1.0, band, endpoint=True)
    result = edited * (1.0 - ramp[:, None, None]) + combined * ramp[:, None, None]
    return Image.fromarray(np.round(np.clip(result, 0, 255)).astype(np.uint8))


def align_tile(original: Image.Image, generated: Image.Image) -> tuple[Image.Image, Alignment]:
    """Register `generated` onto `original` with translation, then clamped dense flow."""
    before = edge_agreement(original, generated)
    dx, dy = estimate_shift(original, generated)
    magnitude = float(np.hypot(dx, dy))
    candidate = generated
    translated = False
    if MIN_SHIFT_PX <= magnitude <= MAX_SHIFT_PX:
        shifted = apply_shift(generated, dx, dy)
        if edge_agreement(original, shifted) > before:
            candidate = shifted
            translated = True
    mid = edge_agreement(original, candidate)
    refined = warp_to_reference(original, candidate)
    after = edge_agreement(original, refined)
    if after >= mid + FLOW_MIN_IMPROVE:
        return refined, Alignment(dx, dy, before, after, applied=True, flow_applied=True)
    if translated:
        return candidate, Alignment(dx, dy, before, mid, applied=True, flow_applied=False)
    return generated, Alignment(dx, dy, before, before, applied=False, flow_applied=False)
