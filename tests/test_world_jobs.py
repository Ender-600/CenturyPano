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


def operation(stage, *, done=True, world_cost=1500):
    return {"operation_id": f"operation-{stage}", "done": done,
            "cost": {"total_credits": 80 if stage == "depth" else world_cost},
            "response": {"pano_url": f"https://cdn.marble.worldlabs.ai/{SECRET}.png"} if stage == "depth"
            else {"world_id": "world-1"}}


class FakeClient:
    def __init__(self, root, *, fail_depth=False, fail_world=False, wait_stage=None, balance=10000,
                 expected_model="marble-1.1"):
        self.root = root
        self.fail_depth = fail_depth
        self.fail_world = fail_world
        self.wait_stage = wait_stage
        self.balance = balance
        self.expected_model = expected_model
        self.world_cost = 150 if expected_model == "marble-1.0-draft" else 1500
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
        assert settings == {"model": self.expected_model, "is_pano": True}
        assert "historical RGB panorama" in prompt and "depth panorama" not in prompt
        image = Image.open(io.BytesIO(data))
        assert image.format == "JPEG" and image.size == (128, 64)
        self.calls.append("world_post")
        if self.fail_world:
            raise SubmissionUnknown()
        return operation("world", done=self.wait_stage != "world", world_cost=self.world_cost)

    async def operation(self, operation_id):
        self.calls.append(operation_id)
        stage = operation_id.split("-")[-1]
        if self.wait_stage == stage:
            self.entered.set()
            await asyncio.Future()
        return operation(stage, world_cost=self.world_cost)

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
    assert result['cost_credits']['total'] == 1580
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
    assert result["model"] == "marble-1.1"
    assert result["generation_calls"] == {"depth": 1, "world": 1}
    assert result["cost_credits"] == {"depth": 80, "world": 1500, "known_total": 1580, "total": 1580}
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
@pytest.mark.parametrize("model", ["marble-1.1", "marble-1.0-draft"])
async def test_shutdown_and_resume_query_saved_operation_without_repeating_paid_stage(tmp_path, wait_stage, model):
    first = FakeClient(tmp_path, wait_stage=wait_stage, expected_model=model)
    engine = manager(tmp_path, first)
    job = await engine.start(PLAN, model=model)
    await asyncio.wait_for(first.entered.wait(), 3)
    await engine.aclose()
    assert engine.get(job["id"])["stage"] == "paused"
    second = FakeClient(tmp_path, expected_model=model)
    resumed = manager(tmp_path, second)
    await resumed.resume_all()
    result = await finish(resumed, job["id"])
    assert result["stage"] == "ready", result
    assert result["model"] == model
    assert "depth_post" not in second.calls
    assert ("world_post" in second.calls) == (wait_stage == "depth")
    assert result["generation_calls"] == {"depth": 1, "world": 1}
    assert result["cost_credits"]["total"] == 80 + first.world_cost
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
    assert result["cost_credits"]["total"] == 1580
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


@pytest.mark.asyncio
async def test_default_quality_job_does_not_reuse_ready_draft_cache(tmp_path, monkeypatch):
    client = FakeClient(tmp_path, expected_model="marble-1.0-draft")
    engine = manager(tmp_path, client)
    draft = await engine.start(PLAN, model="marble-1.0-draft")
    assert (await finish(engine, draft["id"]))["stage"] == "ready"
    # Simulate an old cache key to also exercise the compatibility scan.
    directory = tmp_path / draft["id"]
    legacy_id = "e" * 32
    record = json.loads((directory / "record.json").read_text())
    record.update(id=legacy_id, plan_hash="legacy-draft-key")
    (directory / "record.json").write_text(json.dumps(record))
    directory.rename(tmp_path / legacy_id)
    monkeypatch.setattr(engine, "_schedule", lambda _job_id: None)
    standard = await engine.start(PLAN)
    assert standard["model"] == "marble-1.1" and standard["stage"] == "queued"
    assert standard["id"] not in {draft["id"], legacy_id}
    assert (await engine.start(PLAN))["id"] == standard["id"]
    assert (await engine.start(PLAN, model="marble-1.0-draft"))["id"] == legacy_id
    assert client.calls.count("world_post") == 1
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["marble-1.0", "marble-1.1-plus", "unknown", None, []])
async def test_unsupported_world_model_stops_before_job_creation(tmp_path, model):
    client = FakeClient(tmp_path)
    engine = manager(tmp_path, client)
    with pytest.raises(ValueError, match="Unsupported world generation model"):
        await engine.start(PLAN, model=model)
    assert not client.calls and not list(tmp_path.glob("*/record.json"))
    await engine.aclose()


# The RGB path uses a real 2:1 JPEG fixture; all provider calls stay offline.
def source_jpeg():
    output = io.BytesIO()
    Image.new('RGB', (128, 64), (75, 95, 115)).save(output, 'JPEG')
    return output.getvalue()


def photo_plan(**overrides):
    import hashlib
    return {'plan_id': '11111111-2222-3333-4444-555555555555', 'target_year': 1925,
            'input_kind': 'streetview_panorama', 'generation_profile': 'streetview-rgb-history-v1',
            'source': 'google_streetview', 'historical_buildings': [], 'modern_buildings': [],
            'camera_position': [0, 0, 0], 'history_context': {'period_summary': 'Campus in 1925'},
            'panorama_editor': {'model': 'gpt-image-test', 'quality': 'medium'},
            'source_panorama': {'filename': 'source_panorama.jpg',
                                'sha256': hashlib.sha256(source_jpeg()).hexdigest(),
                                'metadata': {'pano_id': 'example-pano', 'lat': 40.443, 'lon': -79.944,
                                             'heading': 42, 'date': '2024-06'}},
            'location': {'lat': 40.4431, 'lon': -79.9442, 'location_source': 'device',
                         'accuracy_m': 8, 'timestamp_ms': 1000}, **overrides}


class FakeEditor:
    api_key = 'offline-editor-key'
    model = 'gpt-image-test'

    def __init__(self, root, *, error=None, wait=False):
        self.root = root
        self.calls = []
        self.error = error
        self.wait = wait
        self.entered = asyncio.Event()

    async def edit(self, data, prompt):
        record = json.loads(next(self.root.glob('*/record.json')).read_text())
        assert record['stage'] == 'submitting_image_edit'
        assert record['generation_calls']['image_edit'] == 1
        assert record['image_edit_attempted'] is True
        assert data == source_jpeg()
        assert '1925' in prompt and '40.443000' in prompt
        self.calls.append('image_post')
        if self.error:
            raise self.error
        if self.wait:
            self.entered.set()
            await asyncio.Future()
        return {'image_bytes': png(), 'model': self.model, 'usage': {
            'input_tokens': 100, 'output_tokens': 250, 'total_tokens': 350,
            'malicious': 'do not publish', 'nested_key': 'sk-not-real',
        }}


def photo_manager(root, client, editor, **overrides):
    return manager(root, client, panorama_editor_factory=lambda: editor,
                   source_loader=lambda _plan: source_jpeg(), **overrides)


@pytest.mark.asyncio
async def test_photo_pipeline_skips_geometry_and_depth_and_preserves_source_sha(tmp_path):
    client = FakeClient(tmp_path)
    editor = FakeEditor(tmp_path)
    engine = photo_manager(tmp_path, client, editor)
    def forbidden_renderer(**_arguments):
        raise AssertionError('The photo pipeline must never render coarse geometry')
    engine._renderer = forbidden_renderer
    initial = await engine.start(photo_plan())
    result = await finish(engine, initial['id'])
    assert result['stage'] == 'ready', result
    assert editor.calls == ['image_post']
    assert 'depth_post' not in client.calls
    assert client.calls.count('world_post') == 1
    assert result['generation_calls'] == {'image_edit': 1, 'world': 1}
    assert result['cost_credits'] == {'depth': None, 'world': 1500, 'known_total': 1500, 'total': 1500}
    assert result['image_edit_usage'] == {'input_tokens': 100, 'output_tokens': 250, 'total_tokens': 350}
    assert result['image_edit_billing']['included_in_worldlabs_credits'] is False
    assert result['image_edit_billing']['amount'] is None
    assert result['input_kind'] == 'streetview_panorama'
    assert result['validation']['geometry'] == 'generated_from_rgb_unverified'
    assert {item['kind'] for item in result['assets']} == {'source_pano', 'historical_pano', 'spz'}
    assert engine.artifact_path(initial['id'], 'source_panorama.jpg').read_bytes() == source_jpeg()
    public = json.dumps(result)
    assert 'sk-not-real' not in public and SECRET not in public and str(tmp_path) not in public
    assert engine.artifact_path(initial['id'], 'image_edit_receipt.json') is None
    assert engine.artifact_path(initial['id'], 'plan.json') is None
    await engine.aclose()


@pytest.mark.asyncio
async def test_photo_same_capture_reuses_world_across_new_gps_fixes_and_ui_ids(tmp_path):
    client = FakeClient(tmp_path)
    editor = FakeEditor(tmp_path)
    engine = photo_manager(tmp_path, client, editor)
    original = photo_plan()
    initial = await engine.start(original)
    await finish(engine, initial['id'])
    moved = photo_plan(plan_id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', created_at=99999,
                       location={'lat': 40.444, 'lon': -79.943, 'location_source': 'test',
                                 'accuracy_m': 100, 'timestamp_ms': 9999})
    moved['source_panorama']['metadata']['distance_m'] = 60
    again = await engine.start(moved)
    assert again['id'] == initial['id']
    assert again['plan_id'] == original['plan_id']
    assert editor.calls == ['image_post']
    assert client.calls.count('world_post') == 1
    await engine.aclose()


def test_photo_hash_changes_for_source_image_capture_year_history_and_editor_profile():
    from app.worlds.jobs import _generation_hash
    original = photo_plan()
    for change in ('sha256', 'lat', 'year', 'history', 'model', 'quality'):
        changed = deepcopy(original)
        if change == 'sha256':
            changed['source_panorama']['sha256'] = '0' * 64
        elif change == 'lat':
            changed['source_panorama']['metadata']['lat'] += .001
        elif change == 'year':
            changed['target_year'] = 1946
        elif change == 'history':
            changed['history_context']['period_summary'] = 'Corrected archival evidence'
        else:
            changed['panorama_editor'][change] = 'high' if change == 'quality' else 'another-model'
        assert _generation_hash(changed) != _generation_hash(original)


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['missing_key', 'low_balance'])
async def test_photo_preflight_blocks_edit_before_paid_marker(tmp_path, kind):
    client = FakeClient(tmp_path, balance=149 if kind == 'low_balance' else 1000)
    editor = FakeEditor(tmp_path)
    if kind == 'missing_key':
        editor.api_key = ''
    engine = photo_manager(tmp_path, client, editor)
    job = await engine.start(photo_plan())
    result = await finish(engine, job['id'])
    assert result['error_code'] == ('not_configured' if kind == 'missing_key' else 'insufficient_credits')
    assert result['generation_calls'] == {'image_edit': 0, 'world': 0}
    assert editor.calls == [] and 'world_post' not in client.calls
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("model,required", [("marble-1.1", 1500), ("marble-1.0-draft", 150)])
@pytest.mark.parametrize("shortfall", [0, 1])
async def test_photo_checks_selected_world_price_before_image_edit(tmp_path, model, required, shortfall):
    client = FakeClient(tmp_path, expected_model=model, balance=required - shortfall)
    editor = FakeEditor(tmp_path)
    engine = photo_manager(tmp_path, client, editor)
    job = await engine.start(photo_plan(), model=model)
    result = await finish(engine, job["id"])
    assert result["model"] == model
    if shortfall:
        assert result["stage"] == "insufficient_credits"
        assert result["generation_calls"] == {"image_edit": 0, "world": 0}
        assert editor.calls == [] and client.calls == ["credits"]
    else:
        assert result["stage"] == "ready"
        assert editor.calls == ["image_post"] and client.calls.count("world_post") == 1
        assert result["cost_credits"]["world"] == required
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("model,required", [("marble-1.1", 1500), ("marble-1.0-draft", 150)])
async def test_depth_preflight_needs_credit_above_reserved_world_price(tmp_path, model, required):
    client = FakeClient(tmp_path, expected_model=model, balance=required)
    engine = manager(tmp_path, client)
    job = await engine.start(PLAN, model=model)
    result = await finish(engine, job["id"])
    assert result["stage"] == "insufficient_credits"
    assert result["generation_calls"] == {"depth": 0, "world": 0}
    assert client.calls == ["credits"]
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("model,required", [("marble-1.1", 1500), ("marble-1.0-draft", 150)])
@pytest.mark.parametrize("input_kind", ["depth", "photo"])
async def test_world_submission_rechecks_model_price_after_panorama(tmp_path, model, required, input_kind):
    class DepletedClient(FakeClient):
        async def credits(self):
            if "credits" in self.calls:
                self.balance = required - 1
            return await super().credits()

    client = DepletedClient(tmp_path, expected_model=model, balance=required + 100)
    editor = FakeEditor(tmp_path)
    engine = photo_manager(tmp_path, client, editor) if input_kind == "photo" else manager(tmp_path, client)
    job = await engine.start(photo_plan() if input_kind == "photo" else PLAN, model=model)
    result = await finish(engine, job["id"])
    assert result["stage"] == "insufficient_credits"
    assert result["generation_calls"]["world"] == 0 and "world_post" not in client.calls
    assert result["credits_before_world"] == required - 1
    assert result["generation_calls"]["image_edit" if input_kind == "photo" else "depth"] == 1
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize('unknown', [False, True])
async def test_photo_editor_rejection_or_unknown_is_never_reposted(tmp_path, unknown):
    from app.worlds.panorama import PanoramaEditError, PanoramaSubmissionUnknown
    client = FakeClient(tmp_path)
    editor = FakeEditor(tmp_path, error=PanoramaSubmissionUnknown(503) if unknown else PanoramaEditError('authentication_failed', 401))
    engine = photo_manager(tmp_path, client, editor)
    job = await engine.start(photo_plan())
    result = await finish(engine, job['id'])
    assert result['stage'] == ('submission_unknown' if unknown else 'error')
    assert result['http_status'] == (503 if unknown else 401)
    assert result['can_resume'] is False
    assert editor.calls == ['image_post'] and 'world_post' not in client.calls
    await engine.aclose()
    new_editor = FakeEditor(tmp_path)
    resumed = photo_manager(tmp_path, FakeClient(tmp_path), new_editor)
    await resumed.resume_all()
    assert not resumed._tasks
    assert (await resumed.start(photo_plan()))['id'] == job['id']
    assert new_editor.calls == []
    with pytest.raises(MarbleError, match='cannot be safely resumed'):
        await resumed.resume(job['id'])
    await resumed.aclose()


@pytest.mark.asyncio
async def test_photo_cancellation_during_edit_has_no_receipt_and_cannot_resume(tmp_path):
    client, editor = FakeClient(tmp_path), FakeEditor(tmp_path, wait=True)
    engine = photo_manager(tmp_path, client, editor)
    job = await engine.start(photo_plan())
    await asyncio.wait_for(editor.entered.wait(), 3)
    await engine.aclose()
    result = engine.get(job['id'])
    assert result['stage'] == 'submission_unknown'
    assert result['can_resume'] is False
    # An incorrectly paused old state still cannot repeat an attempted image POST.
    path = tmp_path / job['id'] / 'record.json'
    record = json.loads(path.read_text())
    record['stage'] = 'paused'
    path.write_text(json.dumps(record))
    resumed_editor = FakeEditor(tmp_path)
    resumed_client = FakeClient(tmp_path)
    resumed = photo_manager(tmp_path, resumed_client, resumed_editor)
    assert resumed.get(job['id'])['can_resume'] is False
    await resumed.resume_all()
    outcome = await finish(resumed, job['id'])
    assert outcome['stage'] == 'submission_unknown'
    assert resumed_editor.calls == [] and resumed_client.calls == []
    await resumed.aclose()


@pytest.mark.asyncio
async def test_photo_receipt_survives_interruption_before_pano_ready_record(tmp_path):
    editor, client = FakeEditor(tmp_path), FakeClient(tmp_path)
    engine = photo_manager(tmp_path, client, editor)
    stage = engine._stage
    def interrupt_before_ready(record, name):
        if name == 'pano_ready':
            raise asyncio.CancelledError()
        return stage(record, name)
    engine._stage = interrupt_before_ready
    job = await engine.start(photo_plan())
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(engine._tasks[job['id']], 3)
    result = engine.get(job['id'])
    assert result['stage'] == 'paused' and result['can_resume'] is True
    assert (tmp_path / job['id'] / 'image_edit_receipt.json').is_file()
    assert 'world_post' not in client.calls
    await engine.aclose()
    resumed_editor = FakeEditor(tmp_path)
    resumed_editor.api_key = ''  # A stored receipt needs no OpenAI credentials.
    resumed_client = FakeClient(tmp_path)
    resumed = photo_manager(tmp_path, resumed_client, resumed_editor)
    await resumed.resume_all()
    ready = await finish(resumed, job['id'])
    assert ready['stage'] == 'ready'
    assert resumed_editor.calls == []
    assert resumed_client.calls.count('world_post') == 1
    await resumed.aclose()


@pytest.mark.asyncio
async def test_photo_saved_world_operation_resumes_without_image_or_world_post(tmp_path):
    editor, client = FakeEditor(tmp_path), FakeClient(tmp_path, wait_stage='world')
    engine = photo_manager(tmp_path, client, editor)
    job = await engine.start(photo_plan())
    await asyncio.wait_for(client.entered.wait(), 3)
    await engine.aclose()
    resumed_editor, resumed_client = FakeEditor(tmp_path), FakeClient(tmp_path)
    resumed = photo_manager(tmp_path, resumed_client, resumed_editor)
    await resumed.resume_all()
    result = await finish(resumed, job['id'])
    assert result['stage'] == 'ready'
    assert resumed_editor.calls == []
    assert 'world_post' not in resumed_client.calls and 'depth_post' not in resumed_client.calls
    assert result['cost_credits']['total'] == 1500
    await resumed.aclose()


@pytest.mark.asyncio
async def test_photo_source_hash_mismatch_stops_before_any_provider_call(tmp_path):
    client, editor = FakeClient(tmp_path), FakeEditor(tmp_path)
    engine = photo_manager(tmp_path, client, editor)
    plan = photo_plan()
    plan['source_panorama']['sha256'] = '0' * 64
    job = await engine.start(plan)
    result = await finish(engine, job['id'])
    assert result['error_code'] == 'source_hash_mismatch'
    assert result['generation_calls']['image_edit'] == 0
    assert client.calls == [] and editor.calls == []
    await engine.aclose()


@pytest.mark.asyncio
async def test_photo_source_uses_private_plan_uuid_and_rejects_path_overrides(tmp_path):
    root = tmp_path / 'jobs'
    client, editor = FakeClient(root), FakeEditor(root)
    engine = WorldJobManager(root, 'offline-key', client_factory=lambda: client,
                             panorama_editor_factory=lambda: editor, asset_downloader=assets_download, poll_s=.001)
    plan = photo_plan()
    source_dir = tmp_path / 'plans' / plan['plan_id']
    source_dir.mkdir(parents=True)
    (source_dir / 'source_panorama.jpg').write_bytes(source_jpeg())
    job = await engine.start(plan)
    assert (await finish(engine, job['id']))['stage'] == 'ready'
    for bad in ({'plan_id': '../../elsewhere'}, {'source_panorama': {**plan['source_panorama'], 'filename': '../../secret'}}):
        with pytest.raises(ValueError, match='Invalid frozen'):
            await engine.start({**plan, **bad})
    await engine.aclose()


@pytest.mark.asyncio
async def test_photo_corrupted_receipt_output_never_repeats_edit(tmp_path):
    editor, client = FakeEditor(tmp_path), FakeClient(tmp_path, wait_stage='world')
    engine = photo_manager(tmp_path, client, editor)
    job = await engine.start(photo_plan())
    await asyncio.wait_for(client.entered.wait(), 3)
    await engine.aclose()
    (tmp_path / job['id'] / 'historical_panorama.jpg').write_bytes(b'corrupted-image')
    resumed_editor, resumed_client = FakeEditor(tmp_path), FakeClient(tmp_path)
    resumed = photo_manager(tmp_path, resumed_client, resumed_editor)
    assert resumed.get(job['id'])['can_resume'] is False
    await resumed.resume_all()
    result = await finish(resumed, job['id'])
    assert result['stage'] == 'submission_unknown'
    assert resumed_editor.calls == [] and resumed_client.calls == []
    await resumed.aclose()


@pytest.mark.asyncio
async def test_photo_private_source_symlink_cannot_escape_plan_root(tmp_path):
    root = tmp_path / 'jobs'
    client, editor = FakeClient(root), FakeEditor(root)
    engine = WorldJobManager(root, 'offline-key', client_factory=lambda: client,
                             panorama_editor_factory=lambda: editor, asset_downloader=assets_download, poll_s=.001)
    plan = photo_plan()
    outside = tmp_path / 'outside.jpg'
    outside.write_bytes(source_jpeg())
    source_dir = tmp_path / 'plans' / plan['plan_id']
    source_dir.mkdir(parents=True)
    (source_dir / 'source_panorama.jpg').symlink_to(outside)
    job = await engine.start(plan)
    result = await finish(engine, job['id'])
    assert result['error_code'] == 'invalid_source_path'
    assert result['generation_calls']['image_edit'] == 0
    assert editor.calls == [] and client.calls == []
    await engine.aclose()
