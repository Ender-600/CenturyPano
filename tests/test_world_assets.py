"""Offline container fixtures and HTTP mocks; none are generated/rendered worlds."""
import asyncio
import gzip
import hashlib
import io
import json
from pathlib import Path
import struct

import httpx
from PIL import Image
import pytest

from app.worlds import assets

CDN = "https://cdn.marble.worldlabs.ai"


def legacy_spz(version=3):
    # Minimal parser fixture, not a production scene or renderer smoke test.
    header = struct.pack("<IIIBBBB", assets.NGSP_MAGIC, version, 1, 0, 12, 0, 0)
    return gzip.compress(header + bytes(20), mtime=0)


def v4_spz():
    # Header/TOC fixture deliberately has opaque streams: inspection must never
    # claim that it decoded or rendered their contents.
    streams = [b"opaque"] * 6
    header = struct.pack("<IIIBBBBI12s", assets.NGSP_MAGIC, 4, 1, 0, 12, 0, 6, 32, bytes(12))
    toc = b"".join(struct.pack("<QQ", len(stream), 3) for stream in streams)
    return header + toc + b"".join(streams)


def picture(fmt="JPEG"):
    output = io.BytesIO()
    Image.new("RGB", (32, 16), "#8c9eae").save(output, fmt)
    return output.getvalue()


def glb():
    document = b'{"asset":{"version":"2.0"}}'
    document += b" " * (-len(document) % 4)
    chunk = struct.pack("<I4s", len(document), b"JSON") + document
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunk)) + chunk


def world(lods=None):
    return {"assets": {"splats": {"spz_urls": lods or {"100k": CDN + "/small.spz"}}}}


@pytest.fixture
def install_http(monkeypatch):
    original_client = httpx.AsyncClient

    def install(handler):
        options = []
        requests = []

        def record(request):
            requests.append(request)
            return handler(request)

        def client(**kwargs):
            options.append(kwargs)
            return original_client(transport=httpx.MockTransport(record), **kwargs)

        monkeypatch.setattr(assets.httpx, "AsyncClient", client)
        return options, requests
    return install


def response(data, *, status=200, headers=None):
    return httpx.Response(status, stream=httpx.ByteStream(data), headers=headers or {})


def test_selects_full_resolution_spz_and_validates_downloads(tmp_path, install_http, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("WLT_API_KEY", "do-not-send-this-key")
    supplied = world({"500k": CDN + "/large.spz", "100k": CDN + "/small.spz",
                      "full_res": CDN + "/full.spz", "preview": CDN + "/other.spz"})
    supplied["assets"]["splats"]["semantics_metadata"] = {"metric_scale_factor": 1.2, "ground_plane_offset": -.4}
    supplied["assets"]["imagery"] = {"pano_url": CDN + "/panorama.jpg?signed=private"}
    supplied["assets"]["mesh"] = {"collider_mesh_url": CDN + "/collider.glb"}
    bodies = {"/full.spz": v4_spz(), "/panorama.jpg": picture(), "/collider.glb": glb()}
    options, requests = install_http(lambda request: response(bodies[request.url.path]))
    result = asyncio.run(assets.download_assets(supplied, tmp_path))
    assert [item["kind"] for item in result] == ["spz", "pano", "collider"]
    assert [request.url.path for request in requests] == list(bodies)
    assert result[0]["lod"] == "full_res"
    assert result[0]["semantics_metadata"] == {"metric_scale_factor": 1.2, "ground_plane_offset": -.4}
    assert result[0]["semantics_status"] == "present"
    assert options[0]["trust_env"] is False and options[0]["follow_redirects"] is False
    for item in result:
        data = Path(item["path"]).read_bytes()
        assert item["bytes"] == len(data)
        assert item["sha256"] == hashlib.sha256(data).hexdigest()
        assert item["validation"]["renderer_verified"] is False
    for request in requests:
        assert "authorization" not in request.headers and "wlt-api-key" not in request.headers
        assert request.headers["accept-encoding"] == "identity"
    assert "signed=private" not in json.dumps(result)
    assert not list(tmp_path.glob(".asset-staging-*"))


@pytest.mark.parametrize("lods,expected", [
    ({"500k": CDN + "/one", "25k": CDN + "/two", "1m": CDN + "/three"}, "1m"),
    ({"2.5m": CDN + "/one", "900k": CDN + "/two", "250000": CDN + "/three"}, "2.5m"),
    ({"full_res": CDN + "/one", "2.5m": CDN + "/two"}, "full_res"),
    ({"full_res": "", "500k": CDN + "/one", "100k": CDN + "/two"}, "500k"),
    ({"mystery": CDN + "/one", "full_res": CDN + "/two"}, "full_res"),
    ({"z-preview": CDN + "/one", "a-preview": CDN + "/two"}, "a-preview"),
])
def test_selects_highest_available_lod(lods, expected):
    assert assets._select_assets(world(lods))[0]["lod"] == expected


def test_downloads_highest_point_count_when_full_resolution_missing(tmp_path, install_http):
    supplied = world({"100k": CDN + "/small.spz", "2m": CDN + "/large.spz",
                      "500k": CDN + "/medium.spz"})
    _, requests = install_http(lambda request: response(legacy_spz()))
    result = asyncio.run(assets.download_assets(supplied, tmp_path))
    assert [request.url.path for request in requests] == ["/large.spz"]
    assert result[0]["lod"] == "2m"


@pytest.mark.parametrize("supplied", [{}, {"assets": None}, {"assets": {"splats": None}},
                                       {"assets": {"splats": {"spz_urls": {"100k": None}}}}])
def test_missing_spz_is_explicit_capability_error(tmp_path, install_http, supplied):
    _, requests = install_http(lambda request: pytest.fail("Missing SPZ must not start downloads"))
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(supplied, tmp_path))
    assert caught.value.code == "missing_spz" and not requests


@pytest.mark.parametrize("url", [
    "http://cdn.marble.worldlabs.ai/model.spz", "https://127.0.0.1/model.spz",
    "https://[::1]/model.spz", "https://cdn.marble.worldlabs.ai.evil.test/model.spz",
    "https://storage.googleapis.com/any-bucket/model.spz", "https://example.worldlabs.ai/model.spz",
    "https://secret@cdn.marble.worldlabs.ai/model.spz", "https://cdn.marble.worldlabs.ai:8443/model.spz",
    "https://cdn.marble.worldlabs.ai/model.spz#secret", "https://cdn.marble.worldlabs.ai/\nsecret",
])
def test_nonapproved_urls_rejected_before_network(tmp_path, install_http, url):
    _, requests = install_http(lambda request: pytest.fail("Unsafe URL must not be requested"))
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(world({"100k": url}), tmp_path))
    assert caught.value.code == "unsupported_asset_url"
    assert url not in str(caught.value) and not requests


@pytest.mark.parametrize("version", [1, 2, 3])
def test_legacy_gzip_headers_are_supported_without_renderer_claim(tmp_path, version):
    path = tmp_path / "legacy.spz"
    path.write_bytes(legacy_spz(version))
    result = assets.inspect_spz(path)
    assert result["version"] == version and result["compression"] == "gzip"
    assert result["payload_decoded"] is False and result["renderer_verified"] is False


def test_v4_header_and_toc_validation(tmp_path):
    path = tmp_path / "modern.spz"
    path.write_bytes(v4_spz())
    inspected = assets.inspect_spz(path)
    assert inspected["level"] == "header_and_toc" and inspected["version"] == 4
    assert inspected["payload_decoded"] is False
    path.write_bytes(v4_spz()[:-1])
    with pytest.raises(assets.AssetError, match="container/header"):
        assets.inspect_spz(path)


@pytest.mark.parametrize("data", [b"not spz", gzip.compress(b"bad header"), b"\x1f\x8b" + bytes(30)])
def test_invalid_spz_rejected(tmp_path, data):
    path = tmp_path / "bad.spz"
    path.write_bytes(data)
    with pytest.raises(assets.AssetError) as caught:
        assets.inspect_spz(path)
    assert caught.value.code == "invalid_spz"


def test_png_pano_and_missing_semantics(tmp_path, install_http):
    supplied = world()
    supplied["assets"]["imagery"] = {"pano_url": CDN + "/pano"}
    install_http(lambda request: response(legacy_spz() if request.url.path.endswith("spz") else picture("PNG")))
    result = asyncio.run(assets.download_assets(supplied, tmp_path))
    assert result[1]["filename"] == "panorama.png" and result[1]["media_type"] == "image/png"
    assert result[0]["semantics_metadata"] is None and result[0]["semantics_status"] == "missing"


def test_invalid_semantics_not_applied_or_misrepresented():
    supplied = world()
    supplied["assets"]["splats"]["semantics_metadata"] = {"metric_scale_factor": float("nan"), "ground_plane_offset": True}
    assert assets._semantics(supplied) == {"semantics_metadata": None, "semantics_status": "invalid"}


@pytest.mark.parametrize("headers,body,expected", [
    ({"content-length": "999999999"}, b"", "asset_too_large"),
    ({"content-length": "no"}, b"", "invalid_content_length"),
    ({"content-length": "90"}, b"short", "truncated_asset"),
    ({"content-encoding": "gzip"}, b"anything", "unsupported_encoding"),
])
def test_bad_http_metadata_is_bounded(tmp_path, install_http, headers, body, expected):
    install_http(lambda request: response(body, headers=headers))
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(world(), tmp_path))
    assert caught.value.code == expected
    assert list(tmp_path.iterdir()) == []


def test_stream_limit_applies_without_content_length(tmp_path, install_http, monkeypatch):
    monkeypatch.setattr(assets, "MAX_ASSET_BYTES", 128)
    install_http(lambda request: response(bytes(129)))
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(world(), tmp_path))
    assert caught.value.code == "asset_too_large" and list(tmp_path.iterdir()) == []


def test_redirect_is_not_followed_or_logged(tmp_path, install_http):
    _, requests = install_http(lambda request: response(b"private server body", status=302,
                                                        headers={"location": "https://127.0.0.1/secret"}))
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(world(), tmp_path))
    assert len(requests) == 1 and caught.value.code == "asset_http_error"
    assert "127.0.0.1" not in str(caught.value) and "private" not in str(caught.value)


def test_transport_errors_sanitized(tmp_path, install_http):
    def fail(request):
        raise httpx.ReadError("private signed URL and key", request=request)
    install_http(fail)
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(world(), tmp_path))
    assert caught.value.code == "asset_transport_error" and "private" not in str(caught.value)


def test_optional_failure_keeps_existing_outputs(tmp_path, install_http):
    previous = tmp_path / "scene.spz"
    previous.write_bytes(b"existing output must remain")
    supplied = world()
    supplied["assets"]["mesh"] = {"collider_mesh_url": CDN + "/bad.glb"}
    install_http(lambda request: response(legacy_spz() if request.url.path.endswith("spz") else b"invalid collider"))
    with pytest.raises(assets.AssetError) as caught:
        asyncio.run(assets.download_assets(supplied, tmp_path))
    assert caught.value.code == "invalid_glb"
    assert previous.read_bytes() == b"existing output must remain"
    assert list(tmp_path.iterdir()) == [previous]


def test_glb_declared_length_must_match(tmp_path):
    path = tmp_path / "collider.glb"
    path.write_bytes(glb() + b"extra")
    with pytest.raises(assets.AssetError) as caught:
        assets.inspect_glb(path)
    assert caught.value.code == "invalid_glb"


def test_pano_pixel_budget_and_jpeg_decode(tmp_path, monkeypatch):
    path = tmp_path / "pano.jpg"
    path.write_bytes(picture())
    monkeypatch.setattr(assets, "MAX_IMAGE_PIXELS", 100)
    with pytest.raises(assets.AssetError):
        assets.inspect_image(path)
    monkeypatch.setattr(assets, "MAX_IMAGE_PIXELS", 100_000_000)
    path.write_bytes(picture()[:-10])
    with pytest.raises(assets.AssetError):
        assets.inspect_image(path)
