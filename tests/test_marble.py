import base64
import io
import json
import traceback

import httpx
import pytest
from PIL import Image

from app.worlds.marble import MarbleClient, MarbleError, SubmissionUnknown


KEY = "test-only-private-key"
PRIVATE = "private input https://private.example/image?token=secret"


def jpeg(size=(96, 48)):
    output = io.BytesIO()
    Image.new("RGB", size, (60, 90, 130)).save(output, "JPEG")
    return output.getvalue()


def accepted(**overrides):
    return {"operation_id": "op-123", "done": False, "error": None, **overrides}


def assert_safe(error):
    rendered = "".join(traceback.format_exception(error))
    assert KEY not in rendered
    assert PRIVATE not in rendered
    assert "private.example" not in rendered
    assert "token=secret" not in rendered


@pytest.mark.asyncio
async def test_generation_matches_official_inline_image_schema():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=accepted())

    image = jpeg()
    async with MarbleClient(KEY, transport=httpx.MockTransport(respond)) as client:
        result = await client.generate_image(image, "Pittsburgh street in 1925", "Probe")
    assert result == accepted()
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.worldlabs.ai/marble/v1/worlds:generate"
    assert request.headers["WLT-Api-Key"] == KEY
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == {
        "display_name": "Probe",
        "model": "marble-1.0-draft",
        "permission": {"public": False},
        "world_prompt": {
            "type": "image",
            "image_prompt": {
                "source": "data_base64", "extension": "jpg",
                "data_base64": base64.b64encode(image).decode(),
            },
            "text_prompt": "Pittsburgh street in 1925",
            "is_pano": False,
            "disable_recaption": True,
        },
    }
    assert KEY.encode() not in request.content and KEY not in str(request.url)


@pytest.mark.asyncio
async def test_explicit_pano_and_model_are_preserved():
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=accepted())

    async with MarbleClient(KEY, transport=httpx.MockTransport(respond)) as client:
        await client.generate_image(jpeg(), "Historical scene", "Pano", model="marble-1.1", is_pano=True)
    assert requests[0]["world_prompt"]["is_pano"] is True
    assert requests[0]["model"] == "marble-1.1"


@pytest.mark.asyncio
async def test_credits_operation_and_wrapped_world_preserve_optional_asset_variants():
    requests = []
    world = {
        "id": "world-123", "model": "marble-1.0-draft",
        "assets": {"splats": {"spz_urls": {"unlisted-size": "https://assets.example/world.spz"}}},
    }

    def respond(request):
        requests.append(request)
        if request.url.path.endswith("credits"):
            return httpx.Response(200, json={"remaining_credits": 150.5})
        if "/operations/" in request.url.path:
            return httpx.Response(200, json=accepted(done=True, response=world, cost={"total_credits": 150}))
        return httpx.Response(200, json={"world": world})

    async with MarbleClient(KEY, timeout_s=5.0, transport=httpx.MockTransport(respond)) as client:
        assert await client.credits() == {"remaining_credits": 150.5}
        operation = await client.operation("op-123")
        assert operation["done"] and operation["cost"]["total_credits"] == 150
        result = await client.world("world-123")
    assert result["world_id"] == "world-123"
    assert result["assets"] == world["assets"]
    assert [request.url.path for request in requests] == [
        "/marble/v1/credits", "/marble/v1/operations/op-123", "/marble/v1/worlds/world-123",
    ]
    for request in requests:
        assert request.method == "GET"
        assert request.url.host == "api.worldlabs.ai" and request.url.scheme == "https"
        assert request.headers["WLT-Api-Key"] == KEY
        assert request.extensions["timeout"]["read"] == 5.0


@pytest.mark.asyncio
async def test_world_can_have_no_assets_yet():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"world_id": "w1", "assets": None}))
    async with MarbleClient(KEY, transport=transport) as client:
        assert await client.world("w1") == {"world_id": "w1", "assets": None}


@pytest.mark.asyncio
async def test_completed_operation_error_is_sanitized():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=accepted(
        done=True, error={"code": 13, "message": PRIVATE + KEY, "request": PRIVATE},
    )))
    async with MarbleClient(KEY, transport=transport) as client:
        result = await client.operation("op-123")
    assert result["error"] == {"code": 13, "message": "Marble world generation failed"}
    assert PRIVATE not in str(result) and KEY not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("response", [
    httpx.Response(500, text=PRIVATE + KEY),
    httpx.Response(503, json={"detail": PRIVATE + KEY}),
    httpx.Response(200, text="not JSON " + PRIVATE),
    httpx.Response(204),
    httpx.Response(200, json=[accepted()]),
    httpx.Response(200, json={"done": False}),
    httpx.Response(200, json=accepted(operation_id="../" + PRIVATE)),
    httpx.Response(200, json=accepted(done=0)),
    httpx.Response(200, json=accepted(done="false")),
    httpx.Response(200, json=accepted(error=PRIVATE)),
])
async def test_paid_submission_uncertainty_is_never_retried(response):
    requests = []

    def respond(request):
        requests.append(request)
        return response

    async with MarbleClient(KEY, transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(SubmissionUnknown) as caught:
            await client.generate_image(jpeg(), "Era", "Probe")
    assert len(requests) == 1
    assert caught.value.code == "submission_unknown" and not caught.value.retryable
    assert_safe(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [httpx.ConnectError, httpx.ReadTimeout, httpx.WriteError])
async def test_post_transport_errors_are_unknown_and_get_errors_retryable(error_type):
    requests = []

    def fail(request):
        requests.append(request)
        raise error_type(PRIVATE + KEY, request=request)

    async with MarbleClient(KEY, transport=httpx.MockTransport(fail)) as client:
        with pytest.raises(SubmissionUnknown) as paid:
            await client.generate_image(jpeg(), "Era", "Probe")
        with pytest.raises(MarbleError) as read:
            await client.credits()
    assert len(requests) == 2
    assert read.value.code == "transport_error" and read.value.retryable
    assert not isinstance(read.value, SubmissionUnknown)
    assert_safe(paid.value)
    assert_safe(read.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 402, 403, 422, 429])
async def test_explicit_rejections_are_safe_and_not_unknown(status):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, json={"detail": PRIVATE + KEY}, headers={"Retry-After": "12"})

    async with MarbleClient(KEY, transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(MarbleError) as caught:
            await client.generate_image(jpeg(), "Era", "Probe")
    assert not isinstance(caught.value, SubmissionUnknown)
    assert caught.value.status_code == status
    assert caught.value.retryable == (status == 429)
    assert caught.value.retry_after_s == 12
    assert len(requests) == 1
    assert_safe(caught.value)


@pytest.mark.asyncio
async def test_redirect_is_not_followed_and_key_is_not_forwarded():
    requests = []

    def redirect(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": PRIVATE})

    async with MarbleClient(KEY, transport=httpx.MockTransport(redirect)) as client:
        with pytest.raises(MarbleError) as caught:
            await client.credits()
    assert len(requests) == 1
    assert caught.value.status_code == 307
    assert_safe(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("header", [PRIVATE, "NaN", "inf", "-1"])
async def test_bad_retry_after_is_ignored(header):
    transport = httpx.MockTransport(lambda _: httpx.Response(429, headers={"Retry-After": header}))
    async with MarbleClient(KEY, transport=transport) as client:
        with pytest.raises(MarbleError) as caught:
            await client.credits()
    assert caught.value.retry_after_s is None
    assert_safe(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{}, [], {"remaining_credits": True}, {"remaining_credits": "150"},
                                         {"remaining_credits": -1}, {"remaining_credits": None},
                                         {"remaining_credits": 10 ** 400}])
async def test_invalid_credits_response(payload):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    async with MarbleClient(KEY, transport=transport) as client:
        with pytest.raises(MarbleError, match="invalid response"):
            await client.credits()


@pytest.mark.asyncio
async def test_bad_get_json_and_server_error_are_not_paid_submission_unknown():
    responses = iter([httpx.Response(200, text=PRIVATE), httpx.Response(503, text=PRIVATE)])
    transport = httpx.MockTransport(lambda _: next(responses))
    async with MarbleClient(KEY, transport=transport) as client:
        with pytest.raises(MarbleError) as malformed:
            await client.operation("op-123")
        with pytest.raises(MarbleError) as failed:
            await client.world("world-123")
    assert malformed.value.code == "invalid_response"
    assert failed.value.retryable
    assert not isinstance(failed.value, SubmissionUnknown)
    assert_safe(malformed.value)
    assert_safe(failed.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{}, {"world": []}, {"world": {}}, {"world_id": "another-world"}])
async def test_world_id_must_match_requested_resource(payload):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
    async with MarbleClient(KEY, transport=transport) as client:
        with pytest.raises(MarbleError, match="invalid response"):
            await client.world("world-123")


@pytest.mark.asyncio
async def test_operation_id_must_match_requested_resource():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=accepted(operation_id="another-op")))
    async with MarbleClient(KEY, transport=transport) as client:
        with pytest.raises(MarbleError, match="invalid response"):
            await client.operation("op-123")


@pytest.mark.parametrize("key", [None, "", "  ", "key\r\ninjected: header", "非ASCII"])
def test_missing_or_invalid_key_is_rejected_before_request(key):
    with pytest.raises(MarbleError) as caught:
        MarbleClient(key, transport=httpx.MockTransport(lambda _: pytest.fail("Unexpected request")))
    assert caught.value.code in {"missing_key", "invalid_key"}
    assert not caught.value.retryable


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_id", ["", "..", "a/b", "a?key=secret", "a#fragment", "https://evil.test", "a%2Fb", "a" * 129, None])
async def test_resource_ids_cannot_change_endpoint(resource_id):
    transport = httpx.MockTransport(lambda _: pytest.fail("Unexpected request"))
    async with MarbleClient(KEY, transport=transport) as client:
        for method in (client.operation, client.world):
            with pytest.raises(MarbleError) as caught:
                await method(resource_id)
            assert caught.value.code == "invalid_input"


@pytest.mark.asyncio
@pytest.mark.parametrize("overrides", [
    {"image_bytes": b""}, {"image_bytes": PRIVATE.encode()}, {"image_bytes": b"a" * (10 * 1024 * 1024 + 1)},
    {"prompt": ""}, {"prompt": "a" * 2001}, {"prompt": "unpaired\ud800"},
    {"display_name": ""}, {"display_name": "a" * 65}, {"display_name": "unpaired\ud800"},
    {"model": "https://evil.test"}, {"is_pano": "auto"}, {"is_pano": True, "image_bytes": jpeg((96, 96))},
])
async def test_invalid_inputs_fail_before_paid_request(overrides):
    arguments = {"image_bytes": jpeg(), "prompt": "Era", "display_name": "Probe", **overrides}
    transport = httpx.MockTransport(lambda _: pytest.fail("Unexpected request"))
    async with MarbleClient(KEY, transport=transport) as client:
        with pytest.raises(MarbleError) as caught:
            await client.generate_image(**arguments)
    assert caught.value.code == "invalid_input"


@pytest.mark.asyncio
async def test_context_manager_closes_transport_after_failure():
    class ClosingTransport(httpx.MockTransport):
        closed = False

        async def aclose(self):
            self.closed = True
            await super().aclose()

    transport = ClosingTransport(lambda _: httpx.Response(500))
    with pytest.raises(MarbleError):
        async with MarbleClient(KEY, transport=transport) as client:
            await client.credits()
    assert transport.closed


@pytest.mark.asyncio
async def test_depth_generation_uses_official_png_schema_and_fixed_endpoint():
    output = io.BytesIO()
    Image.new("L", (128, 64), 90).save(output, "PNG")
    data = output.getvalue()
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json=accepted())

    async with MarbleClient(KEY, transport=httpx.MockTransport(respond)) as client:
        await client.generate_depth(data, "A street in 1925", z_min=.1, z_max=80)
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://api.worldlabs.ai/marble/v1/pano:depth_to_rgb"
    assert request.headers["WLT-Api-Key"] == KEY
    assert json.loads(request.content) == {
        "depth_pano_image": {"source": "data_base64", "extension": "png",
                             "data_base64": base64.b64encode(data).decode()},
        "text_prompt": "A street in 1925", "z_min": .1, "z_max": 80,
    }


@pytest.mark.asyncio
async def test_depth_rejects_invalid_inputs_before_charging_and_never_retries_unknown():
    output = io.BytesIO()
    Image.new("L", (128, 64), 90).save(output, "PNG")
    data = output.getvalue()
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, text=PRIVATE + KEY)

    async with MarbleClient(KEY, transport=httpx.MockTransport(respond)) as client:
        for z_min, z_max in [(0, 80), (80, 80), (90, 80), (.1, float("inf"))]:
            with pytest.raises(MarbleError) as caught:
                await client.generate_depth(data, "Era", z_min=z_min, z_max=z_max)
            assert caught.value.code == "invalid_input"
        with pytest.raises(MarbleError):
            await client.generate_depth(jpeg(), "Era", z_min=.1, z_max=80)
        assert not requests
        with pytest.raises(SubmissionUnknown) as caught:
            await client.generate_depth(data, "Era", z_min=.1, z_max=80)
    assert len(requests) == 1
    assert_safe(caught.value)
