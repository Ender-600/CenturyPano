"""Real HEIC ingress, EXIF privacy, location precedence, and concurrent admission."""
import asyncio
import io
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from PIL.TiffImagePlugin import IFDRational
from pillow_heif import register_heif_opener

from app import main, pipeline
from app.config import settings
from app.constraints import build_constraints
from app.location import exif_gps
from app.scene import DEFAULT_SCENE_SPEC

register_heif_opener()
GPS = (40.44, -79.99)


def encoded_image(*, heic=False, gps=False):
    exif = Image.Exif()
    exif[271] = "Private test camera identity"
    if gps:
        exif[34853] = {
            1: "N", 2: tuple(IFDRational(x) for x in (40, 26, 24)),
            3: "W", 4: tuple(IFDRational(x) for x in (79, 59, 24)),
        }
    image = Image.new("RGB", (480, 120), "#819aae")
    image.paste("#cbb594", (0, 60, 480, 120))
    output = io.BytesIO()
    image.save(output, "HEIF" if heic else "JPEG", quality=85, exif=exif)
    return output.getvalue()


@pytest.fixture
def upload_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "in_dir", tmp_path / "in")
    monkeypatch.setattr(settings, "out_dir", tmp_path / "out")
    monkeypatch.setattr(settings, "provider", "demo")
    monkeypatch.setattr(settings, "provider_fallback", "demo")
    monkeypatch.setenv("DEMO_DELAY_S", "0")
    return tmp_path


@pytest.fixture
def client(upload_workspace):
    with TestClient(main.app) as session:
        yield session


def wait_for_result(client, job_id):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        manifest = client.get(f"/jobs/{job_id}/manifest").json()
        if manifest["status"] != "running":
            return manifest
        time.sleep(.05)
    pytest.fail("HEIC demo pipeline did not finish")


def test_heic_gps_preview_and_original_survive_real_upload_pipeline(client):
    data = encoded_image(heic=True, gps=True)
    with Image.open(io.BytesIO(data)) as source:
        assert source.format == "HEIF"
        assert exif_gps(source) == pytest.approx(GPS)
        assert source.getexif()[271] == "Private test camera identity"
    files = {"image": ("phone-panorama.heic", data, "image/heic")}
    preview = client.post("/preview", files=files)
    assert preview.status_code == 200
    assert preview.headers["cache-control"] == "no-store"
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.format == "JPEG" and image.size == (480, 120)
        assert not image.getexif()
    uploaded = client.post("/jobs", files=files,
                           data={"place": "5000 Forbes Avenue, Pittsburgh, PA"})
    assert uploaded.status_code == 201, uploaded.text
    job_id = uploaded.json()["job_id"]
    result = wait_for_result(client, job_id)
    assert result["status"] == "done", result
    assert result["source"]["path"] == f"in/{job_id}.heic"
    assert result["source"]["w"] == 480 and result["source"]["h"] == 120
    assert result["place"]["source"] == "exif"
    assert result["place"]["name"] == "Pittsburgh"
    assert (result["place"]["lat"], result["place"]["lon"]) == pytest.approx(GPS)
    original_path = settings.in_dir / f"{job_id}.heic"
    assert original_path.read_bytes() == data
    with Image.open(original_path) as original:
        assert exif_gps(original) == pytest.approx(GPS)
    for suffix in ("preview", "result", "tiles/0", "tiles/0?raw=1"):
        response = client.get(f"/jobs/{job_id}/{suffix}")
        assert response.status_code == 200
        with Image.open(io.BytesIO(response.content)) as public_image:
            assert public_image.format == "JPEG"
            assert not public_image.getexif()
    assert client.get("/" + result["source"]["path"]).status_code == 404
    prompt = result["constraints"]["prompt_global"]
    assert "Pittsburgh, USA" in prompt
    assert all(value not in prompt for value in ("Forbes", "5000", "40.44", "79.99", "Pennsylvania"))


@pytest.mark.parametrize("gps,fields,expected_source,expected_city", [
    (True, {"lat": "40.7128", "lon": "-74.006", "place": "Boston"}, "geolocation", "New York City"),
    (True, {"place": "Boston"}, "exif", "Pittsburgh"),
    (False, {"place": "Pittsburgh"}, "manual", "Pittsburgh"),
    (False, {}, "none", ""),
    (False, {"place": "5000 Forbes Avenue, Pittsburgh, PA"}, "manual", "5000 Forbes Avenue, Pittsburgh, PA"),
])
def test_http_location_precedence_and_prompt_privacy(client, monkeypatch, gps, fields,
                                                    expected_source, expected_city):
    async def upload_only(job_id, **kwargs):
        return None
    monkeypatch.setattr(pipeline, "run_job", upload_only)
    response = client.post("/jobs", files={"image": ("panorama.jpg", encoded_image(gps=gps), "image/jpeg")},
                           data=fields)
    assert response.status_code == 201, response.text
    manifest = client.get(f"/jobs/{response.json()['job_id']}/manifest").json()
    place = manifest["place"]
    assert place["source"] == expected_source and place["name"] == expected_city
    constraints = asyncio.run(build_constraints(place, "1920s", DEFAULT_SCENE_SPEC, provider="demo"))
    prompt = constraints.prompt_global
    assert all(value not in prompt for value in ("Forbes", "5000", "40.44", "79.99", "40.7128", "74.006", "Pennsylvania"))
    if expected_source == "geolocation":
        assert "New York City, USA" in prompt
        assert "Pittsburgh" not in prompt and "Boston" not in prompt
    elif expected_city == "Pittsburgh":
        assert "Pittsburgh, USA" in prompt
    else:
        assert "Pittsburgh" not in prompt
    if expected_source in {"manual", "none"}:
        assert place["lat"] is None and place["lon"] is None


def test_concurrent_uploads_respect_four_job_admission(upload_workspace, monkeypatch):
    data = encoded_image()
    original_read = main.read_upload

    async def exercise():
        arrived = 0
        all_reading = asyncio.Event()
        hold_jobs = asyncio.Event()

        async def simultaneous_read(image):
            nonlocal arrived
            raw = await original_read(image)
            arrived += 1
            if arrived == 8:
                all_reading.set()
            await all_reading.wait()
            return raw

        async def held_job(job_id):
            try:
                await hold_jobs.wait()
            finally:
                main._tasks.pop(job_id, None)

        monkeypatch.setattr(main, "read_upload", simultaneous_read)
        monkeypatch.setattr(main, "_run", held_job)
        async with main.lifespan(main.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                         base_url="http://testserver") as session:
                requests = [session.post("/jobs", files={"image": ("panorama.jpg", data, "image/jpeg")})
                            for _ in range(8)]
                responses = await asyncio.wait_for(asyncio.gather(*requests), timeout=10)
                statuses = [response.status_code for response in responses]
                assert statuses.count(201) == 4, statuses
                assert statuses.count(429) == 4, statuses
                assert len(main._tasks) == 4
                assert len(list(settings.in_dir.iterdir())) == 4
                assert len(list(settings.out_dir.glob("*/manifest.json"))) == 4
        assert not main._tasks
    asyncio.run(exercise())
