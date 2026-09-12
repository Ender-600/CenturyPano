import asyncio
import io
import json
import traceback
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from PIL import Image

from app.worlds import streetview
from app.worlds.streetview import GoogleStreetViewClient, StreetViewError, streetview_url


KEY = "test-google-secret-key"
SESSION = "test-session-secret"
LAT, LON = 40.4433, -79.9436


def metadata(**overrides):
    return {
        "panoId": "pano-cmu", "lat": LAT + 0.0001, "lng": LON,
        "imageWidth": 13312, "imageHeight": 6656, "tileWidth": 512, "tileHeight": 512,
        "heading": 94.35, "tilt": 88.4, "roll": 1.7,
        "date": "2026-01", "copyright": "© 2026 Google",
        "reportProblemLink": "https://cbks0.googleapis.com/cbk?output=report&panoid=pano-cmu&hl=en-US",
        **overrides,
    }


def image_bytes(color=(10, 60, 120), size=(512, 512)):
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, "PNG")
    return output.getvalue()


def responder(requests, *, meta=None, failure=None):
    def handle(request):
        requests.append(request)
        if request.url.path.endswith("createSession"):
            return httpx.Response(200, json={"session": SESSION, "expiry": "9999999999"})
        if request.url.path.endswith("metadata"):
            return httpx.Response(200, content=json.dumps(metadata() if meta is None else meta).encode())
        if failure:
            return failure
        return httpx.Response(200, content=image_bytes(), headers={"content-type": "image/png"})
    return handle


def assert_safe(error):
    rendered = "".join(traceback.format_exception(error))
    assert KEY not in rendered and SESSION not in rendered and "evil.example" not in rendered


@pytest.mark.asyncio
async def test_exact_google_contract_complete_panorama_and_separate_camera_location():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(responder(requests))) as client:
        result = await client.fetch_panorama(LAT, LON)
    assert len(requests) == 30
    assert json.loads(requests[0].content) == {
        "mapType": "streetview", "language": "en-US", "region": "US",
    }
    assert requests[0].method == "POST" and requests[0].url.path == "/v1/createSession"
    for request in requests:
        assert request.url.scheme == "https" and request.url.host == "tile.googleapis.com"
        assert request.url.params["key"] == KEY
    assert requests[1].url.params["lat"] == str(LAT)
    assert requests[1].url.params["lng"] == str(LON)
    assert requests[1].url.params["radius"] == "50"
    assert all(request.method == "GET" for request in requests[1:])
    meta = result["metadata"]
    assert meta["lat"] != meta["requested_lat"] == LAT
    assert 10 < meta["distance_m"] < 12
    assert meta["heading"] == 94.35 and meta["tilt"] == 88.4 and meta["roll"] == 1.7
    assert not meta["orientation_transform_applied"]
    assert meta["source_image_width"] == 13312 and meta["image_width"] == 3328
    assert meta["request_count"] == 30 and meta["zoom"] == 3
    assert "session" not in meta and KEY not in json.dumps(meta) and SESSION not in json.dumps(meta)
    assert "report_problem_link" in meta
    with Image.open(io.BytesIO(result["image_bytes"])) as image:
        assert image.format == "JPEG" and image.size == (3328, 1664)


@pytest.mark.asyncio
async def test_session_omits_image_format_rejected_by_live_streetview_service():
    requests = []
    fallback = responder(requests)

    def handle(request):
        if request.url.path.endswith("createSession"):
            payload = json.loads(request.content)
            if "imageFormat" in payload:
                requests.append(request)
                return httpx.Response(400, json={"error": {"message": "Invalid Value"}})
            assert payload == {"mapType": "streetview", "language": "en-US", "region": "US"}
            requests.append(request)
            return httpx.Response(200, json={"session": SESSION, "imageFormat": "jpeg"})
        return fallback(request)

    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(handle)) as client:
        result = await client.fetch_panorama(LAT, LON)
    assert "imageFormat" not in json.loads(requests[0].content)
    assert result["metadata"]["image_width"] == 3328


@pytest.mark.asyncio
async def test_metadata_extent_discards_only_right_and_bottom_tile_padding_without_yaw_rotation():
    requests = []
    fallback = responder(requests)

    def handle(request):
        if "/tiles/" not in request.url.path:
            return fallback(request)
        requests.append(request)
        x, y = map(int, request.url.path.split("/")[-2:])
        source = Image.new("RGB", (512, 512), (255, 0, 255))
        valid = Image.new("RGB", (min(512, 3328 - x * 512), min(512, 1664 - y * 512)), (x * 30, y * 60, 60))
        source.paste(valid, (0, 0))
        output = io.BytesIO()
        source.save(output, "PNG")
        return httpx.Response(200, content=output.getvalue(), headers={"content-type": "image/png"})

    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(handle)) as client:
        result = await client.fetch_panorama(LAT, LON)
    with Image.open(io.BytesIO(result["image_bytes"])) as image:
        assert image.size == (3328, 1664)
        for point, expected in [((5, 5), (0, 0, 60)), ((3320, 1650), (180, 180, 60)), ((520, 520), (30, 60, 60))]:
            assert all(abs(a - b) <= 3 for a, b in zip(image.getpixel(point), expected))


@pytest.mark.asyncio
async def test_large_supported_native_size_uses_zoom_one_to_fit_editor_without_resizing():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(responder(
        requests, meta=metadata(imageWidth=32768, imageHeight=16384),
    ))) as client:
        result = await client.fetch_panorama(LAT, LON)
    assert result["metadata"]["zoom"] == 1 and result["metadata"]["image_width"] == 2048
    assert len(requests) == 10


@pytest.mark.parametrize("key,authorized,code", [
    (None, True, "missing_key"), ("", True, "missing_key"), (KEY, False, "ai_use_not_authorized"),
    (KEY, "true", "ai_use_not_authorized"), (KEY, 1, "ai_use_not_authorized"),
    ("key\n" + KEY, True, "invalid_key"),
])
def test_missing_config_cannot_make_requests(key, authorized, code):
    requests = []
    with pytest.raises(StreetViewError) as caught:
        GoogleStreetViewClient(key, ai_authorized=authorized, transport=httpx.MockTransport(responder(requests)))
    assert caught.value.code == code and requests == []
    assert_safe(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("lat,lon,radius", [(91, 0, 50), (0, 181, 50), (float("nan"), 0, 50), (True, 0, 50), (LAT, LON, 151), (LAT, LON, 0)])
async def test_bad_coordinates_never_make_requests(lat, lon, radius):
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(responder(requests))) as client:
        with pytest.raises(StreetViewError, match="valid coordinates"):
            await client.fetch_panorama(lat, lon, radius_m=radius)
    assert requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("meta,code", [
    ({"status": "ZERO_RESULTS"}, "no_coverage"),
    ({"error": {"status": "NOT_FOUND", "message": KEY}}, "no_coverage"),
    (metadata(lat=LAT + 0.1), "no_coverage"),
    (metadata(imageWidth=12000), "invalid_response"),
    (metadata(imageWidth=13314, imageHeight=6657), "invalid_response"),
    (metadata(heading=float("nan")), "invalid_response"),
    (metadata(tilt=181), "invalid_response"),
    (metadata(roll=None), "invalid_response"),
    (metadata(copyright=""), "invalid_response"),
    (metadata(copyright=KEY), "invalid_response"),
    (metadata(panoId="https://evil.example"), "invalid_response"),
    (metadata(date="2026-15"), "invalid_response"),
    (metadata(tileWidth=256), "invalid_response"),
])
async def test_no_coverage_or_bad_metadata_never_starts_tile_downloads(meta, code):
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(responder(requests, meta=meta))) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama(LAT, LON)
    assert caught.value.code == code and len(requests) == 2
    assert_safe(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,code", [
    (httpx.Response(302, headers={"location": "https://evil.example/?key=" + KEY}), "http_error"),
    (httpx.Response(403, text=KEY + SESSION), "http_error"),
    (httpx.Response(404, text=KEY + SESSION), "http_error"),
    (httpx.Response(200, content=b"not an image", headers={"content-type": "image/png"}), "incomplete_panorama"),
    (httpx.Response(200, content=image_bytes(size=(256, 512)), headers={"content-type": "image/png"}), "incomplete_panorama"),
    (httpx.Response(200, content=image_bytes(), headers={"content-type": "text/html"}), "incomplete_panorama"),
    (httpx.Response(200, content=b"x", headers={"content-type": "image/png", "content-length": str(2**25)}), "response_too_large"),
])
async def test_tile_failures_never_return_partial_pano_or_follow_keyed_redirect(failure, code):
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(responder(requests, failure=failure))) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama(LAT, LON)
    assert caught.value.code == code and len(requests) <= 50
    assert all(request.url.host == "tile.googleapis.com" for request in requests)
    assert_safe(caught.value)


@pytest.mark.asyncio
async def test_transport_failure_is_sanitized_without_request_url():
    def handle(request):
        raise httpx.ReadTimeout("https://evil.example/?key=" + KEY, request=request)

    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama(LAT, LON)
    assert caught.value.code == "transport_error"
    assert_safe(caught.value)


@pytest.mark.asyncio
async def test_eight_maximum_concurrent_requests():
    requests = []
    fallback = responder(requests)
    active = peak = 0

    async def handle(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        response = fallback(request)
        active -= 1
        return response

    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(handle)) as client:
        await client.fetch_panorama(LAT, LON)
    assert peak == 8


@pytest.mark.asyncio
async def test_total_decoded_download_limit(monkeypatch):
    monkeypatch.setattr(streetview, "_TOTAL_LIMIT", 6000)
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(responder(requests))) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama(LAT, LON)
    assert caught.value.code == "response_too_large"


@pytest.mark.parametrize("url", [
    "http://cbks0.googleapis.com/cbk?output=report&panoid=pano-cmu",
    "https://evil.example/?key=" + KEY,
    "https://cbks0.googleapis.com/cbk?output=report&panoid=pano-cmu&key=" + KEY,
    "https://cbks0.googleapis.com/cbk?output=report&panoid=other",
])
def test_untrusted_report_links_are_not_exposed(url):
    assert "report_problem_link" not in streetview._metadata(metadata(reportProblemLink=url), LAT, LON, 50)


def test_official_viewer_url_uses_coordinates_and_no_api_key():
    url = urlsplit(streetview_url(LAT, LON))
    assert url.scheme == "https" and url.netloc == "www.google.com" and url.path == "/maps/@"
    assert parse_qs(url.query) == {"api": ["1"], "map_action": ["pano"], "viewpoint": ["40.4433000,-79.9436000"]}
    with pytest.raises(StreetViewError):
        streetview_url(None, LON)


@pytest.mark.asyncio
@pytest.mark.parametrize("response,code", [
    (httpx.Response(404, text=KEY), "no_coverage"),
    (httpx.Response(200, content=b"[1, 2]"), "invalid_response"),
    (httpx.Response(200, content=b"not json"), "invalid_response"),
    (httpx.Response(200, content=b"x" * (129 * 1024)), "response_too_large"),
    (httpx.Response(307, headers={"location": "https://evil.example"}), "http_error"),
])
async def test_metadata_errors_are_bounded_and_do_not_fetch_untrusted_url(response, code):
    requests = []
    fallback = responder(requests)

    def handle(request):
        if request.url.path.endswith("metadata"):
            requests.append(request)
            return response
        return fallback(request)

    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(handle)) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama(LAT, LON)
    assert len(requests) == 2 and caught.value.code == code
    assert_safe(caught.value)


@pytest.mark.asyncio
async def test_environment_proxy_settings_are_ignored(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://evil.example:8080")
    monkeypatch.setenv("ALL_PROXY", "http://evil.example:8081")
    client = GoogleStreetViewClient(KEY, ai_authorized=True)
    try:
        assert client._client._mounts == {}
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_json_stream_without_content_length_is_stopped_at_byte_limit():
    delivered = 0

    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            nonlocal delivered
            for _ in range(20):
                delivered += 1
                yield b"x" * 65536

    async with GoogleStreetViewClient(KEY, ai_authorized=True, transport=httpx.MockTransport(
        lambda _: httpx.Response(200, stream=Stream()),
    )) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama(LAT, LON)
    assert caught.value.code == "response_too_large" and delivered == 3


def test_unknown_metadata_fields_cannot_supply_urls_or_crash_projection_check():
    result = streetview._metadata(metadata(
        imageryType={"url": "https://evil.example"}, tileUrl="https://evil.example", session=SESSION,
    ), LAT, LON, 50)
    assert "imagery_type" not in result and "evil.example" not in json.dumps(result)
    assert SESSION not in json.dumps(result)


def test_adjacency_metadata_only_keeps_valid_official_ids_and_headings():
    result = streetview._metadata(metadata(links=[
        {'panoId': 'north', 'heading': 360, 'url': 'https://evil.example', 'text': KEY},
        {'panoId': 'north', 'heading': 20}, {'panoId': 'pano-cmu', 'heading': 0},
        {'panoId': 'https://evil.example', 'heading': 0}, {'panoId': 'bad', 'heading': float('nan')},
        None, {'panoId': 'bool', 'heading': True},
    ]), LAT, LON, 50)
    assert result['links'] == [{'pano_id': 'north', 'heading': 0}]
    assert 'evil.example' not in json.dumps(result) and KEY not in json.dumps(result)


def route_responder(requests, *, ambiguous=False, diverges=False, no_coverage=False,
                    spacing=.00018, junction_at=None):
    def handle(request):
        requests.append(request)
        if request.url.path.endswith('createSession'):
            return httpx.Response(200, json={'session': SESSION})
        if request.url.path.endswith('metadata'):
            if no_coverage:
                return httpx.Response(404)
            pano = request.url.params.get('panoId', 'pano-0')
            n = int(pano.split('-')[-1])
            links = [{'panoId': f'pano-{n + 1}', 'heading': 0}]
            if n:
                links.append({'panoId': f'pano-{n - 1}', 'heading': 180})
            if ambiguous and n == 0 or n == junction_at:
                links.append({'panoId': 'branch', 'heading': 10})
            return httpx.Response(200, json=metadata(panoId=pano, lat=LAT + n * spacing,
                lng=LON + (.001 if diverges and n else 0), links=links))
        return httpx.Response(200, content=image_bytes(), headers={'content-type': 'image/png'})
    return handle


@pytest.mark.asyncio
async def test_prediction_follows_reachable_north_links_then_downloads_exact_pano_id():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True,
            transport=httpx.MockTransport(route_responder(requests))) as client:
        selected = await client.select_forward_panorama(LAT, LON, heading_deg=0, lookahead_m=55,
                                                        current_pano_id='pano-0')
        assert selected['path'] == ['pano-0', 'pano-1', 'pano-2', 'pano-3']
        assert selected['metadata']['pano_id'] == 'pano-3'
        assert 59 < selected['distance_m'] < 61
        assert all('/tiles/' not in request.url.path for request in requests)
        result = await client.fetch_panorama_by_id('pano-3', lat=LAT + 3 * .00018, lon=LON)
    metadata_calls = [request for request in requests if request.url.path.endswith('metadata')]
    assert len(metadata_calls) <= 6
    assert 'lat' in metadata_calls[0].url.params
    assert all('lat' not in request.url.params and request.url.params['panoId'].startswith('pano-')
               for request in metadata_calls[1:])
    assert all(request.url.params['panoId'] == 'pano-3' for request in requests if '/tiles/' in request.url.path)
    assert result['metadata']['pano_id'] == 'pano-3'


@pytest.mark.asyncio
@pytest.mark.parametrize('flags,reason', [({'ambiguous': True}, 'ambiguous_junction'),
                                        ({'diverges': True}, 'route_diverges')])
async def test_prediction_skips_uncertain_or_geographically_inconsistent_links(flags, reason):
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True,
            transport=httpx.MockTransport(route_responder(requests, **flags))) as client:
        result = await client.select_forward_panorama(LAT, LON, heading_deg=0, lookahead_m=55)
    assert result == {'status': 'skipped', 'reason': reason}
    assert all('/tiles/' not in request.url.path for request in requests)


@pytest.mark.asyncio
async def test_prediction_never_traverses_backwards_and_metadata_budget_is_bounded():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True,
            transport=httpx.MockTransport(route_responder(requests, spacing=.000045))) as client:
        result = await client.select_forward_panorama(LAT, LON, heading_deg=180, lookahead_m=55)
        assert result == {'status': 'skipped', 'reason': 'no_forward_link'}
        result = await client.select_forward_panorama(LAT, LON, heading_deg=0, lookahead_m=150)
        assert result == {'status': 'skipped', 'reason': 'insufficient_route'}
    assert len([request for request in requests if request.url.path.endswith('metadata')]) == 10


@pytest.mark.asyncio
async def test_dense_ten_metre_nodes_reach_default_walking_lookahead():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True,
            transport=httpx.MockTransport(route_responder(requests, spacing=.00009))) as client:
        result = await client.select_forward_panorama(LAT, LON, heading_deg=0, lookahead_m=77)
    assert result['metadata']['pano_id'] == 'pano-8'
    assert 79 < result['distance_m'] < 81
    assert len([request for request in requests if request.url.path.endswith('metadata')]) == 9


@pytest.mark.asyncio
async def test_usable_target_before_ambiguous_next_link_is_retained():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True,
            transport=httpx.MockTransport(route_responder(requests, junction_at=2))) as client:
        result = await client.select_forward_panorama(LAT, LON, heading_deg=0, lookahead_m=55)
    assert result['metadata']['pano_id'] == 'pano-2'
    assert len([request for request in requests if request.url.path.endswith('metadata')]) == 3


@pytest.mark.asyncio
async def test_by_id_rejects_a_different_camera_without_downloading_tiles():
    requests = []
    async with GoogleStreetViewClient(KEY, ai_authorized=True,
            transport=httpx.MockTransport(responder(requests))) as client:
        with pytest.raises(StreetViewError) as caught:
            await client.fetch_panorama_by_id('another-pano', lat=LAT + .0001, lon=LON)
    assert caught.value.code == 'invalid_response' and len(requests) == 2
