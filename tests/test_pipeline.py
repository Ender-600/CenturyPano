import asyncio
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app import constraints, pipeline, scene
from app.config import settings
from app.geometry import image_bytes, open_rgb
from app.manifest import update_manifest


class FakePool:
    instances = []
    fail_tile = False
    fail_anchor = False

    def __init__(self, **kwargs):
        self.image_calls = 0
        self.max_concurrency = 6
        self.active = 0
        self.peak = 0
        self.prompts = []
        FakePool.instances.append(self)

    async def edit(self, image, prompt, **kwargs):
        self.image_calls += 1
        call = self.image_calls
        self.prompts.append(prompt)
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(.1)
            if self.fail_anchor and call == 1 or self.fail_tile and call == 2:
                raise RuntimeError("Simulated unavailable provider")
            source = open_rgb(image)
            array = np.asarray(source, dtype=np.float32)
            array *= np.array([1.03, .91, .73], dtype=np.float32)
            output = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
            return SimpleNamespace(image=image_bytes(output), provider="demo", attempts=1)
        finally:
            self.active -= 1


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "in_dir", tmp_path / "in")
    monkeypatch.setattr(settings, "out_dir", tmp_path / "out")
    monkeypatch.setattr(settings, "provider", "demo")
    monkeypatch.setattr(settings, "max_concurrency", 3)
    settings.in_dir.mkdir()
    settings.out_dir.mkdir()
    # A real spatially varying image makes overlapping originals a useful floor.
    image = np.zeros((240, 600, 3), dtype=np.uint8)
    image[:, :, 0] = np.linspace(20, 220, 600).astype(np.uint8)
    image[:, :, 1] = np.linspace(40, 190, 240).astype(np.uint8)[:, None]
    image[:, :, 2] = 145
    Image.fromarray(image).save(settings.in_dir / "source.jpg", "JPEG")
    FakePool.instances = []
    FakePool.fail_tile = False
    FakePool.fail_anchor = False
    monkeypatch.setattr(pipeline, "EditorPool", FakePool)
    # The fake provider answers in 100 ms; a real head start would serialise it.
    monkeypatch.setattr(settings, "priority_stagger_s", 0.0)
    return tmp_path


def create_job(job_id, decade="1920s", *, target_year=None):
    update_manifest(job_id, lambda m: m.update({
        "job_id": job_id, "status": "running", "decade": decade, "provider": "demo",
        "source": {"path": "in/source.jpg", "w": 600, "h": 240, "is_360": False},
        "place": {"name": "Pittsburgh", "cc": "US", "source": "manual"},
        "heading": .5, "job_seed": 12,
    }))
    if target_year is not None:
        update_manifest(job_id, lambda m: m.update(target_year=target_year))


def test_complete_pipeline_progress_cache_and_serial_isolation(workspace, monkeypatch):
    create_job("first")
    final = asyncio.run(pipeline.run_job("first"))
    assert final["status"] == "done", final
    assert FakePool.instances[0].peak == 3
    # Every tile shares one immutable prompt (FR-04). Under the pixel lock the anchor
    # may run early on a generic year prompt so it can overlap scene parsing.
    tile_prompts = FakePool.instances[0].prompts[1:]
    assert set(tile_prompts) == {final["constraints"]["prompt_global"]}
    assert FakePool.instances[0].prompts[0] in {final["constraints"]["prompt_global"], pipeline.generic_decade_prompt(1925)}
    assert final["metrics"]["image_calls"] == final["geometry"]["n"] + 1
    times = [final["metrics"][key] for key in ("started_at", "anchor_done_at", "first_tile_at", "finished_at")]
    assert times == sorted(times) and all(times)
    for tile in final["tiles"]:
        assert (settings.out_dir / "first" / f"t{tile['i']}_raw.jpg").is_file()
        assert (settings.out_dir / "first" / f"t{tile['i']}.jpg").is_file()
    assert final["metrics"]["seam_err"]["originals_floor"] == 0

    create_job("cached")
    async def forbidden(*args, **kwargs):
        raise AssertionError("A disk cache hit must not invoke any models")
    with monkeypatch.context() as patch:
        patch.setattr(pipeline, "parse_scene", forbidden)
        patch.setattr(pipeline, "build_constraints", forbidden)
        replay = asyncio.run(pipeline.run_job("cached"))
    assert replay["status"] == "done" and replay["mode"] == "replay"
    assert replay["metrics"] == final["metrics"]
    assert replay["result"]["path"] == "out/cached/result.jpg"
    assert len(FakePool.instances) == 1

    # A saved demo job stays offline even if the server is later configured live.
    attempted_text_calls = []
    async def unexpected_text_call(*args, **kwargs):
        attempted_text_calls.append(True)
        raise AssertionError("A saved demo baseline must remain offline")
    monkeypatch.setattr(settings, "provider", "gemini")
    monkeypatch.setattr(settings, "gemini_api_key", "test-only")
    monkeypatch.setattr(settings, "k2_api_key", "test-only")
    monkeypatch.setattr(scene, "_request_scene", unexpected_text_call)
    monkeypatch.setattr(constraints, "_request_facts", unexpected_text_call)
    before = (settings.out_dir / "first" / "result.jpg").read_bytes()
    baseline = asyncio.run(pipeline.run_baseline("first"))
    assert baseline["baseline_status"] == "done"
    assert baseline["metrics"]["serial_baseline_s"] > 0
    assert baseline["metrics"]["speedup"] > 0
    assert FakePool.instances[-1].peak == 1
    assert attempted_text_calls == []
    assert (settings.out_dir / "first" / "result.jpg").read_bytes() == before
    assert baseline["metrics"]["started_at"] == final["metrics"]["started_at"]


def test_tile_failure_preserves_outputs_and_finishes_partial(workspace):
    FakePool.fail_tile = True
    create_job("partial")
    result = asyncio.run(pipeline.run_job("partial"))
    assert result["status"] == "done_partial", result
    assert sum(tile["status"] == "error" for tile in result["tiles"]) == 1
    assert result["result"]["status"] == "done"
    failed = next(tile for tile in result["tiles"] if tile["status"] == "error")
    original = open_rgb(settings.out_dir / "partial" / "band_ext.jpg")
    fallback = open_rgb(settings.out_dir / "partial" / f"t{failed['i']}.jpg")
    expected = original.crop((failed["x"], 0, failed["x"] + 1024, 1024))
    assert np.abs(np.asarray(fallback, dtype=float) - np.asarray(expected, dtype=float)).mean() < 2


def test_anchor_failure_still_generates_tiles_without_color_transfer(workspace, monkeypatch):
    # Color-match comparison is meaningful without structure preserve (which also edits tiles).
    monkeypatch.setattr(settings, "structure_lock", False)
    FakePool.fail_anchor = True
    create_job("no-anchor")
    result = asyncio.run(pipeline.run_job("no-anchor"))
    assert result["status"] == "done", result
    assert result["anchor"]["status"] == "skipped"
    assert result["metrics"]["anchor_done_at"] is not None
    assert result["metrics"]["seam_err"]["raw"] == result["metrics"]["seam_err"]["after_color_match"]


def test_cache_key_uses_exact_bytes_year_provider_and_prompt():
    original = pipeline.cache_key(b"image", 1945, "demo", "prompt")
    variants = [(b"image2", 1945, "demo", "prompt"), (b"image", 1946, "demo", "prompt"),
                (b"image", 1945, "gemini", "prompt"), (b"image", 1945, "demo", "other")]
    assert all(pipeline.cache_key(*args) != original for args in variants)


def test_same_decade_years_cannot_replay_each_others_history(workspace):
    create_job("year-1945", "1940s", target_year=1945)
    first = asyncio.run(pipeline.run_job("year-1945"))
    create_job("year-1946", "1940s", target_year=1946)
    second = asyncio.run(pipeline.run_job("year-1946"))
    assert first["status"] == second["status"] == "done"
    assert not first["cache_hit"] and not second["cache_hit"]
    assert first["cache_key"] != second["cache_key"]
    assert first["constraints"]["target_year"] == first["anchor_year"] == 1945
    assert second["constraints"]["target_year"] == second["anchor_year"] == 1946
    assert len(FakePool.instances) == 2
    for pool, result in zip(FakePool.instances, (first, second)):
        # Tiles share the exact-year prompt; the early anchor may use the generic year prompt.
        assert set(pool.prompts[1:]) == {result["constraints"]["prompt_global"]}
        assert pool.prompts[0] in {result["constraints"]["prompt_global"],
                                   pipeline.generic_decade_prompt(result["anchor_year"])}

    create_job("year-1945-replay", "1940s", target_year=1945)
    replay = asyncio.run(pipeline.run_job("year-1945-replay"))
    assert replay["status"] == "done" and replay["mode"] == "replay"
    assert replay["cache_source_job_id"] == "year-1945"
    assert len(FakePool.instances) == 2


def test_request_cache_versions_history_and_preserves_exact_location(monkeypatch):
    manifest = {
        "decade": "1940s", "target_year": 1945,
        "source": {"is_360": False},
        "place": {"name": "Tokyo", "lat": 35.6762, "lon": 139.6503},
    }
    original = pipeline._request_key(b"image", manifest, "demo")
    next_year = {**manifest, "target_year": 1946}
    next_site = {**manifest, "place": {**manifest["place"], "lat": 35.7}}
    assert pipeline._request_key(b"image", next_year, "demo") != original
    assert pipeline._request_key(b"image", next_site, "demo") != original
    monkeypatch.setattr(pipeline, "PROMPT_VERSION", pipeline.PROMPT_VERSION + "-next")
    assert pipeline._request_key(b"image", manifest, "demo") != original


def test_live_history_failure_is_not_cached_and_old_fallback_cache_does_not_block_recovery(workspace, monkeypatch):
    history_calls = []

    async def parsed_scene(*args, **kwargs):
        return {**scene.DEFAULT_SCENE_SPEC, "_tokens": 0, "fallback": False}

    async def history(place, year, parsed, **kwargs):
        history_calls.append(year)
        spec = await constraints.build_constraints(place, year, parsed, provider="demo")
        if len(history_calls) > 1:
            spec = replace(spec, fallback=False, historical_context={
                **spec.historical_context, "evidence_basis": "model_knowledge_unverified",
            })
        return spec

    monkeypatch.setattr(pipeline, "parse_scene", parsed_scene)
    monkeypatch.setattr(pipeline, "build_constraints", history)
    create_job("history-unavailable", "1940s", target_year=1945)
    update_manifest("history-unavailable", lambda m: m.update(provider="gemini"))
    first = asyncio.run(pipeline.run_job("history-unavailable"))
    assert first["status"] == "done" and first["constraints"]["fallback"]
    cache_dir = settings.out_dir / ".cache"
    assert not list(cache_dir.glob("requests/*.json"))

    # A request index left by the earlier implementation must also be rejected.
    request_key = pipeline._request_key((settings.in_dir / "source.jpg").read_bytes(), first, "gemini")
    pipeline._atomic_json(cache_dir / f"{first['cache_key']}.json", {"job_id": "history-unavailable"})
    pipeline._atomic_json(cache_dir / "requests" / f"{request_key}.json", {"cache_key": first["cache_key"]})
    create_job("history-recovered", "1940s", target_year=1945)
    update_manifest("history-recovered", lambda m: m.update(provider="gemini"))
    second = asyncio.run(pipeline.run_job("history-recovered"))
    assert second["status"] == "done" and not second["cache_hit"]
    assert not second["constraints"]["fallback"]
    assert history_calls == [1945, 1945] and len(FakePool.instances) == 2

    create_job("history-recovered-replay", "1940s", target_year=1945)
    update_manifest("history-recovered-replay", lambda m: m.update(provider="gemini"))
    third = asyncio.run(pipeline.run_job("history-recovered-replay"))
    assert third["status"] == "done" and third["mode"] == "replay"
    assert third["cache_source_job_id"] == "history-recovered"
    assert history_calls == [1945, 1945] and len(FakePool.instances) == 2
