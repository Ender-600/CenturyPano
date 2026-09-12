"""Panorama normalization and deterministic overlapping tile coordinates."""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import math
from pathlib import Path

from PIL import Image, ImageOps

from .config import H, N_MAX, N_MIN, STEP_TARGET, TILE


@dataclass
class Preprocessed:
    band: Image.Image
    band_ext: Image.Image
    geometry: dict
    warnings: list[str]


def image_bytes(image: Image.Image, *, quality: int = 94) -> bytes:
    buffer = BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality, subsampling=0)
    return buffer.getvalue()


def open_rgb(source: bytes | str | Path | Image.Image) -> Image.Image:
    if isinstance(source, Image.Image):
        return source.convert("RGB")
    with Image.open(BytesIO(source) if isinstance(source, bytes) else source) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def plan_tiles(W_ext: int) -> tuple[int, float, float, list[int]]:
    """Return count, uniform step, overlap, and flush-right tile positions.

    Preprocessing bounds widths so the eight-tile budget always covers the band.
    Refuse other unsupported widths instead of silently producing empty gaps.
    """
    if W_ext < TILE:
        raise ValueError(f"Working width must be at least {TILE}")
    n = max(N_MIN, min(N_MAX, math.ceil((W_ext - TILE) / STEP_TARGET) + 1))
    step = (W_ext - TILE) / (n - 1) if n > 1 else 0.0
    if step > TILE:
        raise ValueError("Working panorama exceeds tile coverage; preprocess it first")
    overlap = TILE - step
    x = [round(i * step) for i in range(n)]
    assert abs(x[-1] + TILE - W_ext) <= 1
    return n, step, overlap, x


def preprocess(source: bytes | str | Path | Image.Image, is_360: bool | None = None) -> Preprocessed:
    image = open_rgb(source)
    width, height = image.size
    if is_360 is None:
        is_360 = abs(width / height - 2.0) < 0.1
    warnings = []
    if width / height < 2.0:
        warnings.append("这张照片看起来较窄；使用全景模式能获得更好的体验。")
    target_height = H * 3 if is_360 else H
    original_working_width = max(1, round(width / height * target_height))
    extension = TILE - STEP_TARGET if is_360 else 0
    max_band_width = TILE + (N_MAX - 1) * STEP_TARGET - extension
    working_width = max(TILE, min(max_band_width, original_working_width))
    if working_width != original_working_width:
        warnings.append("全景已在水平方向归一化，以适配最多八个重叠图块。")
    resized = image.resize((working_width, target_height), Image.Resampling.LANCZOS)
    band = resized.crop((0, H, working_width, 2 * H)) if is_360 else resized
    extended = Image.new("RGB", (working_width + extension, H))
    extended.paste(band, (0, 0))
    if extension:
        extended.paste(band.crop((0, 0, extension, H)), (working_width, 0))
    n, step, overlap, positions = plan_tiles(extended.width)
    geometry = {
        "H": H, "W": working_width, "W_ext": extended.width,
        "tile_w": TILE, "n": n, "step": step, "overlap": overlap,
        "wrap": bool(is_360), "band": [H, H * 2] if is_360 else None,
        "x": positions, "original_W": original_working_width,
    }
    return Preprocessed(band, extended, geometry, warnings)


def viewport_priority(x: list[int], heading: float, W_ext: int, wrap: bool) -> list[int]:
    center = max(0.0, min(1.0, heading)) * W_ext
    priorities = []
    for position in x:
        distance = abs(position + TILE / 2 - center)
        if wrap:
            distance = min(distance, W_ext - distance)
        priorities.append(0 if distance < TILE else 1 if distance < 2 * TILE else 2)
    return priorities
