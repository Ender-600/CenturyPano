"""OpenAI GPT Image editing via the Images edits REST API."""

from __future__ import annotations

import base64
import io

import httpx
from PIL import Image

from .base import ProviderError, check_response, jpeg_bytes


class OpenAIImageEditor:
    name = "openai"

    def __init__(self, api_key: str | None = None, model: str | None = None, *, transport=None):
        from app.config import settings

        self.api_key = api_key if api_key is not None else settings.openai_api_key
        self.model = model or settings.openai_image_model
        self.quality = settings.openai_image_quality
        self.transport = transport

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 180.0,
        structure_lock: bool = False,
    ) -> bytes:
        del strength, seed  # Not supported by the Images edits endpoint.
        if not self.api_key:
            raise ProviderError("OPENAI_API_KEY is not configured", provider=self.name, retryable=False)
        with Image.open(io.BytesIO(image)) as source:
            source_size = source.size

        instruction = prompt
        if structure_lock:
            instruction += (
                " Keep the camera framing fixed. Historical reconstruction may reshape, remove or "
                "replace buildings and roads when the prompt requires it; keep major masses in "
                "broadly similar positions so neighbouring panorama tiles can stitch."
            )
        if reference:
            instruction += (
                " Image 1 is the tile to edit; image 2 is a consistency reference for lighting, "
                "palette and sky only — not historical evidence."
            )
        if negative:
            instruction += " Avoid these visual elements: " + negative

        files: list[tuple[str, tuple[str, bytes, str]]]
        if reference:
            files = [
                ("image[]", ("tile.jpg", image, "image/jpeg")),
                ("image[]", ("reference.jpg", reference, "image/jpeg")),
            ]
        else:
            files = [("image", ("tile.jpg", image, "image/jpeg"))]
        data = {
            "model": self.model,
            "prompt": instruction,
            "quality": self.quality,
            "size": "1024x1024",
        }
        async with httpx.AsyncClient(timeout=timeout_s, transport=self.transport) as client:
            response = await client.post(
                "https://api.openai.com/v1/images/edits",
                headers={"Authorization": "Bearer " + self.api_key},
                data=data,
                files=files,
            )
            check_response(response, self.name)
            try:
                payload = response.json()
                item = payload["data"][0]
                encoded = item.get("b64_json")
                if not encoded:
                    raise ProviderError("openai returned no image", provider=self.name, refusal=True)
                return jpeg_bytes(base64.b64decode(encoded, validate=True), source_size)
            except ProviderError:
                raise
            except (ValueError, TypeError, KeyError, IndexError):
                raise ProviderError("openai returned an invalid response", provider=self.name) from None
