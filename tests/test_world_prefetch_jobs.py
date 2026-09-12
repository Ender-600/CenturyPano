"""Offline prediction queue, shared image billing and crash-recovery regressions."""
import asyncio
from copy import deepcopy
import hashlib
import io
import json
import time
import uuid

from PIL import Image
import pytest

from app.worlds.jobs import WorldJobManager, _panorama_hash
from app.worlds.panorama import PanoramaSubmissionUnknown
from app.worlds.paid_queue import paid_queue


def jpeg():
    output = io.BytesIO()
    Image.new("RGB", (128, 64), "steelblue").save(output, "JPEG")
    return output.getvalue()


def plan(point="A", **overrides):
    return {"plan_id": str(uuid.uuid4()), "target_year": 1925, "input_kind": "streetview_panorama",
            "historical_buildings": [], "camera_position": [0, 0, 0],
            "history_context": {"period_summary": f"POINT {point}."},
            "panorama_editor": {"model": "gpt-image-test", "quality": "medium"},
            "source_panorama": {"filename": "source_panorama.jpg", "sha256": hashlib.sha256(jpeg()).hexdigest(),
                                "metadata": {"pano_id": point, "lat": 40.443, "lon": -79.944,
                                             "heading": 42, "date": "2024-06"}}, **overrides}


class Editor:
    api_key = "offline-test-key"

    def __init__(self, *, block=None, error=None):
        self.calls = []
        self.block = block
        self.error = error
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def edit(self, source, prompt):
        point = prompt.split("POINT ")[1].split(".")[0]
        self.calls.append(point)
        assert source == jpeg()
        if point == self.block:
            self.entered.set()
            await self.release.wait()
        if self.error:
            raise self.error
        return {"image_bytes": jpeg(), "model": "gpt-image-test", "usage": {"total_tokens": 300}}


class Marble:
    def __init__(self):
        self.calls = []

    async def credits(self):
        self.calls.append("credits")
        return {"remaining_credits": 10000}

    async def generate_image(self, data, prompt, display_name, **kwargs):
        self.calls.append("world_post")
        return {"operation_id": "operation-world", "done": True,
                "cost": {"total_credits": 1500}, "response": {"world_id": "world-1"}}

    async def world(self, world_id):
        return {"world_id": world_id}

    async def aclose(self):
        pass


async def assets(world, directory):
    directory.mkdir(exist_ok=True)
    path = directory / "scene.spz"
    path.write_bytes(b"offline-spz")
    return [{"kind": "spz", "path": str(path)}]


def manager(root, editor, marble=None):
    def client():
        assert marble is not None, "Panorama-only work must not construct a Marble client"
        return marble
    return WorldJobManager(root, "world-key" if marble else "", client_factory=client,
        source_loader=lambda _: jpeg(), panorama_editor_factory=lambda: editor,
        asset_downloader=assets, poll_s=.001)


async def finish(engine, job):
    task = engine._tasks.get(job["id"])
    if task:
        await asyncio.wait_for(asyncio.shield(task), 3)
    return engine.get(job["id"])


@pytest.mark.asyncio
async def test_panorama_only_deduplicates_without_worldlabs_and_publishes_local_asset(tmp_path):
    editor = Editor()
    engine = manager(tmp_path, editor)
    first, duplicate = await asyncio.gather(engine.start_panorama(plan()), engine.start_panorama(plan()))
    assert first["id"] == duplicate["id"]
    ready = await finish(engine, first)
    assert ready["kind"] == "panorama" and ready["stage"] == "ready"
    assert editor.calls == ["A"] and ready["generation_calls"] == {"image_edit": 1, "world": 0}
    assert ready["cost_credits"]["total"] == 0
    assert ready["image_edit_billing"]["included_in_worldlabs_credits"] is False
    assert {item["kind"] for item in ready["assets"]} == {"source_pano", "historical_pano"}
    image = next(item for item in ready["assets"] if item["kind"] == "historical_pano")
    assert engine.artifact_path(ready["id"], image["filename"]).is_file()
    assert "total_to_assets" in ready["timing_s"] and "image_edit" in ready["timing_s"]
    assert engine.artifact_path(ready["id"], "image_edit_receipt.json") is None
    assert str(tmp_path) not in json.dumps(ready)
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("inflight", [False, True])
async def test_world_reuses_complete_or_inflight_prediction_without_another_image_post(tmp_path, inflight):
    editor, marble = Editor(block="A" if inflight else None), Marble()
    engine = manager(tmp_path, editor, marble)
    prediction = await engine.start_panorama(plan())
    if inflight:
        await asyncio.wait_for(editor.entered.wait(), 1)
    else:
        await finish(engine, prediction)
    foreground = await engine.start(plan())
    editor.release.set()
    ready = await finish(engine, foreground)
    assert ready["stage"] == "ready" and ready["image_edit_reused_from"] == prediction["id"]
    assert ready["generation_calls"] == {"image_edit": 0, "world": 1}
    assert editor.calls == ["A"] and marble.calls.count("world_post") == 1
    assert (await finish(engine, prediction))["stage"] == "ready"
    await engine.aclose()


@pytest.mark.asyncio
async def test_panorama_reuses_prior_world_image_even_after_restart(tmp_path):
    editor = Editor()
    engine = manager(tmp_path, editor, Marble())
    world = await engine.start(plan())
    assert (await finish(engine, world))["stage"] == "ready"
    await engine.aclose()
    next_editor = Editor()
    next_engine = manager(tmp_path, next_editor)
    prediction = await next_engine.start_panorama(plan())
    ready = await finish(next_engine, prediction)
    assert ready["stage"] == "ready" and ready["image_edit_reused_from"] == world["id"]
    assert not next_editor.calls
    await next_engine.aclose()


@pytest.mark.asyncio
async def test_foreground_overtakes_queued_prediction_across_manager_instances(tmp_path):
    editor = Editor(block="A")
    engine, other = manager(tmp_path, editor), manager(tmp_path, editor)
    running = await engine.start_panorama(plan("A"))
    await asyncio.wait_for(editor.entered.wait(), 1)
    pending = await engine.start_panorama(plan("B"))
    foreground = await other.start_panorama(plan("C"), speculative=False)
    await asyncio.sleep(.03)
    editor.release.set()
    await asyncio.gather(finish(engine, running), finish(engine, pending), finish(other, foreground))
    assert editor.calls == ["A", "C", "B"]
    assert other.get(foreground["id"])["expires_at"] is None
    await other.aclose()
    await engine.aclose()


@pytest.mark.asyncio
async def test_only_latest_prediction_waits_and_cancel_does_not_interrupt_paid_request(tmp_path):
    editor = Editor(block="A")
    engine = manager(tmp_path, editor)
    running = await engine.start_panorama(plan("A"))
    await asyncio.wait_for(editor.entered.wait(), 1)
    old = await engine.start_panorama(plan("B"))
    newest = await engine.start_panorama(plan("C"))
    assert (await finish(engine, old))["stage"] == "cancelled"
    assert (await engine.cancel_panorama(running["id"]))["stage"] == "submitting_image_edit"
    cancelled = await engine.cancel_panorama(newest["id"])
    assert cancelled["stage"] == "cancelled" and cancelled["can_cancel"] is False
    assert (await finish(engine, newest))["stage"] == "cancelled"
    editor.release.set()
    assert (await finish(engine, running))["stage"] == "ready"
    assert editor.calls == ["A"]
    await engine.aclose()


@pytest.mark.asyncio
async def test_expired_prediction_never_submits_and_explicit_selection_can_revive_it(tmp_path):
    editor = Editor(block="A")
    engine = manager(tmp_path, editor)
    running = await engine.start_panorama(plan("A"))
    await asyncio.wait_for(editor.entered.wait(), 1)
    expired_plan = plan("B")
    expired = await engine.start_panorama(expired_plan, expires_at=time.time() + .03)
    assert (await finish(engine, expired))["stage"] == "expired"
    foreground = await engine.start_panorama(expired_plan, speculative=False)
    assert foreground["id"] == expired["id"] and foreground["expires_at"] is None
    editor.release.set()
    assert (await finish(engine, foreground))["stage"] == "ready"
    await finish(engine, running)
    assert editor.calls == ["A", "B"]
    await engine.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("discard", ["cancelled", "expired"])
async def test_returning_to_discarded_point_renews_prediction_without_permanent_priority(tmp_path, discard):
    editor = Editor(block="A")
    engine = manager(tmp_path, editor)
    running = await engine.start_panorama(plan("A"), speculative=False)
    await asyncio.wait_for(editor.entered.wait(), 1)
    candidate_plan = plan("B")
    candidate = await engine.start_panorama(candidate_plan,
        expires_at=time.time() - 1 if discard == "expired" else None)
    if discard == "cancelled":
        await engine.cancel_panorama(candidate["id"])
    assert (await finish(engine, candidate))["stage"] == discard
    renewed = await engine.start_panorama(candidate_plan)
    assert renewed["stage"] == "queued" and renewed["expires_at"] > time.time()
    editor.release.set()
    assert (await finish(engine, renewed))["stage"] == "ready"
    assert (await finish(engine, running))["stage"] == "ready"
    assert editor.calls == ["A", "B"]
    await engine.start_panorama(plan("A"), speculative=False)
    assert not paid_queue(engine.root_dir).foreground_images
    assert not paid_queue(engine.root_dir).promotions
    await engine.aclose()


@pytest.mark.asyncio
async def test_unknown_submission_blocks_prediction_world_and_restart_reposts(tmp_path):
    editor = Editor(error=PanoramaSubmissionUnknown(503))
    engine = manager(tmp_path, editor)
    prediction = await engine.start_panorama(plan())
    assert (await finish(engine, prediction))["stage"] == "submission_unknown"
    await engine.aclose()
    next_editor, marble = Editor(), Marble()
    restarted = manager(tmp_path, next_editor, marble)
    await restarted.resume_all()
    assert not restarted._tasks
    assert (await restarted.start_panorama(plan()))["stage"] == "submission_unknown"
    world = await restarted.start(plan())
    assert (await finish(restarted, world))["stage"] == "submission_unknown"
    assert not next_editor.calls and not marble.calls
    await restarted.aclose()


@pytest.mark.asyncio
async def test_shutdown_during_image_submission_is_unknown_without_receipt(tmp_path):
    editor = Editor(block="A")
    engine = manager(tmp_path, editor)
    prediction = await engine.start_panorama(plan())
    await asyncio.wait_for(editor.entered.wait(), 1)
    await engine.aclose()
    assert engine.get(prediction["id"])["stage"] == "submission_unknown"
    next_editor = Editor()
    restarted = manager(tmp_path, next_editor)
    await restarted.resume_all()
    assert not restarted._tasks and not next_editor.calls
    await restarted.aclose()


@pytest.mark.asyncio
async def test_panorama_receipt_resume_needs_no_worldlabs_or_openai_key(tmp_path):
    editor = Editor()
    engine = manager(tmp_path, editor)
    original_stage = engine._stage
    def interrupted(record, stage):
        if stage == "pano_ready":
            raise asyncio.CancelledError()
        original_stage(record, stage)
    engine._stage = interrupted
    prediction = await engine.start_panorama(plan(), speculative=False)
    with pytest.raises(asyncio.CancelledError):
        await finish(engine, prediction)
    assert engine.get(prediction["id"])["can_resume"] is True
    await engine.aclose()
    next_editor = Editor()
    next_editor.api_key = ""
    restarted = manager(tmp_path, next_editor)
    resumed = await restarted.resume(prediction["id"])
    assert (await finish(restarted, resumed))["stage"] == "ready"
    assert not next_editor.calls
    await restarted.aclose()


def test_panorama_cache_includes_effective_prompt_profile_and_source_but_not_ui_fix():
    original = plan()
    moved = {**original, "plan_id": str(uuid.uuid4()), "location": {"lat": 40.444, "lon": -79.944}}
    assert _panorama_hash(moved) == _panorama_hash(original)
    for key in ("source", "quality", "model", "year", "prompt"):
        changed = deepcopy(original)
        if key == "source":
            changed["source_panorama"]["sha256"] = "0" * 64
        elif key in {"quality", "model"}:
            changed["panorama_editor"][key] = "high" if key == "quality" else "another-model"
        elif key == "year":
            changed["target_year"] = 1946
        else:
            changed["history_context"]["period_summary"] = "Corrected historical account"
        assert _panorama_hash(changed) != _panorama_hash(original)
