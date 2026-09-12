"""Provider protocol, sanitized errors, and a per-job retry/circuit controller."""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass
from typing import Protocol

import httpx
from PIL import Image, UnidentifiedImageError


class ImageEditor(Protocol):
    name: str

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 60.0,
    ) -> bytes: ...


class ProviderError(Exception):
    """Only fixed messages belong here: never include a provider response or URL."""

    def __init__(
        self, message: str, *, provider: str = "unknown", retryable: bool = True,
        rate_limited: bool = False, refusal: bool = False, attempts: int = 0,
        status: int | None = None, fatal: bool = False,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable
        self.rate_limited = rate_limited
        self.refusal = refusal
        self.attempts = attempts
        # The HTTP status is safe to keep and report: it is the difference between
        # "retry later" and "this key or model name will never work".
        self.status = status
        self.fatal = fatal


def check_response(response: httpx.Response, provider: str) -> None:
    if response.is_success:
        return
    status = response.status_code
    # Response bodies may contain request details, credentials, or image data,
    # so only the status code crosses this boundary. 401/403/404 mean a bad key,
    # a disabled API or a retired model name: retrying and failing over to a
    # second provider cannot help, and it hides the real cause behind timeouts.
    fatal = status in {400, 401, 403, 404}
    hint = {401: " (check GEMINI_API_KEY)", 403: " (key lacks access to this API)",
            404: " (model name unavailable — check GEMINI_IMAGE_MODEL / GEMINI_TEXT_MODEL)",
            400: " (malformed request or unsupported parameter)"}.get(status, "")
    raise ProviderError(
        f"{provider} returned HTTP {status}{hint}", provider=provider,
        retryable=status in {408, 409, 429} or status >= 500,
        rate_limited=status == 429, status=status, fatal=fatal,
    )


def jpeg_bytes(data: bytes, size: tuple[int, int] | None = None) -> bytes:
    """Validate provider image output and normalize it to the input geometry."""
    try:
        with Image.open(io.BytesIO(data)) as opened:
            if opened.width * opened.height > 50_000_000:
                raise ValueError("oversized image")
            image = opened.convert("RGB")
        if size is not None and image.size != size:
            image = image.resize(size, Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, "JPEG", quality=95, subsampling=0)
        return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError):
        raise ProviderError("Provider returned an invalid image") from None


@dataclass(frozen=True)
class EditResult:
    image: bytes
    provider: str
    attempts: int


class _CircuitOpen(Exception):
    """A queued primary invocation must be rerouted before any request is sent."""


def get_editor(name: str) -> ImageEditor:
    name = name.strip().lower()
    if name == "gemini":
        from .gemini import GeminiEditor
        return GeminiEditor()
    if name == "grok":
        from .grok import GrokImagineEditor
        return GrokImagineEditor()
    if name == "fal":
        from .fal import FalImg2ImgEditor
        return FalImg2ImgEditor()
    if name == "demo":
        from .demo import DemoEditor
        return DemoEditor()
    raise ValueError("PROVIDER must be demo, gemini, grok, or fal")


def _configured(editor: ImageEditor) -> bool:
    """Whether an editor could possibly succeed. Unknown editors are trusted."""
    key = getattr(editor, "api_key", "")
    return bool(key) if hasattr(editor, "api_key") else True


class EditorPool:
    """Share one instance across the anchor and tiles of one job.

    Three attempts per provider; waits are 1 s then 2 s (the 4 s backoff
    remains available if max_attempts is explicitly increased). A primary
    circuit stays open for the rest of the job after two failures or a 429.
    Demo is an explicit mode and is never an implicit live-provider fallback.
    """

    def __init__(
        self, primary: str | ImageEditor | None = None,
        fallback: str | ImageEditor | None = None, *, max_attempts: int = 3,
        backoff: tuple[float, ...] = (1.0, 2.0, 4.0),
    ) -> None:
        from app.config import settings

        selected = primary if primary is not None else settings.provider
        self.primary = get_editor(selected) if isinstance(selected, str) else selected
        fallback = fallback if fallback is not None else settings.provider_fallback
        self.fallback = get_editor(fallback) if isinstance(fallback, str) and fallback else fallback
        if self.fallback and (
            self.fallback.name == self.primary.name or self.primary.name == "demo"
            or self.fallback.name == "demo" or not _configured(self.fallback)
        ):
            # An unconfigured fallback is worse than no fallback: it cannot
            # succeed, and its "KEY is not configured" becomes the error the
            # manifest records, throwing away the primary's real status code.
            # A 429 from the primary then reads as a missing key for a provider
            # nobody was using. Drop it here so the diagnosis survives.
            self.fallback = None
        self.max_attempts = max(1, max_attempts)
        self.backoff = backoff
        self.image_calls = 0
        self.primary_open = False
        self._primary_failures = 0
        self._limited_providers: set[str] = set()
        self._limit = max(1, settings.max_concurrency)
        self._active = 0
        self._gate = asyncio.Condition()

    @property
    def max_concurrency(self) -> int:
        return self._limit

    async def _invoke(self, editor: ImageEditor, image: bytes, prompt: str, **kwargs) -> bytes:
        async with self._gate:
            await self._gate.wait_for(lambda: self._active < self._limit)
            # Another in-flight request can open the circuit while this caller
            # waits for capacity. Recheck here, immediately before dispatch.
            if editor is self.primary and self.primary_open and self.fallback:
                raise _CircuitOpen()
            self._active += 1
            self.image_calls += 1
        try:
            return await asyncio.wait_for(
                editor.edit(image, prompt, **kwargs), timeout=kwargs["timeout_s"],
            )
        except ProviderError as exc:
            if exc.provider == "unknown":
                exc.provider = editor.name
            raise
        except (TimeoutError, httpx.TimeoutException):
            raise ProviderError(f"{editor.name} timed out", provider=editor.name) from None
        except httpx.HTTPError:
            raise ProviderError(f"{editor.name} connection failed", provider=editor.name) from None
        except Exception:
            raise ProviderError(f"{editor.name} image edit failed", provider=editor.name) from None
        finally:
            async with self._gate:
                self._active -= 1
                self._gate.notify_all()

    async def edit(
        self, image: bytes, prompt: str, *, reference: bytes | None = None,
        strength: float | None = None, seed: int | None = None,
        negative: str | None = None, timeout_s: float = 60.0,
    ) -> EditResult:
        attempts = 0
        current_negative = negative
        providers = [self.primary] + ([self.fallback] if self.fallback else [])
        last_error = ProviderError("No image provider available", retryable=False)
        # A bad key, a disabled API or a retired model name is a configuration
        # fault, not an outage: failing over replaces the real cause with the
        # second provider's own error and makes the manifest useless.
        misconfigured = False
        for editor in providers:
            if misconfigured:
                break
            if editor is self.primary and self.primary_open and self.fallback:
                continue
            refusal_retried = False
            for attempt in range(self.max_attempts):
                if editor is self.primary and self.primary_open and self.fallback:
                    break
                attempts += 1
                try:
                    result = await self._invoke(
                        editor, image, prompt, reference=reference, strength=strength,
                        seed=seed, negative=current_negative, timeout_s=timeout_s,
                    )
                    if editor is self.primary:
                        self._primary_failures = 0
                    return EditResult(result, editor.name, attempts)
                except _CircuitOpen:
                    attempts -= 1  # Nothing was dispatched or billed.
                    break
                except ProviderError as exc:
                    last_error = exc
                    if exc.status in {401, 403, 404}:
                        misconfigured = True
                        break
                    if editor is self.primary:
                        self._primary_failures += 1
                        if self._primary_failures >= 2 or exc.rate_limited:
                            self.primary_open = True
                    if exc.rate_limited:
                        self._limited_providers.add(editor.name)
                        if self.fallback and self.primary.name in self._limited_providers and self.fallback.name in self._limited_providers:
                            self._limit = min(self._limit, 3)
                    if exc.refusal:
                        if refusal_retried:
                            break
                        refusal_retried = True
                        current_negative = None
                    elif not exc.retryable:
                        break
                    if editor is self.primary and self.primary_open and self.fallback:
                        break
                    if attempt + 1 < self.max_attempts and self.backoff:
                        await asyncio.sleep(self.backoff[min(attempt, len(self.backoff) - 1)])
        last_error.attempts = attempts
        raise last_error
