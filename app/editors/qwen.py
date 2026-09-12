"""DashScope Qwen image editing via multimodal-generation REST API."""

from __future__ import annotations

import base64
import io
from urllib.parse import urlparse

import httpx
from PIL import Image

from .base import ProviderError, check_response, jpeg_bytes


def dashscope_generation_url(compatible_base: str) -> str:
    root = compatible_base.split("/compatible-mode", 1)[0].rstrip("/")
    if not root:
        root = "https://dashscope.aliyuncs.com"
    return root + "/api/v1/services/aigc/multimodal-generation/generation"


def _data_url(image: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(image).decode("ascii")


class QwenImageEditor:
    name = "qwen"

    def __init__(self, api_key: str | None = None, model: str | None = None, *, transport=None):
        from app.config import settings

        self.api_key = api_key if api_key is not None else settings.k2_api_key
        self.model = model or settings.qwen_image_model
        self.endpoint = dashscope_generation_url(settings.k2_base_url)
        self.transport = transport

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 90.0,
        structure_lock: bool = False,
    ) -> bytes:
        del strength, seed  # Not supported by this DashScope endpoint.
        if not self.api_key:
            raise ProviderError("K2_API_KEY is not configured for qwen", provider=self.name, retryable=False)
        with Image.open(io.BytesIO(image)) as source:
            source_size = source.size
        content: list[dict] = [{"image": _data_url(image)}]
        instruction = prompt
        if structure_lock and not reference:
            instruction = (
                prompt
                + " Keep the camera framing fixed. Historical reconstruction may reshape, remove or "
                "replace buildings and roads when the prompt requires it; keep major masses in "
                "broadly similar positions so neighbouring panorama tiles can stitch."
            )
        if reference:
            content.append({"image": _data_url(reference)})
            if structure_lock:
                instruction = (
                    prompt
                    + " Edit image 1 using the reconstruction prompt. Match the lighting, palette and sky "
                    "of image 2. Keep image 1's camera framing; allow historically justified removals and "
                    "replacements, but keep major masses in broadly similar positions so neighbouring "
                    "tiles agree. Image 2 is a consistency reference, not historical evidence. "
                    "Return only the edited image 1."
                )
            else:
                instruction = (
                    prompt
                    + " Edit image 1 using the exact date and site history in the reconstruction prompt. "
                    "Match the lighting, palette and sky of image 2. Keep image 1's composition and camera "
                    "projection, but remove or replace buildings and roads when the historical context "
                    "requires it. Image 2 is a consistency reference, not historical evidence. "
                    "Return only the edited image 1."
                )
        if negative:
            instruction += " Avoid these visual elements: " + negative
        content.append({"text": instruction})
        payload = {
            "model": self.model,
            "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": {
                "n": 1,
                "watermark": False,
                "prompt_extend": False,
                "size": f"{source_size[0]}*{source_size[1]}",
            },
        }
        async with httpx.AsyncClient(timeout=timeout_s, transport=self.transport) as client:
            response = await client.post(
                self.endpoint,
                headers={"Authorization": "Bearer " + self.api_key, "Content-Type": "application/json"},
                json=payload,
            )
            check_response(response, self.name)
            try:
                data = response.json()
                parts = data["output"]["choices"][0]["message"]["content"]
                image_url = next(part["image"] for part in parts if isinstance(part, dict) and part.get("image"))
            except (ValueError, TypeError, KeyError, IndexError, StopIteration):
                raise ProviderError("qwen returned an invalid response", provider=self.name) from None
            if image_url.startswith("data:image/") and ";base64," in image_url:
                output = base64.b64decode(image_url.split(",", 1)[1], validate=True)
                return jpeg_bytes(output, source_size)
            parsed = urlparse(image_url)
            host = (parsed.hostname or "").lower()
            allowed = host.endswith(".aliyuncs.com") or host.endswith(".aliyun.com")
            if parsed.scheme != "https" or parsed.username or parsed.password or not allowed:
                raise ProviderError("qwen returned an unsupported image URL", provider=self.name)
            downloaded = await client.get(image_url)
            check_response(downloaded, self.name)
            return jpeg_bytes(downloaded.content, source_size)
