"""Gemini native image editing via the server-side generateContent REST API."""

from __future__ import annotations

import base64
import io

import httpx
from PIL import Image

from .base import ProviderError, check_response, jpeg_bytes


class GeminiEditor:
    name = "gemini"

    def __init__(self, api_key: str | None = None, model: str | None = None, *, transport=None):
        from app.config import settings
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.model = model or settings.gemini_image_model
        self.transport = transport

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 60.0,
    ) -> bytes:
        # `strength` and `seed` are part of the shared editor interface and are used
        # by other providers. generateContent exposes neither, so fidelity to the
        # input here is carried entirely by the instruction text, not by a knob.
        from app.config import settings
        if not self.api_key:
            raise ProviderError("GEMINI_API_KEY is not configured", provider=self.name, retryable=False)
        with Image.open(io.BytesIO(image)) as source:
            source_size = source.size
        parts = [
            {"text": prompt},
            {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(image).decode("ascii")}},
        ]
        if reference:
            # Must agree with the structure policy the prompt carries, or the model
            # picks whichever instruction gives it more freedom.
            from app.constraints import REFERENCE_INSTRUCTION_LOCKED, REFERENCE_INSTRUCTION_OPEN
            instruction = REFERENCE_INSTRUCTION_LOCKED if settings.structure_lock else REFERENCE_INSTRUCTION_OPEN
            parts.extend([
                {"text": instruction},
                {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(reference).decode("ascii")}},
            ])
        if negative:
            parts.append({"text": "Avoid these visual elements: " + negative})
        payload = {"contents": [{"role": "user", "parts": parts}], "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}}
        async with httpx.AsyncClient(timeout=timeout_s, transport=self.transport) as client:
            response = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent",
                headers={"x-goog-api-key": self.api_key}, json=payload,
            )
        check_response(response, self.name)
        try:
            data = response.json()
            if data.get("promptFeedback", {}).get("blockReason"):
                raise ProviderError("gemini declined this image edit", provider=self.name, refusal=True)
            for candidate in data.get("candidates", []):
                if candidate.get("finishReason") in {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "RECITATION"}:
                    raise ProviderError("gemini declined this image edit", provider=self.name, refusal=True)
                for part in candidate.get("content", {}).get("parts", []):
                    if part.get("thought"):
                        continue
                    inline = part.get("inlineData") or part.get("inline_data")
                    if inline and inline.get("data"):
                        return jpeg_bytes(base64.b64decode(inline["data"], validate=True), source_size)
            raise ProviderError("gemini returned no image", provider=self.name, refusal=True)
        except (ValueError, TypeError, KeyError):
            raise ProviderError("gemini returned an invalid response", provider=self.name) from None
