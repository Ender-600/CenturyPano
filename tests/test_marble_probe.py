"""Offline checks for the one-submission Marble probe and its durable recovery."""

import asyncio
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json

import pytest
from PIL import Image, ImageDraw

from app.worlds.marble import MarbleError, SubmissionUnknown
from scripts import probe_marble


OPERATION_ID = "operation-test-1"
WORLD_ID = "world-test-1"


def accepted():
    return {"operation_id": OPERATION_ID, "done": False}


def completed():
    return {
        "operation_id": OPERATION_ID, "done": True, "error": None,
        "cost": {"total_credits": 230},
        "response": {"world_id": WORLD_ID},
    }


def saved(directory):
    return json.loads((directory / "report.json").read_text())


class FakeClient:
    def __init__(self, directory, *, balance=1000, start=None, polls=None):
        self.directory = directory
        self.balance = balance
        self.start = accepted() if start is None else start
        self.polls = [completed()] if polls is None else list(polls)
        self.calls = []
        self.submissions = []

    async def credits(self):
        self.calls.append("credits")
        return {"remaining_credits": self.balance}

    async def generate_image(self, image_bytes, prompt, display_name, **options):
        # Losing the response must leave evidence that this paid POST was attempted.
        before = saved(self.directory)
        assert before["status"] == "submitting"
        assert before["generation_calls"] == 1
        assert "operation_id" not in before
        assert (self.directory / "input.jpg").read_bytes() == image_bytes
        self.calls.append("generate")
        self.submissions.append((image_bytes, prompt, display_name, options))
        if isinstance(self.start, Exception):
            raise self.start
        return deepcopy(self.start)

    async def operation(self, operation_id):
        # Verify acceptance is on disk before the first poll, including resumed runs.
        assert operation_id == OPERATION_ID
        assert saved(self.directory)["operation_id"] == OPERATION_ID
        self.calls.append("operation")
        if not self.polls:
            raise AssertionError("Unexpected extra operation poll")
        response = self.polls.pop(0)
        if isinstance(response, Exception):
            raise response
        return deepcopy(response)

    async def world(self, world_id):
        assert world_id == WORLD_ID
        self.calls.append("world")
        return {"world_id": world_id, "assets": {"splats": {"spz_urls": {
            "100k": "https://cdn.worldlabs.ai/private-signed-test.spz?token=not-for-logs",
        }}}}


class FakeDownloader:
    def __init__(self, directory, error=None):
        self.directory = directory
        self.error = error
        self.calls = []

    async def __call__(self, world, output_dir):
        assert output_dir == self.directory / "assets"
        before = saved(self.directory)
        assert before["status"] == "fetching_assets"
        assert before["operation_id"] == OPERATION_ID
        assert before["world_id"] == WORLD_ID
        self.calls.append((deepcopy(world), output_dir))
        if self.error:
            raise self.error
        return [{"kind": "spz", "path": str(output_dir / "100k.spz"),
                 "bytes": 128, "sha256": "a" * 64, "validation": "test-fixture-only"}]


@pytest.fixture(autouse=True)
def offline_probe(monkeypatch):
    async def no_delay(_seconds):
        return None

    def forbidden_client(*args, **kwargs):
        raise AssertionError("Tests must inject a fake client; no network client is allowed")

    monkeypatch.setattr(probe_marble.asyncio, "sleep", no_delay)
    monkeypatch.setattr(probe_marble, "MarbleClient", forbidden_client)


@pytest.fixture
def photo(tmp_path):
    path = tmp_path / "capture.jpg"
    image = Image.new("RGB", (320, 160), "#5681a6")
    exif = Image.Exif()
    exif[315] = "private photographer metadata"
    image.save(path, "JPEG", exif=exif)
    return path


def invoke(directory, client, downloader, **kwargs):
    return asyncio.run(probe_marble.run_probe(
        api_key="test-only-key", output_dir=directory, client=client,
        downloader=downloader, wait_s=10, poll_s=.01, **kwargs,
    ))


def test_single_post_persists_acceptance_before_polling_and_preserves_year(photo, tmp_path, capsys):
    directory = tmp_path / "probe"
    client = FakeClient(directory, polls=[accepted(), completed()])
    downloader = FakeDownloader(directory)
    result = invoke(directory, client, downloader, input_path=photo, year=1847)

    assert result["status"] == "assets_verified", result
    assert client.calls == ["credits", "generate", "operation", "operation", "world", "credits"]
    assert len(client.submissions) == len(downloader.calls) == 1
    assert result["generation_calls"] == 1
    assert result["requested_year"] == result["effective_year"] == 1847
    _, prompt, title, options = client.submissions[0]
    assert "1847" in prompt and "1847" in title
    assert "1925" not in prompt
    assert options == {"model": "marble-1.0-draft", "is_pano": False}
    assert result["settled_credits"] == 230
    assert result["validation"]["gpu_rendering"] == "unverified"
    assert result["validation"]["real_world_alignment"] == "unverified"
    assert saved(directory) == result
    output = capsys.readouterr().out
    assert "not-for-logs" not in output and "test-only-key" not in output


def test_insufficient_credits_makes_no_generation_or_download(photo, tmp_path):
    directory = tmp_path / "low-balance"
    client = FakeClient(directory, balance=229)
    downloader = FakeDownloader(directory)
    result = invoke(directory, client, downloader, input_path=photo)

    assert result["status"] == "insufficient_credits"
    assert result["generation_calls"] == 0
    assert client.calls == ["credits"]
    assert downloader.calls == []
    assert saved(directory) == result


def test_submission_unknown_is_never_retried_or_resumed_without_an_id(photo, tmp_path):
    directory = tmp_path / "unknown"
    client = FakeClient(directory, start=SubmissionUnknown())
    downloader = FakeDownloader(directory)
    result = invoke(directory, client, downloader, input_path=photo)

    assert result["status"] == "submission_unknown"
    assert result["generation_calls"] == 1
    assert "operation_id" not in result
    assert client.calls == ["credits", "generate"]
    assert saved(directory) == result
    resume_client = FakeClient(directory)
    with pytest.raises(ValueError, match="No saved operation ID"):
        invoke(directory, resume_client, downloader, resume=True)
    assert resume_client.calls == [] and downloader.calls == []
    assert saved(directory) == result


@pytest.mark.parametrize("failure_stage", ["poll", "download"])
def test_failure_after_acceptance_resumes_saved_operation_without_another_post(photo, tmp_path, failure_stage):
    directory = tmp_path / failure_stage
    polling_error = MarbleError("Temporary polling failure", code="transport_error", retryable=True)
    first_client = FakeClient(directory, polls=[polling_error] if failure_stage == "poll" else None)
    first_downloader = FakeDownloader(directory, OSError("disk unavailable") if failure_stage == "download" else None)
    failed = invoke(directory, first_client, first_downloader, input_path=photo, year=1899)

    assert failed["status"] == "failed"
    assert failed["operation_id"] == OPERATION_ID
    assert saved(directory)["operation_id"] == OPERATION_ID
    assert len(first_client.submissions) == 1

    resumed_client = FakeClient(directory)
    resumed_downloader = FakeDownloader(directory)
    # A resume must use the frozen source/year, even if the CLI's default year differs.
    result = invoke(directory, resumed_client, resumed_downloader, resume=True, year=1925)
    assert result["status"] == "assets_verified", result
    assert resumed_client.calls == ["operation", "world", "credits"]
    assert resumed_client.submissions == []
    assert result["generation_calls"] == 1
    assert result["requested_year"] == result["effective_year"] == 1899
    assert len(resumed_downloader.calls) == 1
    assert saved(directory) == result


def test_resuming_verified_probe_performs_no_calls(photo, tmp_path):
    directory = tmp_path / "verified"
    original = invoke(directory, FakeClient(directory), FakeDownloader(directory), input_path=photo)
    client, downloader = FakeClient(directory), FakeDownloader(directory)
    resumed = invoke(directory, client, downloader, resume=True)

    assert resumed == original
    assert client.calls == [] and downloader.calls == []


def test_failed_remote_operation_is_saved_without_downloading_or_resubmitting(photo, tmp_path):
    directory = tmp_path / "remote-failed"
    operation = {"operation_id": OPERATION_ID, "done": True,
                 "error": {"code": 13, "message": "Marble world generation failed"}}
    client = FakeClient(directory, polls=[operation])
    downloader = FakeDownloader(directory)
    result = invoke(directory, client, downloader, input_path=photo)

    assert result["status"] == "generation_failed"
    assert result["generation_calls"] == 1
    assert client.calls == ["credits", "generate", "operation"]
    assert downloader.calls == []
    assert saved(directory) == result


def test_prepare_input_preserves_full_wide_frame_and_does_not_label_it_a_pano(tmp_path):
    path = tmp_path / "wide.jpg"
    original = Image.new("RGB", (4000, 1000), "#888888")
    draw = ImageDraw.Draw(original)
    draw.rectangle((0, 0, 399, 999), fill="#ff0000")
    draw.rectangle((3600, 0, 3999, 999), fill="#0000ff")
    exif = Image.Exif()
    exif[315] = "private photographer metadata"
    original.save(path, "JPEG", exif=exif)

    data, info = probe_marble.prepare_input(path)
    with Image.open(BytesIO(data)) as image:
        assert image.format == "JPEG" and image.size == (2048, 512)
        assert not image.getexif()
        left, right = image.getpixel((10, 250)), image.getpixel((2030, 250))
        assert left[0] > 240 and left[2] < 15
        assert right[2] > 240 and right[0] < 15
    assert info["original_dimensions"] == [4000, 1000]
    assert info["submitted_dimensions"] == [2048, 512]
    assert info["is_pano"] is False
    assert info["source_sha256"] == sha256(path.read_bytes()).hexdigest()
    assert info["input_sha256"] == sha256(data).hexdigest()
    assert b"private photographer metadata" not in data


def test_prepare_input_applies_exif_orientation_before_reporting_dimensions(tmp_path):
    path = tmp_path / "rotated.jpg"
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (1200, 600), "#abcdef").save(path, "JPEG", exif=exif)

    data, info = probe_marble.prepare_input(path)
    with Image.open(BytesIO(data)) as image:
        assert image.size == (600, 1200)
        assert not image.getexif()
    assert info["original_dimensions"] == info["submitted_dimensions"] == [600, 1200]
    assert info["is_pano"] is False
