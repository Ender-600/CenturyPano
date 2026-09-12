"""Offline two-stage billing and recovery tests; no provider or CDN calls."""

import asyncio
from copy import deepcopy
import io
import json

import httpx
from PIL import Image
import pytest

from app.worlds.jobs import WorldJobManager, _download_pano, _pano_jpeg, _prompt
from app.worlds.marble import MarbleError, SubmissionUnknown
from app.worlds.assets import AssetError


PLAN = {"plan_id": "plan-cmu1925", "target_year": 1925, "historical_buildings": [], "camera_position": [0, 1.7, 0],
        "history_context": "Campus in 1925", "changes": [{"action": "remove", "name": "Gates Center"}]}
SECRET = "secret-url-token"


def png(size=(128, 64)):
    output = io.BytesIO()
    Image.new("RGB", size, (45, 100, 155)).save(output, "PNG")
    return output.getvalue()


def render(**_kwargs):
    return {"depth_png": png(), "preview_png": png(), "mesh_glb": b"coarse-test-fixture",
            "metadata": {"z_min": .1, "z_max": 100}}


def operation(stage, *, done=True):
    return {"operation_id": f"operation-{stage}", "done": done,
            "cost": {"total_credits": 80 if stage == "depth" else 150},
            "response": {"pano_url": f"https://cdn.marble.worldlabs.ai/{SECRET}.png"} if stage == "depth"
            else {"world_id": "world-1"}}


class FakeClient:
    def __init__(self, root, *, fail_depth=False, fail_world=False, wait_stage=None, balance=1000):
        self.root = root
        self.fail_depth = fail_depth
        self.fail_world = fail_world
        self.wait_stage = wait_stage
        self.balance = balance
        self.calls = []
        self.entered = asyncio.Event()
        self.closed = False

    def record(self):
        return json.loads(next(self.root.glob("*/record.json")).read_text())

    async def credits(self):
        self.calls.append("credits")
        return {"remaining_credits": self.balance}

    async def generate_depth(self, data, prompt, **bounds):
        record = self.record()
        assert record["stage"] == "submitting_depth" and record["generation_calls"]["depth"] == 1
        assert bounds == {"z_min": .1, "z_max": 100}
        assert "1925" in prompt
        self.calls.append("depth_post")
        if self.fail_depth:
            raise SubmissionUnknown()
        return operation("depth", done=self.wait_stage != "depth")

    async def generate_image(self, data, prompt, display_name, **settings):
        record = self.record()
        assert record["stage"] == "submitting_world" and record["generation_calls"]["world"] == 1
        assert any(item["kind"] == "historical_pano" for item in record["assets"])
        assert settings == {"model": "marble-1.0-draft", "is_pano": True}
        assert "historical RGB panorama" in prompt and "depth panorama" not in prompt
        image = Image.open(io.BytesIO(data))
        assert image.format == "JPEG" and image.size == (128, 64)
        self.calls.append("world_post")
        if self.fail_world:
            raise SubmissionUnknown()
        return operation("world", done=self.wait_stage != "world")

    async def operation(self, operation_id):
        self.calls.append(operation_id)
        stage = operation_id.split("-")[-1]
        if self.wait_stage == stage:
            self.entered.set()
            await asyncio.Future()
        return operation(stage)

    async def world(self, world_id):
        self.calls.append("world_get")
        return {"world_id": world_id, "assets": {"splats": {"spz_urls": {
            "500k": f"https://cdn.marble.worldlabs.ai/{SECRET}.spz",
        }}}}

    async def aclose(self):
        self.closed = True


async def pano_download(url, directory):
    assert SECRET in url
    target = directory / "original-pano.png"
    target.write_bytes(png())
    return target


async def assets_download(world, directory):
    directory.mkdir(exist_ok=True)
    target = directory / "scene.spz"
    target.write_bytes(b"test-spz-fixture")
    return [{"kind": "spz", "filename": target.name, "path": str(target), "media_type": "application/octet-stream",
             "validation": {"renderer_verified": False}, "lod": "500k"}]


def manager(root, client, **overrides):
    return WorldJobManager(root, "test-key", client_factory=lambda: client, renderer=render, poll_s=.001,
                           pano_downloader=pano_download, asset_downloader=assets_download, **overrides)


async def finish(manager, job_id):
    await asyncio.wait_for(manager._tasks[job_id], timeout=3)
    return manager.get(job_id)


@pytest.mark.asyncio
async def test_live_depth_result_world_shaped_imagery(tmp_path):
    class LiveShapeClient(FakeClient):
        async def generate_depth(self, *args, **kwargs):
            result = await super().generate_depth(*args, **kwargs)
            result['response'] = {'world_id': '', 'assets': {'imagery': result['response']}}
            return result
    client = LiveShapeClient(tmp_path)
    engine = manager(tmp_path, client)
    initial = await engine.start(deepcopy(PLAN))
    result = await finish(engine, initial['id'])
    assert result['stage'] == 'ready'
    assert result['cost_credits']['total'] == 230
    assert client.calls.count('depth_post') == client.calls.count('world_post') == 1
    await engine.aclose()


@pytest.mark.asyncio
async def test_two_paid_stages_deduplicate_and_publish_only_local_assets(tmp_path):
    client = FakeClient(tmp_path)
    engine = manager(tmp_path, client)
    first, duplicate = await asyncio.gather(engine.start(deepcopy(PLAN)), engine.start(deepcopy(PLAN)))
    assert first["id"] == duplicate["id"]
    result = await finish(engine, first["id"])
    assert result["stage"] == "ready", result
    assert result["plan_id"] == PLAN["plan_id"]
    assert result["generation_calls"] == {"depth": 1, "world": 1}
    assert result["cost_credits"] == {"depth": 80, "world": 150, "known_total": 230, "total": 230}
    assert client.calls.count("depth_post") == client.calls.count("world_post") == 1
    assert SECRET not in json.dumps(result) and str(tmp_path) not in json.dumps(result)
    assert "prompt" not in result and "plan_hash" not in result and "operation" not in result
    assert {item["kind"] for item in result["assets"]} == {"depth", "depth_preview", "coarse_mesh", "historical_pano", "spz"}
    assert result["validation"]["coordinate_alignment"] == "unverified"
    for item in result["assets"]:
        assert item["url"] == f"/world-jobs/{first['id']}/assets/{item['filename']}"
        assert engine.artifact_path(first["id"], item["filename"]).is_file()
    assert engine.artifact_path(first["id"], "plan.json") is None
    assert engine.artifact_path(first["id"], "world.json") is None
    assert engine.artifact_path(first["id"], "../record.json") is None
    again = await engine.start(deepcopy(PLAN))
    assert again["stage"] == "ready"
    same_content = {**PLAN, "plan_id": "new-ui-record", "parent_plan_id": "old-ui-record",
                    "created_at": 9999999, "assets": {"depth": "/world-plans/new-ui-record/assets/depth.png"},
                    "geometry_timestamp": "2026-09-13T00:00:00Z", "geometry": {"render_elapsed": 5}}
    assert (await engine.start(same_content))["id"] == first["id"]
    await engine.resume_all()
    assert client.calls.count("depth_post") == 1
    await engine.aclose()
    assert client.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_stage", ["depth", "world"])
async def test_unknown_submission_is_terminal_even_after_restart(tmp_path, failed_stage):
    client = FakeClient(tmp_path, fail_depth=failed_stage == "depth", fail_world=failed_stage == "world")
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN)
    result = await finish(engine, job["id"])
    assert result["stage"] == "submission_unknown"
    assert result["can_resume"] is False
    with pytest.raises(MarbleError) as refused:
        await engine.resume(job["id"])
    assert refused.value.code == "resume_not_allowed"
    assert client.calls.count(f"{failed_stage}_post") == 1
    if failed_stage == "depth":
        assert "world_post" not in client.calls
    await engine.aclose()
    resumed_client = FakeClient(tmp_path)
    resumed = manager(tmp_path, resumed_client)
    await resumed.resume_all()
    assert not resumed._tasks and not resumed_client.calls
    assert (await resumed.start(PLAN))["stage"] == "submission_unknown"
    assert not resumed._tasks
    await resumed.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("wait_stage", ["depth", "world"])
async def test_shutdown_and_resume_query_saved_operation_without_repeating_paid_stage(tmp_path, wait_stage):
    first = FakeClient(tmp_path, wait_stage=wait_stage)
    engine = manager(tmp_path, first)
    job = await engine.start(PLAN)
    await asyncio.wait_for(first.entered.wait(), 3)
    await engine.aclose()
    assert engine.get(job["id"])["stage"] == "paused"
    second = FakeClient(tmp_path)
    resumed = manager(tmp_path, second)
    await resumed.resume_all()
    result = await finish(resumed, job["id"])
    assert result["stage"] == "ready", result
    assert "depth_post" not in second.calls
    assert ("world_post" in second.calls) == (wait_stage == "depth")
    assert result["generation_calls"] == {"depth": 1, "world": 1}
    assert result["cost_credits"]["total"] == 230
    await resumed.aclose()


@pytest.mark.asyncio
async def test_crash_during_unacknowledged_post_is_unknown_without_receipt(tmp_path):
    client = FakeClient(tmp_path, wait_stage="depth")
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN)
    await asyncio.wait_for(client.entered.wait(), 3)
    await engine.aclose()
    directory = tmp_path / job["id"]
    record = json.loads((directory / "record.json").read_text())
    record["stage"] = "submitting_depth"
    record.pop("depth_operation_id")
    (directory / "record.json").write_text(json.dumps(record))
    (directory / "depth_operation.json").unlink()
    resumed_client = FakeClient(tmp_path)
    resumed = manager(tmp_path, resumed_client)
    await resumed.resume_all()
    result = await finish(resumed, job["id"])
    assert result["stage"] == "submission_unknown" and not resumed_client.calls
    await resumed.aclose()


@pytest.mark.asyncio
async def test_durable_receipt_recovers_crash_before_main_record_acceptance(tmp_path):
    client = FakeClient(tmp_path, wait_stage="depth")
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN)
    await asyncio.wait_for(client.entered.wait(), 3)
    await engine.aclose()
    directory = tmp_path / job["id"]
    record = json.loads((directory / "record.json").read_text())
    record.update(stage="submitting_depth")
    record.pop("depth_operation_id")
    (directory / "record.json").write_text(json.dumps(record))
    resumed_client = FakeClient(tmp_path)
    resumed = manager(tmp_path, resumed_client)
    await resumed.resume_all()
    result = await finish(resumed, job["id"])
    assert result["stage"] == "ready"
    assert "depth_post" not in resumed_client.calls
    await resumed.aclose()


@pytest.mark.asyncio
async def test_no_spending_with_missing_key_or_insufficient_credit(tmp_path):
    missing = WorldJobManager(tmp_path / "missing", "")
    with pytest.raises(MarbleError, match="WORLDLAB_API_KEY"):
        await missing.start(PLAN)
    await missing.aclose()
    client = FakeClient(tmp_path / "low", balance=149)
    engine = manager(tmp_path / "low", client)
    job = await engine.start(PLAN)
    result = await finish(engine, job["id"])
    assert result["stage"] == "insufficient_credits"
    assert result["generation_calls"] == {"depth": 0, "world": 0}
    assert client.calls == ["credits"]
    await engine.aclose()


def test_pano_conversion_keeps_full_sphere_and_does_not_follow_exif_rotation(tmp_path):
    image = Image.new("RGB", (128, 64), "red")
    image.paste("blue", (96, 0, 128, 64))
    exif = Image.Exif()
    exif[274] = 6
    path = tmp_path / "pano.png"
    image.save(path, "PNG", exif=exif)
    converted = Image.open(io.BytesIO(_pano_jpeg(path)))
    assert converted.size == (128, 64) and not converted.getexif()
    assert converted.getpixel((5, 32))[0] > 240 and converted.getpixel((120, 32))[2] > 240


@pytest.mark.asyncio
async def test_depth_preview_download_rejects_other_hosts_before_network(tmp_path, monkeypatch):
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_: pytest.fail("Unexpected network client"))
    with pytest.raises(AssetError) as caught:
        await _download_pano(f"https://evil.example/{SECRET}", tmp_path)
    assert caught.value.code == "unsupported_asset_url"
    assert SECRET not in str(caught.value)


@pytest.mark.asyncio
async def test_asset_failure_resumes_without_any_generation_post(tmp_path):
    async def broken_download(*_args):
        raise AssetError("download_failed", "Asset download failed.")

    first = FakeClient(tmp_path)
    engine = manager(tmp_path, first)
    engine._asset_downloader = broken_download
    job = await engine.start(PLAN)
    result = await finish(engine, job["id"])
    assert result["stage"] == "paused"
    assert result["cost_credits"]["total"] == 230
    await engine.aclose()
    second = FakeClient(tmp_path)
    resumed = manager(tmp_path, second)
    await resumed.resume_all()
    result = await finish(resumed, job["id"])
    assert result["stage"] == "ready"
    assert not any(call.endswith("_post") for call in second.calls)
    await resumed.aclose()


@pytest.mark.asyncio
async def test_failed_operation_keeps_reported_cost_and_does_not_submit_world(tmp_path):
    class FailedGeneration(FakeClient):
        async def generate_depth(self, *args, **kwargs):
            result = await super().generate_depth(*args, **kwargs)
            return {**result, "error": {"code": 13, "message": SECRET}}

    client = FailedGeneration(tmp_path)
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN)
    result = await finish(engine, job["id"])
    assert result["stage"] == "error" and result["error_code"] == "operation_failed"
    assert result["can_resume"] is False
    with pytest.raises(MarbleError) as refused:
        await engine.resume(job["id"])
    assert refused.value.code == "resume_not_allowed"
    assert result["cost_credits"] == {"depth": 80, "world": None, "known_total": 80, "total": None}
    assert "world_post" not in client.calls and SECRET not in json.dumps(result)
    await engine.resume_all()
    assert client.calls.count("depth_post") == 1
    await engine.aclose()


@pytest.mark.asyncio
async def test_different_jobs_cannot_overlap_paid_stages(tmp_path):
    first = FakeClient(tmp_path, wait_stage="depth")
    engine = manager(tmp_path, first)
    await engine.start(PLAN)
    await asyncio.wait_for(first.entered.wait(), 3)
    second = FakeClient(tmp_path)
    other = manager(tmp_path, second)
    job = await other.start({**PLAN, "history_context": "A different historical scene in 1925"})
    await asyncio.sleep(.15)
    assert not second.calls
    assert other.get(job["id"])["generation_calls"] == {"depth": 0, "world": 0}
    await other.aclose()
    await engine.aclose()


def test_prompt_prioritizes_named_modern_removals_over_long_history_and_unknowns():
    plan = {**PLAN, "history_context": "Long historical background. " * 200,
            "modern_buildings": [{"id": "way/123", "label": "Gates Center"}],
            "changes": [{"action": "unknown", "reason": "Unverified " * 200},
                        {"action": "remove", "building_id": "way/123"}]}
    prompt = _prompt(plan)
    assert "Gates Center" in prompt and "1925" in prompt and "predecessors" in prompt
    assert len(prompt) <= 2000


def test_prompt_prioritizes_actual_site_and_readable_period_context():
    plan = {**PLAN, 'location': {'lat': 40.4433, 'lon': -79.9436},
            'sources': [{'id': 'cmu-gates-2009'}],
            'history_context': {'period_summary': '校园旧建筑与地块用途仍待考证。' * 100,
                                'internal_metadata': 'ignore ' * 1000}}
    prompt = _prompt(plan)
    assert 'Carnegie Institute of Technology' in prompt and 'Pittsburgh' in prompt
    assert '校园旧建筑' in prompt and '\\u' not in prompt and 'internal_metadata' not in prompt
    assert 'ground does not encode roads' in prompt and 'modern lane markings' in prompt
    assert len(prompt) <= 2000
    plan['location'] = {'lat': 34, 'lon': 130}
    assert 'Carnegie Institute' not in _prompt(plan)
    plan['historical_buildings'] = [{'id': 'old-1', 'label': 'Former workshop'}]
    plan['changes'] = [{'building_id': 'old-1', 'action': 'add'}]
    assert 'Former workshop' in _prompt(plan)
    assert 'not independently verified' in _prompt(plan)


@pytest.mark.asyncio
async def test_visual_failure_is_distinct_from_asset_completion(tmp_path):
    engine = manager(tmp_path, FakeClient(tmp_path))
    initial = await engine.start(PLAN)
    result = await finish(engine, initial['id'])
    path = tmp_path / initial['id'] / 'record.json'
    record = json.loads(path.read_text())
    record['review'] = {'status': 'rejected', 'scope': 'historical_appearance',
                        'notes': ['Modern road markings'], 'private_diagnostic': 'not public'}
    path.write_text(json.dumps(record))
    result = engine.get(initial['id'])
    assert result['stage'] == 'ready' and result['validation']['historical_accuracy'] == 'failed_visual_review'
    assert result['review']['notes'] == ['Modern road markings']
    assert 'private_diagnostic' not in result['review']
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("saved_stage", ["paused", "error"])
async def test_explicit_resume_download_keeps_paid_receipts_and_cost(tmp_path, saved_stage):
    async def broken_download(*_args):
        raise AssetError("download_failed", "Asset download failed.")

    client = FakeClient(tmp_path)
    engine = manager(tmp_path, client)
    engine._asset_downloader = broken_download
    job = await engine.start(PLAN)
    result = await finish(engine, job["id"])
    assert result["stage"] == "paused" and result["can_resume"] is True
    # Older persisted jobs may classify a download failure as terminal error.
    record_path = tmp_path / job["id"] / "record.json"
    record = json.loads(record_path.read_text())
    record["stage"] = saved_stage
    record_path.write_text(json.dumps(record))
    costs = result["cost_credits"]
    assert engine.get(job["id"])["can_resume"] is True
    client.calls.clear()
    engine._asset_downloader = assets_download
    resumed = await engine.resume(job["id"])
    assert resumed["can_resume"] is False
    assert (await engine.resume(job["id"]))["id"] == job["id"]
    ready = await finish(engine, job["id"])
    assert ready["stage"] == "ready" and ready["can_resume"] is False
    assert ready["cost_credits"] == costs
    assert ready["generation_calls"] == {"depth": 1, "world": 1}
    assert not any(call.endswith("_post") for call in client.calls)
    await engine.aclose()


@pytest.mark.asyncio
async def test_resume_refuses_attempt_without_durable_operation_even_if_paused(tmp_path):
    client = FakeClient(tmp_path, fail_depth=True)
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN)
    await finish(engine, job["id"])
    record_path = tmp_path / job["id"] / "record.json"
    record = json.loads(record_path.read_text())
    record.update(stage="paused", error_code="interrupted")
    record_path.write_text(json.dumps(record))
    assert engine.get(job["id"])["can_resume"] is False
    with pytest.raises(MarbleError) as refused:
        await engine.resume(job["id"])
    assert refused.value.code == "resume_not_allowed"
    await engine.resume_all()
    assert (await finish(engine, job["id"]))["stage"] == "submission_unknown"
    assert client.calls.count("depth_post") == 1
    await engine.aclose()


@pytest.mark.asyncio
async def test_changed_bound_evidence_produces_distinct_generation_hash(tmp_path):
    client = FakeClient(tmp_path)
    engine = manager(tmp_path, client)
    first = await engine.start(PLAN)
    changed = await engine.start({**PLAN, "sources": [{"id": "archive-1", "title": "New bound historical evidence"}]})
    assert first["id"] != changed["id"]
    await engine.aclose()
    assert not client.calls


@pytest.mark.asyncio
async def test_updated_content_hash_reuses_legacy_job_without_recharging(tmp_path):
    client = FakeClient(tmp_path)
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN)
    ready = await finish(engine, job["id"])
    original = tmp_path / job["id"]
    legacy_id = "f" * 32
    record = json.loads((original / "record.json").read_text())
    record.update(id=legacy_id, plan_hash="old-hash-with-ui-metadata")
    (original / "record.json").write_text(json.dumps(record))
    original.rename(tmp_path / legacy_id)
    reused = await engine.start({**PLAN, "created_at": 99999999, "plan_id": "recached-plan"})
    assert reused["id"] == legacy_id and reused["stage"] == "ready"
    assert reused["cost_credits"] == ready["cost_credits"]
    assert client.calls.count("depth_post") == client.calls.count("world_post") == 1
    await engine.aclose()
