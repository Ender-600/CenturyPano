import asyncio
import hashlib
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from app import constraints, pipeline, scene
from app.config import H, TILE, settings
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
    monkeypatch.setattr(settings, "tile_concurrency", 3)
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
    weather_on = {**manifest, "weather": {"enabled": True, "ids": ["clear", "rain"]}}
    assert pipeline._request_key(b"image", next_year, "demo") != original
    assert pipeline._request_key(b"image", next_site, "demo") != original
    assert pipeline._request_key(b"image", weather_on, "demo") != original
    monkeypatch.setattr(pipeline, "PROMPT_VERSION", pipeline.PROMPT_VERSION + "-next")
    assert pipeline._request_key(b"image", manifest, "demo") != original


def test_weather_lanes_run_in_parallel_with_distinct_prompts(workspace, monkeypatch):
    monkeypatch.setattr(settings, "tile_concurrency", 2)
    monkeypatch.setattr(settings, "weather_concurrency", 3)
    create_job("weathered")
    update_manifest("weathered", lambda m: m.update(weather={
        "enabled": True, "active": "clear", "ids": ["clear", "rain", "snow"], "variants": {},
    }))
    result = asyncio.run(pipeline.run_job("weathered"))
    assert result["status"] == "done", result
    assert result["weather"]["enabled"] is True
    assert set(result["weather"]["ids"]) == {"clear", "rain", "snow"}
    assert result["weather"]["concurrency"] == {"weather": 3, "tile": 2}
    assert FakePool.instances[0].peak == 6
    prompts = FakePool.instances[0].prompts
    assert any("clear sunny day" in prompt for prompt in prompts)
    assert any("Weather: rain" in prompt for prompt in prompts)
    assert any("Weather: snow" in prompt for prompt in prompts)
    assert any("WEATHER_OVERRIDE" in prompt for prompt in prompts)
    # Weather anchors use the full era prompt, not the thin generic decade probe.
    era = result["constraints"]["prompt_global"]
    weather_prompts = [p for p in prompts if "WEATHER_OVERRIDE" in p]
    assert weather_prompts and all(era in p for p in weather_prompts)
    for weather_id in ("clear", "rain", "snow"):
        variant = result["weather"]["variants"][weather_id]
        assert variant["status"] == "done"
        assert (settings.out_dir / "weathered" / "weathers" / weather_id / "result.jpg").is_file()
        for tile in variant["tiles"]:
            assert (settings.out_dir / "weathered" / "weathers" / weather_id / f"t{tile['i']}.jpg").is_file()
    assert (settings.out_dir / "weathered" / "result.jpg").is_file()
    # Primary lane mirrors to root for legacy URLs.
    assert result["result"]["path"] == "out/weathered/result.jpg"
    n = result["geometry"]["n"]
    # One shared era path is not used raw: each weather gets anchor + n tiles.
    assert FakePool.instances[0].image_calls == 3 * (n + 1)


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


class SplittingPool(FakePool):
    """Returns a tile that is two pictures the first time each tile is asked for.

    A retry is what the pipeline is supposed to do, so the second answer for the
    same tile is whole. Counting per tile rather than per call keeps the test
    honest when tiles run concurrently.
    """

    asked: dict = {}
    fix_on_retry = True

    async def edit(self, image, prompt, **kwargs):
        result = await FakePool.edit(self, image, prompt, **kwargs)
        source = open_rgb(result.image)
        # Key on the whole request, not a prefix: JPEG headers are identical across
        # tiles, so a prefix would make every tile share one counter. The anchor is
        # not a tile and is left alone.
        key = hashlib.sha256(image).hexdigest()
        seen = SplittingPool.asked.get(key, 0)
        SplittingPool.asked[key] = seen + 1
        if source.size == (TILE, H) and (seen == 0 or not SplittingPool.fix_on_retry):
            array = np.asarray(source, dtype=np.float32)
            column = source.width // 2
            # A different picture in the right half: dark, flat, and unrelated to
            # anything the original had at that column.
            array[:, column:] = np.array([18, 20, 24], dtype=np.float32)
            array[::7, column:] = np.array([70, 74, 80], dtype=np.float32)
            source = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
        return SimpleNamespace(image=image_bytes(source), provider="demo", attempts=1)


@pytest.fixture
def splitting(workspace, monkeypatch):
    SplittingPool.instances = []
    SplittingPool.asked = {}
    SplittingPool.fail_tile = False
    SplittingPool.fail_anchor = False
    SplittingPool.fix_on_retry = True
    monkeypatch.setattr(pipeline, "EditorPool", SplittingPool)
    return workspace


def test_a_tile_that_comes_back_as_two_pictures_is_regenerated(splitting):
    create_job("split", target_year=1925)
    manifest = asyncio.run(pipeline.run_job("split", use_cache=False))
    assert manifest["status"] == "done"
    record = manifest["metrics"]["integrity"]
    assert record["tested"] == len(manifest["tiles"])
    assert record["splits_detected"] == record["retries"] == len(manifest["tiles"])
    assert record["unresolved"] == 0, "the retry returned one picture, so nothing is left broken"
    for tile in manifest["tiles"]:
        assert tile["integrity"]["retried"] and not tile["integrity"]["split"]
        assert tile["integrity"]["first"]["step_de"] > tile["integrity"]["step_de"]


def test_an_unfixable_split_is_reported_rather_than_hidden(splitting):
    # The model returns the same broken answer twice. One more image call is all
    # we are willing to spend, so the panorama finishes with the break in it and
    # says so -- silently shipping it as a clean result would be the real failure.
    SplittingPool.fix_on_retry = False
    create_job("stubborn", target_year=1925)
    manifest = asyncio.run(pipeline.run_job("stubborn", use_cache=False))
    assert manifest["status"] == "done"
    record = manifest["metrics"]["integrity"]
    assert record["unresolved"] == len(manifest["tiles"]) == record["retries"]
    assert record["worst_step_de"] > 18.0
    assert all(tile["integrity"]["kept"].startswith("first attempt") for tile in manifest["tiles"])


def test_one_retry_is_the_whole_budget(splitting):
    SplittingPool.fix_on_retry = False
    create_job("budget", target_year=1925)
    manifest = asyncio.run(pipeline.run_job("budget", use_cache=False))
    tiles = len(manifest["tiles"])
    # One anchor call, then exactly two per tile: never an unbounded retry loop.
    assert manifest["metrics"]["image_calls"] == 1 + 2 * tiles
