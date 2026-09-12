"""Explicit, offline UI demonstration: deterministic color treatment, not AI editing."""

from __future__ import annotations

import asyncio
import io
import os

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
        if "1975" in prompt or "1970s" in prompt:
            tinted = ImageOps.colorize(mono, "#292d39", "#f0ce8a")
            tinted = Image.blend(tinted, ImageEnhance.Color(original).enhance(0.55), 0.55)
        elif "1955" in prompt or "1950s" in prompt:
            tinted = ImageOps.colorize(mono, "#24303b", "#e6dfc9")
            tinted = Image.blend(tinted, ImageEnhance.Color(original).enhance(0.35), 0.25)
        elif "1905" in prompt or "1900s" in prompt:
            tinted = ImageOps.colorize(mono, "#2c2118", "#e0c594")
        else:
            tinted = ImageOps.colorize(mono, "#292016", "#f1d6a5")
        # No random per-tile effects: shared pixels receive identical treatment.
        output = io.BytesIO()
        tinted.save(output, "JPEG", quality=95, subsampling=0)
        return output.getvalue()
