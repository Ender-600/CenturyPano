"""Explicit, offline UI demonstration: deterministic color treatment, not AI editing."""

from __future__ import annotations

import asyncio
import io
import os
import re

from PIL import Image, ImageEnhance, ImageOps


class DemoEditor:
    name = "demo"

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 60.0,
    ) -> bytes:
        # A fixed, disclosed simulated wait makes progressive UI behavior visible.
        # It is never described as inference time, and DEMO_DELAY_S=0 disables it.
        delay = max(0.0, min(5.0, float(os.getenv("DEMO_DELAY_S", "0.45"))))
        if delay:
            await asyncio.sleep(delay)
        return await asyncio.to_thread(self._tint, image, prompt)

    @staticmethod
    def _tint(data: bytes, prompt: str) -> bytes:
        with Image.open(io.BytesIO(data)) as source:
            original = source.convert("RGB")
        mono = ImageOps.grayscale(original)
        match = re.search(r"photograph taken in (\d{4})|photograph in (\d{4})", prompt)
        year = int(next(value for value in match.groups() if value)) if match else 1925
        if year >= 1970:
            tinted = ImageOps.colorize(mono, "#292d39", "#f0ce8a")
            tinted = Image.blend(tinted, ImageEnhance.Color(original).enhance(0.55), 0.55)
        elif year >= 1950:
            tinted = ImageOps.colorize(mono, "#24303b", "#e6dfc9")
            tinted = Image.blend(tinted, ImageEnhance.Color(original).enhance(0.35), 0.25)
        elif year < 1910:
            tinted = ImageOps.colorize(mono, "#2c2118", "#e0c594")
        else:
            tinted = ImageOps.colorize(mono, "#292016", "#f1d6a5")
        # No random per-tile effects: shared pixels receive identical treatment.
        output = io.BytesIO()
        tinted.save(output, "JPEG", quality=95, subsampling=0)
        return output.getvalue()
