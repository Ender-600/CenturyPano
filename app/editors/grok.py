"""Grok Imagine image editing via the xAI REST API."""

from __future__ import annotations

import base64
import io
from urllib.parse import urlparse

import httpx
from PIL import Image

from .base import ProviderError, check_response, jpeg_bytes


class GrokImagineEditor:
    """Edit an image with Grok Imagine's JSON image-edit endpoint."""

    name = "grok"

    def __init__(self, api_key: str | None = None, model: str | None = None, *, transport=None):
        from app.config import settings

        self.api_key = api_key if api_key is not None else settings.grok_api_key
        self.model = model or settings.grok_image_model
        self.transport = transport

    @staticmethod
    def _data_uri(image: bytes) -> str:
        return "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 60.0,
    ) -> bytes:
        if not self.api_key:
            raise ProviderError("XAI_API_KEY is not configured", provider=self.name, retryable=False)
        with Image.open(io.BytesIO(image)) as source:
            source_size = source.size

        edit_prompt = prompt + (" Avoid these visual elements: " + negative if negative else "")
        source_item = {"url": self._data_uri(image), "type": "image_url"}
        payload = {
            "model": self.model,
            "prompt": edit_prompt,
            "response_format": "b64_json",
        }
        if reference:
            payload["images"] = [source_item, {"url": self._data_uri(reference), "type": "image_url"}]
        else:
            payload["image"] = source_item

        async with httpx.AsyncClient(timeout=timeout_s, transport=self.transport) as client:
            response = await client.post(
                "https://api.x.ai/v1/images/edits",
                headers={"Authorization": "Bearer " + self.api_key},
                json=payload,
            )
            check_response(response, self.name)
            try:
                item = response.json()["data"][0]
                encoded = item.get("b64_json")
                if encoded:
                    output = base64.b64decode(encoded, validate=True)
                else:
                    parsed = urlparse(item["url"])
                    if parsed.scheme != "https" or parsed.hostname != "imgen.x.ai":
                        raise ProviderError("grok returned an unsupported image URL", provider=self.name)
                    downloaded = await client.get(item["url"])
                    check_response(downloaded, self.name)
                    output = downloaded.content
                return jpeg_bytes(output, source_size)
            except (ValueError, TypeError, KeyError, IndexError):
                raise ProviderError("grok returned an invalid response", provider=self.name) from None
