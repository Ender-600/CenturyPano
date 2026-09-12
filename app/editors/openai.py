"""GPT Image 2.5 Sunburst editing via the official Images API.

Source first, optional style reference second; image output is normalized to the
source geometry for stitching. Provider responses and keys are never logged.
"""

from __future__ import annotations

import base64
import io
import math

import httpx
from PIL import Image, UnidentifiedImageError

from .base import ProviderError, check_response, jpeg_bytes


def _output_size(source_size: tuple[int, int]) -> str:
    """Preserve the source aspect within Sunburst's documented size bounds."""
    width, height = source_size
    rounded_w, rounded_h = max(16, round(width / 16) * 16), max(16, round(height / 16) * 16)
    if (
        max(rounded_w, rounded_h) <= 3840
        and 1 / 3 <= rounded_w / rounded_h <= 3
        and 655_360 <= rounded_w * rounded_h <= 8_294_400
    ):
        return f"{rounded_w}x{rounded_h}"
    # Pipeline tiles and anchors normally take the exact-size branch above.
    # For small probes or unusually large images, request ~1 MP at the nearest
    # supported aspect. Final normalization preserves the full input frame.
    ratio = min(3.0, max(1 / 3, width / height))
    requested_h = max(16, round(math.sqrt(1_048_576 / ratio) / 16) * 16)
    requested_w = max(16, round(requested_h * ratio / 16) * 16)
    return f"{requested_w}x{requested_h}"


def _check_openai_error(response: httpx.Response) -> None:
    """Use stable error codes only; never expose upstream error messages."""
    if response.is_success:
        return
    code = error_type = None
    try:
        body = response.json()
        error = body.get("error", {}) if isinstance(body, dict) else {}
        if isinstance(error, dict):
            code, error_type = error.get("code"), error.get("type")
            code = code if isinstance(code, str) else None
            error_type = error_type if isinstance(error_type, str) else None
    except (ValueError, TypeError):
        pass
    if code in {"moderation_blocked", "content_policy_violation"}:
        raise ProviderError("openai declined this image edit", provider="openai", refusal=True)
    if code in {"insufficient_quota", "billing_hard_limit_reached"} or error_type == "insufficient_quota":
        raise ProviderError("OpenAI API quota is unavailable", provider="openai", retryable=False)
    if error_type == "image_generation_user_error":
        raise ProviderError("OpenAI could not process this image edit", provider="openai", retryable=False)
    check_response(response, "openai")


class OpenAIImageEditor:
    name = "openai"

    def __init__(
        self, api_key: str | None = None, model: str | None = None,
        quality: str | None = None, *, transport=None,
    ) -> None:
        from app.config import settings

        self.api_key = api_key if api_key is not None else settings.openai_api_key
        self.model = model or settings.openai_image_model
        self.quality = quality or settings.openai_image_quality
        self.default_timeout_s = settings.openai_image_timeout_s
        if self.quality not in {"low", "medium", "high", "xhigh", "max", "auto"}:
            raise ValueError("OpenAI image quality must be low, medium, high, xhigh, max, or auto")
        self.transport = transport

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float | None = None,
    ) -> bytes:
        if not self.api_key:
            raise ProviderError("OPENAI_API_KEY is not configured", provider=self.name, retryable=False)
        try:
            with Image.open(io.BytesIO(image)) as source:
                source_size = source.size
        except (UnidentifiedImageError, OSError, ValueError):
            raise ProviderError("Invalid source image for OpenAI editing", provider=self.name, retryable=False) from None

        instructions = [
            prompt,
            "Edit image 1 only. Preserve image 1's exact viewpoint, composition, building geometry, "
            "horizon and full frame. Return one edited image without cropping, extending the scene, "
            "adding a border or creating a collage.",
        ]
        files = [("image[]", ("source.jpg", image, "image/jpeg"))]
        if reference is not None:
            files.append(("image[]", ("anchor-reference.jpg", reference, "image/jpeg")))
            instructions.append(
                "Image 2 is a style reference only. Match its era, lighting, palette and sky while "
                "keeping image 1's composition. Do not copy image 2's objects or layout into image 1."
            )
        if negative:
            instructions.append("Avoid these visual elements: " + negative)
        # Multipart image[] is the documented multi-image edit format. GPT Image
        # returns b64_json by default; seed, strength and response_format are not
        # supported parameters and must not be forwarded from the shared API.
        fields = {
            "model": self.model,
            "prompt": "\n\n".join(instructions),
            "n": "1",
            "size": _output_size(source_size),
            "quality": self.quality,
            "output_format": "jpeg",
            "background": "opaque",
        }
        try:
            request_timeout = self.default_timeout_s if timeout_s is None else timeout_s
            async with httpx.AsyncClient(timeout=request_timeout, transport=self.transport) as client:
                response = await client.post(
                    "https://api.openai.com/v1/images/edits",
                    headers={"Authorization": "Bearer " + self.api_key},
                    data=fields, files=files,
                )
        except httpx.TimeoutException:
            raise ProviderError("openai timed out", provider=self.name) from None
        except httpx.HTTPError:
            raise ProviderError("openai connection failed", provider=self.name) from None
        _check_openai_error(response)
        try:
            result = response.json()
            encoded = result["data"][0]["b64_json"]
            if not isinstance(encoded, str) or not encoded:
                raise ValueError("Missing base64 output")
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError, KeyError, IndexError):
            raise ProviderError("openai returned an invalid image response", provider=self.name) from None
        try:
            return jpeg_bytes(decoded, source_size)
        except ProviderError:
            raise ProviderError("openai returned an invalid image", provider=self.name) from None
