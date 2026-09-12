import asyncio

import httpx
import pytest

from app.editors.base import EditorPool, ProviderError, check_response


def _response(status: int) -> httpx.Response:
    return httpx.Response(status, request=httpx.Request("POST", "https://example.invalid/v1"), json={"error": "detail"})


@pytest.mark.parametrize("status,fatal,retryable", [
    (401, True, False), (403, True, False), (404, True, False), (400, True, False),
    (429, False, True), (500, False, True), (503, False, True),
])
def test_status_classification_and_safe_message(status, fatal, retryable):
    with pytest.raises(ProviderError) as raised:
        check_response(_response(status), "gemini")
    error = raised.value
    assert error.status == status
    assert error.fatal is fatal and error.retryable is retryable
    message = str(error)
    assert f"HTTP {status}" in message and "gemini" in message
    # The provider body must never cross the boundary.
    assert "detail" not in message


class _Failing:
    def __init__(self, name, status):
        self.name = name
        self.status = status
        self.calls = 0

    async def edit(self, image, prompt, **kwargs):
        self.calls += 1
        check_response(_response(self.status), self.name)


class _Working:
    name = "fal"

    def __init__(self):
        self.calls = 0

    async def edit(self, image, prompt, **kwargs):
        self.calls += 1
        return b"jpeg"


def test_retired_model_reports_gemini_and_never_calls_the_fallback():
    primary, fallback = _Failing("gemini", 404), _Working()
    pool = EditorPool(primary=primary, fallback=fallback, backoff=())
    with pytest.raises(ProviderError) as raised:
        asyncio.run(pool.edit(b"image", "prompt"))
    assert raised.value.provider == "gemini" and raised.value.status == 404
    assert "GEMINI_IMAGE_MODEL" in str(raised.value)
    assert primary.calls == 1, "a retired model name must not be retried"
    assert fallback.calls == 0, "a configuration fault must not fail over"


def test_server_error_still_fails_over_to_the_second_provider():
    primary, fallback = _Failing("gemini", 503), _Working()
    pool = EditorPool(primary=primary, fallback=fallback, backoff=())
    result = asyncio.run(pool.edit(b"image", "prompt"))
    assert result.provider == "fal" and fallback.calls == 1
    assert primary.calls > 1, "a transient outage should be retried before failing over"
