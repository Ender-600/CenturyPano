import asyncio
import base64
import io
from dataclasses import replace
from email import policy
from email.parser import BytesParser

import httpx
import pytest
from PIL import Image

from app import config
from app.editors.base import ProviderError
from app.editors.openai import OpenAIImageEditor, _output_size


MODEL = "gpt-image-2.5-sunburst"


def picture(size=(96, 48), color=(90, 135, 180), fmt="JPEG"):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, fmt)
    return output.getvalue()


def image_response(image=None):
    return httpx.Response(200, json={"data": [{
        "b64_json": base64.b64encode(image if image is not None else picture()).decode(),
    }]})


def editor(transport, **overrides):
    arguments = {"api_key": "test-only-key", "model": MODEL, "quality": "medium", "transport": transport}
    arguments.update(overrides)
    return OpenAIImageEditor(**arguments)


def multipart(request):
    raw = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + request.content
    parsed = BytesParser(policy=policy.default).parsebytes(raw)
    fields, files = {}, []
    for part in parsed.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if part.get_filename():
            files.append((name, part.get_filename(), part.get_content_type(), part.get_payload(decode=True)))
        else:
            fields[name] = part.get_payload(decode=True).decode()
    return fields, files


def test_openai_multi_image_request_and_normalization():
    source, reference = picture((1024, 1024)), picture((1024, 1024), color=(80, 90, 60))
    requests = []

    def respond(request):
        requests.append(request)
        return image_response(picture((640, 480), fmt="PNG"))

    output = asyncio.run(editor(httpx.MockTransport(respond)).edit(
        source, "One frozen panorama prompt", reference=reference, seed=47, strength=0.45, negative="LED signs",
    ))
    request = requests[0]
    fields, files = multipart(request)
    assert request.method == "POST"
    assert str(request.url) == "https://api.openai.com/v1/images/edits"
    assert request.headers["authorization"] == "Bearer test-only-key"
    assert fields["model"] == MODEL and fields["quality"] == "medium"
    assert fields["size"] == "1024x1024" and fields["n"] == "1"
    assert fields["output_format"] == "jpeg" and fields["background"] == "opaque"
    assert fields["prompt"].startswith("One frozen panorama prompt\n\n")
    assert "Image 2 is a style reference only" in fields["prompt"]
    assert "keeping image 1's composition" in fields["prompt"]
    assert "Avoid these visual elements: LED signs" in fields["prompt"]
    assert not {"seed", "strength", "input_fidelity", "response_format"} & fields.keys()
    assert files == [("image[]", "source.jpg", "image/jpeg", source), ("image[]", "anchor-reference.jpg", "image/jpeg", reference)]
    assert "test-only-key" not in str(request.url) and b"test-only-key" not in request.content
    with Image.open(io.BytesIO(output)) as decoded:
        assert decoded.size == (1024, 1024) and decoded.format == "JPEG"


def test_openai_anchor_preserves_wide_geometry():
    requests = []

    def respond(request):
        requests.append(request)
        return image_response(picture((1536, 1024)))

    source = picture((2389, 1024))
    output = asyncio.run(editor(httpx.MockTransport(respond), quality="xhigh").edit(source, "Anchor in 1925"))
    fields, files = multipart(requests[0])
    assert fields["size"] == "2384x1024" and fields["quality"] == "xhigh"
    assert len(files) == 1
    assert "Image 2" not in fields["prompt"] and "Avoid these visual elements" not in fields["prompt"]
    assert Image.open(io.BytesIO(output)).size == (2389, 1024)


@pytest.mark.parametrize("size", [(96, 48), (48, 96), (100, 100), (8000, 1000), (1000, 8000), (1, 1), (4000, 3000)])
def test_requested_sizes_obey_sunburst_limits(size):
    width, height = map(int, _output_size(size).split("x"))
    assert width % 16 == height % 16 == 0
    assert 1 / 3 <= width / height <= 3
    assert max(width, height) <= 3840
    assert 655_360 <= width * height <= 8_294_400


@pytest.mark.parametrize("payload", [
    {}, {"data": []}, {"data": [{"url": "https://untrusted.example/image.jpg"}]},
    {"data": [{"b64_json": "not-valid-base64!"}]}, {"data": [{"b64_json": ""}]},
    {"data": [{"b64_json": 45}]}, {"data": [{"b64_json": base64.b64encode(b"not an image").decode()}]},
])
def test_openai_invalid_output_is_sanitized(payload):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(transport).edit(picture(), "test"))
    assert caught.value.provider == "openai"
    assert "invalid image" in str(caught.value)
    assert "untrusted.example" not in str(caught.value)


@pytest.mark.parametrize("code", ["moderation_blocked", "content_policy_violation"])
def test_openai_refusal_can_trigger_prompt_remediation(code):
    transport = httpx.MockTransport(lambda _: httpx.Response(400, json={"error": {
        "type": "image_generation_user_error", "code": code, "message": "secret-key-and-image-data",
    }}))
    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(transport).edit(picture(), "test"))
    assert caught.value.refusal and caught.value.provider == "openai"
    assert "secret" not in str(caught.value)


def test_openai_rate_limit_enters_existing_fallback_logic():
    transport = httpx.MockTransport(lambda _: httpx.Response(429, json={"error": {"code": "rate_limit_exceeded"}}))
    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(transport).edit(picture(), "test"))
    assert caught.value.retryable and caught.value.rate_limited


def test_openai_exhausted_quota_is_not_retried_as_rate_limit():
    transport = httpx.MockTransport(lambda _: httpx.Response(429, json={"error": {"code": "insufficient_quota"}}))
    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(transport).edit(picture(), "test"))
    assert not caught.value.retryable and not caught.value.rate_limited


def test_openai_auth_error_hides_upstream_body():
    transport = httpx.MockTransport(lambda _: httpx.Response(401, text="secret upstream body"))
    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(transport).edit(picture(), "test"))
    assert str(caught.value) == "openai returned HTTP 401"
    assert not caught.value.retryable


def test_openai_missing_key_makes_no_request():
    requests = []

    def forbidden(request):
        requests.append(request)
        return image_response()

    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(httpx.MockTransport(forbidden), api_key="").edit(picture(), "test"))
    assert "OPENAI_API_KEY is not configured" in str(caught.value)
    assert not caught.value.retryable and requests == []


def test_openai_connection_timeout_is_sanitized():
    def timed_out(request):
        raise httpx.ReadTimeout("secret response detail", request=request)

    with pytest.raises(ProviderError) as caught:
        asyncio.run(editor(httpx.MockTransport(timed_out)).edit(picture(), "test", timeout_s=1.5))
    assert str(caught.value) == "openai timed out"
    assert caught.value.retryable


def test_openai_timeout_defaults_to_its_own_setting(monkeypatch):
    monkeypatch.setattr(config, "settings", replace(config.settings, openai_image_timeout_s=210.0))
    requests = []

    def respond(request):
        requests.append(request)
        return image_response()

    adapter = editor(httpx.MockTransport(respond))
    asyncio.run(adapter.edit(picture(), "test"))
    assert adapter.default_timeout_s == 210.0
    assert requests[0].extensions["timeout"]["read"] == 210.0
