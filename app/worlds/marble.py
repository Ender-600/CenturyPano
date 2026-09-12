"""Small World Labs World API client; generation starts are never retried.

The caller persists accepted operation IDs and polls them independently. A lost
generation response cannot safely be treated as permission to submit again.
"""

from __future__ import annotations

import base64
import io
import math
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from PIL import Image, UnidentifiedImageError


_BASE_URL = "https://api.worldlabs.ai"
_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
_MODELS = {"marble-1.0-draft", "marble-1.0", "marble-1.1", "marble-1.1-plus"}
_MAX_INLINE_BYTES = 10 * 1024 * 1024


class MarbleError(Exception):
    """An error with safe, stable fields; contains no upstream body or request."""

    def __init__(
        self, message: str, *, code: str = "marble_error", status_code: int | None = None,
        retryable: bool = False, retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable
        self.retry_after_s = retry_after_s


class SubmissionUnknown(MarbleError):
    """A paid start may have been accepted; automatic resubmission is unsafe."""

    def __init__(self, *, status_code: int | None = None) -> None:
        super().__init__(
            "Marble submission outcome is unknown; do not automatically resubmit",
            code="submission_unknown", status_code=status_code,
        )


def _valid_id(value: Any) -> bool:
    return isinstance(value, str) and _ID_PATTERN.fullmatch(value) is not None


def _checked_id(value: Any) -> str:
    if not _valid_id(value):
        raise MarbleError("Invalid Marble resource ID", code="invalid_input")
    return value


def _finite_number(value: Any) -> bool:
    if type(value) not in (float, int):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _valid_text(value: Any, limit: int) -> bool:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        return False
    try:
        value.encode("utf-8")
    except UnicodeError:
        return False
    return True


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        seconds = float(value)
        return seconds if math.isfinite(seconds) and seconds >= 0 else None
    except ValueError:
        try:
            timestamp = parsedate_to_datetime(value)
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            return max(0.0, (timestamp - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def _invalid_response(*, submission: bool) -> MarbleError:
    if submission:
        return SubmissionUnknown()
    return MarbleError("Marble returned an invalid response", code="invalid_response")


def _operation(payload: dict[str, Any], *, submission: bool) -> dict[str, Any]:
    if not _valid_id(payload.get("operation_id")) or type(payload.get("done")) is not bool:
        raise _invalid_response(submission=submission)
    result = dict(payload)
    error = result.get("error")
    if error is not None:
        if not isinstance(error, dict):
            raise _invalid_response(submission=submission)
        # An operation can fail after its POST succeeded. Keep the error signal,
        # but never propagate a provider message that may echo private input.
        error_code = error.get("code")
        result["error"] = {
            "code": error_code if type(error_code) is int else None,
            "message": "Marble world generation failed",
        }
    return result


class MarbleClient:
    """Use as ``async with MarbleClient(key) as client``; all calls return dicts."""

    def __init__(
        self, api_key: str | None, *, transport: httpx.AsyncBaseTransport | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise MarbleError("WORLDLAB_API_KEY is not configured", code="missing_key")
        api_key = api_key.strip()
        if not api_key.isascii() or any(ord(char) < 33 or ord(char) > 126 for char in api_key):
            raise MarbleError("WORLDLAB_API_KEY has an invalid format", code="invalid_key")
        if not _finite_number(timeout_s) or timeout_s <= 0:
            raise MarbleError("Invalid Marble request timeout", code="invalid_input")
        self._client = httpx.AsyncClient(
            base_url=_BASE_URL,
            headers={"WLT-Api-Key": api_key, "Accept": "application/json"},
            timeout=timeout_s, transport=transport, follow_redirects=False, trust_env=False,
        )

    async def __aenter__(self) -> MarbleClient:
        await self._client.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_value, traceback) -> None:
        await self._client.__aexit__(exc_type, exc_value, traceback)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(
        self, method: str, path: str, *, payload: dict[str, Any] | None = None,
        submission: bool = False,
    ) -> dict[str, Any]:
        try:
            response = await self._client.request(method, path, json=payload)
        except httpx.HTTPError:
            if submission:
                raise SubmissionUnknown() from None
            raise MarbleError("Marble connection failed", code="transport_error", retryable=True) from None

        if not response.is_success:
            status = response.status_code
            if submission and status >= 500:
                raise SubmissionUnknown(status_code=status)
            raise MarbleError(
                f"Marble returned HTTP {status}", code="http_error", status_code=status,
                retryable=status == 429 or (not submission and status >= 500),
                retry_after_s=_retry_after(response.headers.get("Retry-After")),
            )
        try:
            result = response.json()
        except (ValueError, UnicodeError):
            raise _invalid_response(submission=submission) from None
        if not isinstance(result, dict):
            raise _invalid_response(submission=submission)
        return result

    async def credits(self) -> dict[str, Any]:
        result = await self._request("GET", "/marble/v1/credits")
        balance = result.get("remaining_credits")
        if not _finite_number(balance) or balance < 0:
            raise _invalid_response(submission=False)
        return result

    async def generate_image(
        self, image_bytes: bytes, prompt: str, display_name: str,
        model: str = "marble-1.0-draft", is_pano: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(image_bytes, bytes) or not 0 < len(image_bytes) <= _MAX_INLINE_BYTES:
            raise MarbleError("Marble requires a JPEG image of at most 10 MiB", code="invalid_input")
        try:
            with Image.open(io.BytesIO(image_bytes)) as source:
                if source.format != "JPEG":
                    raise ValueError("Not JPEG")
                if is_pano is True and source.width != 2 * source.height:
                    raise ValueError("Invalid panorama aspect ratio")
                source.verify()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise MarbleError("Invalid JPEG image or panorama dimensions for Marble", code="invalid_input") from None
        if not _valid_text(prompt, 2000):
            raise MarbleError("Marble prompt must contain 1 to 2000 characters", code="invalid_input")
        if not _valid_text(display_name, 64):
            raise MarbleError("Marble display name must contain 1 to 64 characters", code="invalid_input")
        if not isinstance(model, str) or model not in _MODELS or type(is_pano) is not bool:
            raise MarbleError("Invalid Marble model or panorama flag", code="invalid_input")
        # The caller validates spherical coverage; a 2:1 aspect alone is not a
        # complete panorama. False is explicit for the M0 ordinary-photo probe.
        payload = {
            "display_name": display_name,
            "model": model,
            "permission": {"public": False},
            "world_prompt": {
                "type": "image",
                "image_prompt": {
                    "source": "data_base64",
                    "data_base64": base64.b64encode(image_bytes).decode("ascii"),
                    "extension": "jpg",
                },
                "is_pano": is_pano,
                "text_prompt": prompt,
                "disable_recaption": True,
            },
        }
        result = await self._request("POST", "/marble/v1/worlds:generate", payload=payload, submission=True)
        return _operation(result, submission=True)

    async def operation(self, operation_id: str) -> dict[str, Any]:
        operation_id = _checked_id(operation_id)
        result = await self._request("GET", f"/marble/v1/operations/{operation_id}")
        result = _operation(result, submission=False)
        if result["operation_id"] != operation_id:
            raise _invalid_response(submission=False)
        return result

    async def world(self, world_id: str) -> dict[str, Any]:
        world_id = _checked_id(world_id)
        result = await self._request("GET", f"/marble/v1/worlds/{world_id}")
        if "world" in result:
            result = result["world"]
        if not isinstance(result, dict):
            raise _invalid_response(submission=False)
        result = dict(result)
        returned_id = result.get("world_id", result.get("id"))
        if not _valid_id(returned_id) or returned_id != world_id:
            raise _invalid_response(submission=False)
        result["world_id"] = returned_id
        return result
