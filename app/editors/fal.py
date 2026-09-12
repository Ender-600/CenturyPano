"""fal FLUX image-to-image fallback; reference images are unsupported by FLUX."""

from __future__ import annotations

import base64
import io
from urllib.parse import urlparse

import httpx
from PIL import Image

from .base import ProviderError, check_response, jpeg_bytes


class FalImg2ImgEditor:
    name = "fal"

    def __init__(self, api_key: str | None = None, model: str | None = None, *, transport=None):
        from app.config import settings
        self.api_key = api_key if api_key is not None else settings.fal_key
        self.model = model or settings.fal_model
        self.transport = transport

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 60.0,
    ) -> bytes:
        if not self.api_key:
            raise ProviderError("FAL_KEY is not configured", provider=self.name, retryable=False)
        with Image.open(io.BytesIO(image)) as source:
            source_size = source.size
        payload = {
            "image_url": "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii"),
            "prompt": prompt + (" Avoid: " + negative if negative else ""),
            "strength": 0.45 if strength is None else strength,
            "num_images": 1, "output_format": "jpeg", "sync_mode": True,
            "enable_safety_checker": True,
        }
        if seed is not None:
            payload["seed"] = seed
        async with httpx.AsyncClient(timeout=timeout_s, transport=self.transport) as client:
            response = await client.post(
                "https://fal.run/" + self.model.strip("/"),
                headers={"Authorization": "Key " + self.api_key}, json=payload,
            )
            check_response(response, self.name)
            try:
                result = response.json()
                if any(result.get("has_nsfw_concepts", [])):
                    raise ProviderError("fal declined this image edit", provider=self.name, refusal=True)
                url = result["images"][0]["url"]
                if url.startswith("data:image/") and ";base64," in url:
                    output = base64.b64decode(url.split(",", 1)[1], validate=True)
                else:
                    parsed = urlparse(url)
                    host = (parsed.hostname or "").lower()
                    if parsed.scheme != "https" or parsed.username or parsed.password or not (host == "fal.media" or host.endswith(".fal.media") or host.endswith(".fal.ai")):
                        raise ProviderError("fal returned an unsupported image URL", provider=self.name)
                    # Deliberately omit the provider key when reading public image output.
                    downloaded = await client.get(url)
                    check_response(downloaded, self.name)
                    output = downloaded.content
                return jpeg_bytes(output, source_size)
            except (ValueError, TypeError, KeyError, IndexError):
                raise ProviderError("fal returned an invalid response", provider=self.name) from None
