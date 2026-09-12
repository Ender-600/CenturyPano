import base64
from dataclasses import replace
from email import policy
from email.parser import BytesParser
import io
import json

import httpx
from PIL import Image
import pytest

from app import config
from app.worlds import panorama
from app.worlds.panorama import (
    HistoricalPanoramaEditor, PanoramaEditError, PanoramaSubmissionUnknown, panorama_prompt,
)


def image(size=(1024, 512), format="JPEG", *, orientation=1, color=(77, 103, 87)):
    stream = io.BytesIO()
    options = {}
    if orientation != 1:
        exif = Image.Exif()
        exif[274] = orientation
        options["exif"] = exif
    Image.new("RGB", size, color).save(stream, format=format, **options)
    return stream.getvalue()


@pytest.fixture
def source():
    return image()


def success(data, **extra):
    return {"data": [{"b64_json": base64.b64encode(data).decode()}], **extra}


def multipart(request):
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + request.headers["content-type"].encode()
        + b"\r\nMIME-Version: 1.0\r\n\r\n" + request.content,
    )
    parts = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        parts[name] = part
    return parts


async def test_exact_model_multipart_projection_rules_and_original_output_bytes(source, monkeypatch):
    calls, client_options = [], []
    output = image((1152, 576), "PNG", color=(120, 65, 40))
    model = "gpt-image-2.5-sunburst-2026-09-08"

    async def handler(request):
        await request.aread()
        calls.append(request)
        return httpx.Response(200, json=success(output))

    real_client = httpx.AsyncClient

    def configured_client(**kwargs):
        client_options.append(kwargs)
        return real_client(**kwargs)

    monkeypatch.setattr(panorama.httpx, "AsyncClient", configured_client)
    editor = HistoricalPanoramaEditor("offline-key", model, "xhigh", transport=httpx.MockTransport(handler))
    result = await editor.edit(source, "Remove the modern tower if visible; preserve the source camera.")
    assert len(calls) == 1
    request = calls[0]
    assert str(request.url) == "https://api.openai.com/v1/images/edits"
    assert request.method == "POST" and request.headers["authorization"] == "Bearer offline-key"
    assert client_options[0]["trust_env"] is False
    assert client_options[0]["follow_redirects"] is False
    parts = multipart(request)
    fields = {key: value.get_payload(decode=True).decode() for key, value in parts.items() if key != "image[]"}
    assert fields["model"] == model
    assert fields["quality"] == "xhigh"
    assert fields["n"] == "1" and fields["output_format"] == "jpeg"
    width, height = map(int, fields["size"].split("x"))
    assert width == 2 * height and width % 16 == height % 16 == 0
    assert 655_360 <= width * height <= 8_294_400 and width <= 3840
    assert set(fields) == {"model", "quality", "n", "size", "output_format", "background", "prompt"}
    assert "do not freeze building geometry" in fields["prompt"]
    assert "Remove the modern tower if visible" in fields["prompt"]
    assert "full 360-by-180-degree equirectangular" in fields["prompt"]
    assert "camera height" in fields["prompt"] and "continuous seam" in fields["prompt"]
    assert parts["image[]"].get_filename() == "panorama.jpg"
    assert parts["image[]"].get_content_type() == "image/jpeg"
    assert parts["image[]"].get_payload(decode=True) == source
    assert result == {"image_bytes": output, "model": model, "usage": None}
    assert not hasattr(editor, "fallback")


@pytest.mark.parametrize("size", [(1234, 617), (64, 32), (4000, 2000)])
async def test_requested_output_dimensions_stay_exactly_two_to_one(size):
    requests = []

    async def handler(request):
        await request.aread()
        requests.append(request)
        return httpx.Response(200, json=success(image()))

    payload = image(size)
    await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(payload, "Edit the era.")
    parts = multipart(requests[0])
    width, height = map(int, parts["size"].get_payload(decode=True).decode().split("x"))
    assert width == 2 * height
    assert width % 16 == height % 16 == 0
    assert width <= 3840 and 655_360 <= width * height <= 8_294_400
    assert parts["image[]"].get_payload(decode=True) == payload


@pytest.mark.parametrize(("payload", "code"), [
    (b"not a photo", "invalid_image"),
    (image(format="PNG"), "invalid_image"),
    (image((1024, 768)), "invalid_aspect"),
    (image((4096, 2048)), "image_too_large"),
    (image(orientation=6), "unsupported_orientation"),
    (image()[:-70], "invalid_image"),
    (b"a" * (panorama.MAX_INPUT_BYTES + 1), "image_too_large"),
])
async def test_invalid_input_is_rejected_before_any_post(payload, code):
    calls = []

    async def handler(request):
        calls.append(request)
        raise AssertionError("Invalid input must not reach the network")

    with pytest.raises(PanoramaEditError) as caught:
        await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(payload, "1925")
    assert not isinstance(caught.value, PanoramaSubmissionUnknown)
    assert caught.value.code == code and calls == []


@pytest.mark.parametrize("status", [400, 401, 403, 404, 413, 422, 429])
async def test_definitive_rejections_are_sanitized_and_never_retried(source, status):
    calls = []
    secret = "private-key-that-must-never-appear"

    async def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": secret, "code": secret}})

    with pytest.raises(PanoramaEditError) as caught:
        await HistoricalPanoramaEditor(secret, transport=httpx.MockTransport(handler)).edit(source, "1925")
    assert not isinstance(caught.value, PanoramaSubmissionUnknown)
    assert caught.value.status_code == status and len(calls) == 1
    assert secret not in str(caught.value) + repr(caught.value) + repr(vars(caught.value))


@pytest.mark.parametrize("status", [302, 408, 500, 503])
async def test_redirects_timeouts_and_server_failures_are_unknown_without_retry(source, status):
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(status, headers={"Location": "https://untrusted.example/steal"}, content=b"private body")

    with pytest.raises(PanoramaSubmissionUnknown) as caught:
        await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(source, "1925")
    assert caught.value.code == "submission_unknown"
    assert caught.value.status_code == status and len(calls) == 1
    assert "private" not in str(caught.value) and "untrusted" not in str(caught.value)


@pytest.mark.parametrize("error_type", [httpx.ReadTimeout, httpx.ConnectError, httpx.RemoteProtocolError])
async def test_connection_uncertainty_is_not_retried(source, error_type):
    calls = []

    async def handler(request):
        calls.append(request)
        raise error_type("secret response URL and key", request=request)

    with pytest.raises(PanoramaSubmissionUnknown) as caught:
        await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(source, "1925")
    assert len(calls) == 1 and caught.value.status_code is None
    assert "secret" not in str(caught.value)


@pytest.mark.parametrize("body", [
    {}, {"data": []}, {"data": [None]}, {"data": [{"b64_json": 123}]},
    {"data": [{"b64_json": "private-key%%%"}]},
    {"data": [{"url": "https://untrusted.example/private"}]},
    success(image((1024, 768))), success(image((512, 256), "GIF")),
    success(b"broken image"), {"data": [{"b64_json": "a"}, {"b64_json": "b"}]},
])
async def test_invalid_success_never_becomes_a_cropped_stretched_or_retried_panorama(source, body):
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(200, json=body)

    with pytest.raises(PanoramaSubmissionUnknown) as caught:
        await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(source, "1925")
    assert len(calls) == 1 and caught.value.status_code == 200
    assert "private" not in str(caught.value)


async def test_success_body_stream_has_a_hard_limit(source, monkeypatch):
    monkeypatch.setattr(panorama, "MAX_RESPONSE_BYTES", 64)

    class LargeBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"a" * 40
            yield b"b" * 40
            raise AssertionError("Reading must stop once the size limit is reached")

    async def handler(_request):
        return httpx.Response(200, stream=LargeBody())

    with pytest.raises(PanoramaSubmissionUnknown):
        await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(source, "1925")


async def test_usage_keeps_only_reported_nonnegative_token_fields_without_invented_totals(source):
    unsafe_usage = {"input_tokens": 100, "output_tokens": 200, "total_tokens": -1, "cost_usd": 99,
                    "api_key": "private", "input_tokens_details": {"text_tokens": 20, "image_tokens": 80,
                    "cached_tokens": True, "url": "private", "cached_tokens_details": {"text_tokens": 5, "image_tokens": -2}},
                    "output_tokens_details": {"text_tokens": float("nan"), "image_tokens": 200, "secret": "private"}}

    async def handler(_request):
        return httpx.Response(200, content=json.dumps(success(source, usage=unsafe_usage)).encode())

    result = await HistoricalPanoramaEditor("test", transport=httpx.MockTransport(handler)).edit(source, "1925")
    assert result["usage"] == {"input_tokens": 100, "output_tokens": 200,
                               "input_tokens_details": {"text_tokens": 20, "image_tokens": 80,
                                                        "cached_tokens_details": {"text_tokens": 5}},
                               "output_tokens_details": {"image_tokens": 200}}
    assert "total_tokens" not in result["usage"]


async def test_settings_are_frozen_without_substituting_requested_model(source, monkeypatch):
    monkeypatch.setattr(config, "settings", replace(config.settings, openai_api_key="test-settings-key",
                        world_openai_image_model="gpt-image-2.5-sunburst-2026-09-08", openai_image_quality="high",
                        openai_image_timeout_s=210))
    editor = HistoricalPanoramaEditor()
    assert editor.model == "gpt-image-2.5-sunburst-2026-09-08" and editor.timeout_s == 210
    assert editor.quality == "high"
    with pytest.raises(PanoramaEditError, match="configuration"):
        HistoricalPanoramaEditor(model="")
    with pytest.raises(PanoramaEditError, match="configuration"):
        HistoricalPanoramaEditor(quality="unsupported")
    with pytest.raises(PanoramaEditError) as caught:
        await HistoricalPanoramaEditor(api_key="").edit(source, "1925")
    assert caught.value.code == "not_configured"


def test_prompt_uses_actual_source_camera_and_conditional_curated_rules_without_geometry_lock():
    plan = {"input_kind": "streetview_panorama", "target_year": 1925,
            "location": {"lat": 1.1, "lon": 2.2}, "camera_location": {"lat": 48.86, "lon": 2.35},
            "source_panorama": {"metadata": {"lat": 40.4433, "lon": -79.9436, "api_key": "SECRET"}},
            "history_context": {"location": {"city": "Paris", "country": "France"},
                                "period_summary": "Interwar street life.", "uncertainties": ["Earlier lot use unknown."],
                                "curated_site_rules": [
                                    {"name": "Modern Tower", "action": "remove_if_visible", "reason": "Opened in 1980."},
                                    {"name": "Old Hall", "action": "predates_target", "reason": "Completed in 1880."},
                                    {"name": "Unknown Shop", "action": "unknown", "reason": "No dated outline."},
                                ]},
            "changes": [{"label": "Duplicate should not be added", "action": "remove"}]}
    prompt = panorama_prompt(plan)
    assert "Paris, France in 1925" in prompt
    assert "latitude 48.860000, longitude 2.350000" in prompt
    assert "latitude 1.100000" not in prompt and "40.443300" not in prompt
    assert "If Modern Tower is actually visible" in prompt
    assert "remove its anachronistic completed modern structure" in prompt
    assert "If Old Hall is visible" in prompt and "Unknown Shop remains uncertain" in prompt
    assert "do not add absent buildings" in prompt and "does not prove an empty lot" in prompt
    assert "Duplicate should not be added" not in prompt
    assert "Carnegie" not in prompt and "CMU" not in prompt and "SECRET" not in prompt
    assert "Interwar street life" in prompt and "Earlier lot use unknown" in prompt


def test_prompt_reads_prose_and_changes_without_serializing_arbitrary_metadata():
    prompt = panorama_prompt({"target_year": 1895, "camera_location": {"lat": 51.5, "lon": -0.1},
        "history_context": {"location": {"city": "London"}, "era_facts": ["Horse-drawn traffic"],
                            "site_history": "An industrial district.", "api_key": "SECRET"},
        "modern_buildings": [{"id": "tower", "label": "Tower"}],
        "changes": [{"building_id": "tower", "action": "remove", "reason": "Built later. https://private.example/key"}]})
    assert "London in 1895" in prompt and "Horse-drawn traffic" in prompt
    assert "If Tower is actually visible" in prompt
    assert "https://" not in prompt and "SECRET" not in prompt
    assert "industrial district" in prompt


def test_explicit_context_place_name_precedes_city_and_keeps_actual_camera():
    supplied_name = "Carnegie Institute of Technology campus, Pittsburgh"
    plan = {"target_year": 1925, "camera_location": {"lat": 40.4433, "lon": -79.9436},
            "history_context": {"place_name": supplied_name, "location": {"city": "Fallback city"}}}
    prompt = panorama_prompt(plan)
    assert f"of {supplied_name} in 1925" in prompt
    assert "Fallback city" not in prompt
    assert "latitude 40.443300, longitude -79.943600" in prompt
    # The value comes from scoped context, rather than a campus-specific template.
    plan["history_context"]["place_name"] = "A separately documented site"
    assert "A separately documented site" in panorama_prompt(plan)
    assert "Carnegie" not in panorama_prompt(plan)
    plan["history_context"]["place_name"] = "A" * 200
    bounded = panorama_prompt(plan)
    assert "A" * 180 in bounded and "A" * 181 not in bounded
    plan["history_context"]["place_name"] = ""
    assert "Fallback city" in panorama_prompt(plan)


@pytest.mark.parametrize("value", [None, {}, {"target_year": True}, {"target_year": "1925"}])
def test_invalid_plan_does_not_generate_a_default_historical_place(value):
    with pytest.raises(PanoramaEditError) as caught:
        panorama_prompt(value)
    assert caught.value.code == "invalid_plan"
