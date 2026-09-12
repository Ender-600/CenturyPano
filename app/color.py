"""float32 sRGB ↔ CIE Lab conversion that never calls BLAS.

scikit-image converts colour spaces as `array @ matrix.T` in float64. On a
1024×1024 tile that is a one-million-row double matmul, and the stitch pass needs
one per tile and per overlap strip. Run inside a worker thread against Apple's
Accelerate BLAS, that combination segfaulted the server mid-stitch — the crash
was in `DOUBLE_matmul`, under memory pressure from the float64 temporaries.

A 3×3 colour transform is nine multiply-adds per pixel. Written out per channel
in float32 it produces the same Lab values to well under a thousandth of a unit,
allocates a third of the memory, and never enters BLAS at all — so the
instability is gone rather than made less likely. The matrices and the piecewise
companding below are the standard sRGB/D65 definitions scikit-image uses, kept
here explicitly so the two agree; `tests/test_color.py` pins that agreement.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

# sRGB (D65) → XYZ, and its inverse. Rows of the forward matrix.
_RGB_TO_XYZ = ((0.412453, 0.357580, 0.180423),
               (0.212671, 0.715160, 0.072169),
               (0.019334, 0.119193, 0.950227))
_XYZ_TO_RGB = (( 3.24048134, -1.53715152, -0.49853633),
               (-0.96925495,  1.87599000,  0.04155593),
               ( 0.05564664, -0.20404134,  1.05731107))
_WHITE = (0.95047, 1.0, 1.08883)

_LINEAR_CUT = np.float32(0.04045)        # sRGB companding threshold
_LAB_CUT = np.float32(0.008856)          # (6/29)^3
_LAB_SLOPE = np.float32(7.787)           # (1/3)(29/6)^2
_LAB_OFFSET = np.float32(16.0 / 116.0)


def _combine(channels: tuple, row: tuple) -> np.ndarray:
    """One row of a 3×3 transform, as explicit multiply-adds."""
    out = channels[0] * np.float32(row[0])
    out += channels[1] * np.float32(row[1])
    out += channels[2] * np.float32(row[2])
    return out


def as_float(image: Image.Image | np.ndarray) -> np.ndarray:
    """An (H, W, 3) float32 array in [0, 1], whatever the caller passed."""
    array = np.asarray(image.convert("RGB") if isinstance(image, Image.Image) else image,
                       dtype=np.float32)
    if array.max(initial=0.0) > 1.0:
        array = array / np.float32(255.0)
    return np.clip(array, 0.0, 1.0, out=array)


def rgb_to_lab(image: Image.Image | np.ndarray) -> np.ndarray:
    """sRGB → CIE Lab (L in [0, 100], a/b roughly ±128), float32."""
    array = as_float(image)
    # Inverse sRGB companding, in place where possible.
    linear = np.where(array > _LINEAR_CUT,
                      ((array + np.float32(0.055)) / np.float32(1.055)) ** np.float32(2.4),
                      array / np.float32(12.92)).astype(np.float32)
    channels = (linear[..., 0], linear[..., 1], linear[..., 2])
    scaled = []
    for row, white in zip(_RGB_TO_XYZ, _WHITE):
        scaled.append(_combine(channels, row) / np.float32(white))
    shaped = []
    for value in scaled:
        np.clip(value, 0.0, None, out=value)
        shaped.append(np.where(value > _LAB_CUT, np.cbrt(value),
                               value * _LAB_SLOPE + _LAB_OFFSET).astype(np.float32))
    fx, fy, fz = shaped
    lab = np.empty(array.shape, dtype=np.float32)
    lab[..., 0] = fy * np.float32(116.0) - np.float32(16.0)
    lab[..., 1] = (fx - fy) * np.float32(500.0)
    lab[..., 2] = (fy - fz) * np.float32(200.0)
    return lab


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """CIE Lab → sRGB in [0, 1], float32. Out-of-gamut values are clipped."""
    lab = np.asarray(lab, dtype=np.float32)
    fy = (lab[..., 0] + np.float32(16.0)) / np.float32(116.0)
    fx = fy + lab[..., 1] / np.float32(500.0)
    fz = fy - lab[..., 2] / np.float32(200.0)
    linear = []
    for value, white in zip((fx, fy, fz), _WHITE):
        cubed = value ** np.float32(3.0)
        restored = np.where(cubed > _LAB_CUT, cubed,
                            (value - _LAB_OFFSET) / _LAB_SLOPE).astype(np.float32)
        linear.append(restored * np.float32(white))
    channels = tuple(linear)
    rgb = np.empty(lab.shape, dtype=np.float32)
    for index, row in enumerate(_XYZ_TO_RGB):
        rgb[..., index] = _combine(channels, row)
    np.clip(rgb, 0.0, None, out=rgb)
    # Forward sRGB companding.
    companded = np.where(rgb > np.float32(0.0031308),
                         np.float32(1.055) * rgb ** np.float32(1 / 2.4) - np.float32(0.055),
                         rgb * np.float32(12.92)).astype(np.float32)
    return np.clip(companded, 0.0, 1.0, out=companded)


def lab_to_image(lab: np.ndarray) -> Image.Image:
    return Image.fromarray(np.round(lab_to_rgb(lab) * np.float32(255.0)).astype(np.uint8))


def delta_e(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-pixel Euclidean Lab distance (CIE76)."""
    difference = np.asarray(a, dtype=np.float32) - np.asarray(b, dtype=np.float32)
    return np.sqrt((difference * difference).sum(axis=-1))
