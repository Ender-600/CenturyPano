"""Filesystem-backed progressive panorama generation and honest serial baselines."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import shutil
import time
import uuid
from pathlib import Path

from PIL import Image

from .alignment import align_tile
from .config import COLOR_MATCH_K, H, TILE, settings
from .consistency import anchor_crop, color_match, compensate_exposure, squeeze_anchor
from .constraints import PROMPT_VERSION, build_constraints, generic_decade_prompt
from .editors.base import EditorPool, ProviderError
from .geometry import image_bytes, open_rgb, preprocess, viewport_priority
from .hotspots import DETECTOR_VERSION, detect_hotspots, instant_hotspots
from .manifest import job_dir, read_manifest, update_manifest
from .metrics import alignment_metrics, seam_metrics, timing_metrics
from .scene import parse_scene
from .stitch import fuse_overlaps, seam_plan, stitch
from .temporal import decade_for_year, manifest_year
from .weather import WeatherSpec, apply_weather, resolve_weathers, weather_subdir

_hotspot_tasks: dict[str, asyncio.Task] = {}


def _hotspot_payload(items: list[dict], *, fallback: bool, provisional: bool = False, tokens: int = 0) -> dict:
    return {
        "status": "done",
        "items": items,
        "fallback": fallback,
        "provisional": provisional,
        "detector_version": DETECTOR_VERSION,
        "tokens": tokens,
    }


def _schedule_hotspot_refine(job_id: str, directory: Path, provider: str) -> None:
    previous = _hotspot_tasks.pop(job_id, None)
    if previous and not previous.done():
        previous.cancel()

    async def refine():
        try:
            path = directory / "result.jpg"
            if not path.is_file():
                return
            result_bytes = await asyncio.to_thread(path.read_bytes)
            hotspot_data = await detect_hotspots(result_bytes, provider=provider)
            if hotspot_data.get("fallback") and not hotspot_data.get("items"):
                return

            def apply(m):
                tokens = m["metrics"].setdefault("tokens", {"vlm": 0, "llm": 0})
                tokens["vlm"] = int(tokens.get("vlm") or 0) + int(hotspot_data.get("tokens") or 0)
                m["hotspots"] = _hotspot_payload(
                    hotspot_data["items"],
                    fallback=bool(hotspot_data.get("fallback")),
                    provisional=False,
                    tokens=int(hotspot_data.get("tokens") or 0),
                )

            update_manifest(job_id, apply)
        except Exception:
            def keep_provisional(m):
                hotspots = m.get("hotspots") or {}
                if hotspots.get("provisional") and hotspots.get("items"):
                    hotspots = dict(hotspots)
                    hotspots["provisional"] = False
                    m["hotspots"] = hotspots

            update_manifest(job_id, keep_provisional)
        finally:
            _hotspot_tasks.pop(job_id, None)

    _hotspot_tasks[job_id] = asyncio.create_task(refine())


def _ensure_instant_hotspots(job_id: str, scene: dict | None = None) -> dict:
    manifest = read_manifest(job_id)
    existing = manifest.get("hotspots") or {}
    if existing.get("items") and existing.get("detector_version") == DETECTOR_VERSION:
        return existing
    payload = _hotspot_payload(instant_hotspots(scene or manifest.get("scene")), fallback=True, provisional=True)
    return update_manifest(job_id, lambda m: m.update(hotspots=payload))["hotspots"]


def _reason(exc: Exception) -> str:
    """A short, safe cause for the manifest: provider errors already carry no bodies."""
    if isinstance(exc, ProviderError):
        return str(exc)
    return type(exc).__name__


def cache_key(image: bytes, decade: str | int, provider: str, prompt_global: str) -> str:
    """The public cache contract deliberately includes the exact original bytes."""
    return hashlib.sha256(image + str(decade).encode() + provider.encode() + prompt_global.encode()).hexdigest()


def _weather_cache_fields(manifest: dict) -> dict:
    weather = manifest.get("weather") or {}
    enabled = bool(weather.get("enabled"))
    ids = list(weather.get("ids") or []) if enabled else []
    return {"weather_enabled": enabled, "weather_ids": ids}


def _request_key(image: bytes, manifest: dict, provider: str) -> str:
    # This index allows a replay lookup before making any scene/constraint calls.
    # Location and the 360 override affect interpretation and must not collide.
    context = json.dumps({
        "target_year": manifest_year(manifest), "provider": provider,
        "prompt_version": PROMPT_VERSION,
        "place": manifest.get("place", {}),
        "is_360": manifest["source"].get("is_360"),
        **_weather_cache_fields(manifest),
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(image + context.encode()).hexdigest()


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(path)


def _save_image(path: Path, image: Image.Image) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".jpg.tmp")
    image.convert("RGB").save(temporary, "JPEG", quality=94, subsampling=0)
    temporary.replace(path)


def _output_path(job_id: str, filename: str) -> str:
    return f"out/{job_id}/{filename}"


def _variant_file(weather_id: str | None, name: str) -> str:
    if not weather_id:
        return name
    return f"{weather_subdir(weather_id)}/{name}"


def _required_job_files(cached: dict) -> list[str]:
    required = ["band.jpg", "band_ext.jpg", "result.jpg"]
    required.extend(f"t{tile['i']}{suffix}.jpg" for tile in cached.get("tiles") or [] for suffix in ("", "_raw"))
    if (cached.get("anchor") or {}).get("status") == "done":
        required.append("anchor.jpg")
    weather = cached.get("weather") or {}
    if weather.get("enabled"):
        for weather_id, variant in (weather.get("variants") or {}).items():
            prefix = weather_subdir(weather_id)
            required.append(f"{prefix}/result.jpg")
            if (variant.get("anchor") or {}).get("status") == "done":
                required.append(f"{prefix}/anchor.jpg")
            for tile in variant.get("tiles") or []:
                required.extend(f"{prefix}/t{tile['i']}{suffix}.jpg" for suffix in ("", "_raw"))
    return required


def _reuse_key(image: bytes, year: int, provider: str, weather_fields: dict) -> str:
    """Same photo + year + provider (+ weather) may reuse a prior finished result."""
    context = json.dumps(
        {"target_year": year, "provider": provider, **weather_fields},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(image + context.encode()).hexdigest()


def _apply_cached_job(job_id: str, cached: dict, current: dict) -> bool:
    old_id = cached["job_id"]
    required = _required_job_files(cached)
    old_dir = job_dir(old_id)
    if not all((old_dir / name).is_file() for name in required):
        return False
    target = job_dir(job_id)
    target.mkdir(parents=True, exist_ok=True)
    if old_id != job_id:
        for name in required:
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old_dir / name, destination)

    def rewrite(value):
        if isinstance(value, str) and value.startswith(f"out/{old_id}/"):
            return value.replace(f"out/{old_id}/", f"out/{job_id}/", 1)
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            return {key: rewrite(item) for key, item in value.items()}
        return value

    result = rewrite(cached)
    result.update(job_id=job_id, mode="replay", cache_hit=True, cache_source_job_id=old_id,
                  source=current["source"], heading=current.get("heading", .5),
                  created_at=current.get("created_at", time.time()))
    result.pop("baseline", None)
    update_manifest(job_id, lambda m: (m.clear(), m.update(result)))
    return True


def _replay_hit(job_id: str, request_key: str, original: bytes, current: dict, provider: str) -> bool:
    directory = settings.out_dir / ".cache"
    weather_fields = _weather_cache_fields(current)
    year = manifest_year(current)
    try:
        index = json.loads((directory / "requests" / f"{request_key}.json").read_text())
        cached_index = json.loads((directory / f"{index['cache_key']}.json").read_text())
        cached = read_manifest(cached_index["job_id"])
        prompt = cached["constraints"]["prompt_global"]
        if cached["constraints"].get("prompt_version") != PROMPT_VERSION:
            raise KeyError("prompt version")
        if provider != "demo" and cached["constraints"].get("fallback", True):
            raise KeyError("fallback history")
        if manifest_year(cached) != year:
            raise KeyError("year")
        if _weather_cache_fields(cached) != weather_fields:
            raise KeyError("weather")
        if cache_key(original, year, provider, prompt) != index["cache_key"]:
            raise KeyError("cache key")
        if cached.get("status") != "done" or cached.get("baseline_of"):
            raise KeyError("status")
        if _apply_cached_job(job_id, cached, current):
            return True
    except (OSError, ValueError, KeyError, TypeError):
        pass

    # Same image + same year: reopen the last successful reconstruction instead of
    # re-running history (and instead of surfacing a transient historian failure).
    try:
        reuse = json.loads((directory / "reuse" / f"{_reuse_key(original, year, provider, weather_fields)}.json").read_text())
        cached = read_manifest(reuse["job_id"])
        if cached.get("status") != "done" or cached.get("baseline_of"):
            return False
        if manifest_year(cached) != year:
            return False
        if _weather_cache_fields(cached) != weather_fields:
            return False
        if (cached.get("provider") or settings.provider) != provider and provider != "demo":
            return False
        return _apply_cached_job(job_id, cached, current)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _mirror_root(directory: Path, relative: str) -> None:
    """Copy a weather-variant file to the job root for legacy tile/result URLs."""
    source = directory / relative
    if not source.is_file():
        return
    name = Path(relative).name
    destination = directory / name
    if destination.resolve() == source.resolve():
        return
    shutil.copy2(source, destination)


async def run_job(job_id: str, *, concurrency: int | None = None, use_cache: bool = True) -> dict:
    """Run once; persist every visible state transition before exposing its files."""
    started = time.time()
    manifest = read_manifest(job_id)
    provider = manifest.get("provider") or settings.provider
    directory = job_dir(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    stage = "preprocess"
    serial = concurrency == 1

    def start(m):
        m.update(status="running", stage=stage, mode="live", provider=provider,
                 is_demo=provider == "demo", demo=provider == "demo", cache_hit=False)
        m["metrics"] = {"started_at": started, "anchor_done_at": None, "first_tile_at": None,
                        "finished_at": None, "first_view_s": None, "total_s": None,
                        "seam_err": {"raw": None, "after_color_match": None, "originals_floor": None,
                                     "after_compensation": None, "at_seam_cut": None, "carved_seams": None},
                        "compensation": None, "seams": [],
                        "serial_baseline_s": None, "speedup": None, "image_calls": 0,
                        "alignment": {"score_before": None, "score_after": None, "mean_shift_px": None, "applied": 0},
                        "tokens": {"vlm": 0, "llm": 0}}
        m["result"] = {"path": _output_path(job_id, "result.jpg"), "status": "pending"}
        m["anchor"] = {"status": "pending", "path": _output_path(job_id, "anchor.jpg"), "ms": None}
        m["tiles"] = []
        m["hotspots"] = {"status": "pending", "items": [], "fallback": None}
        m.pop("error", None)

    update_manifest(job_id, start)
    try:
        source = Path(manifest["source"]["path"])
        # Originals are private; manifest paths never grant arbitrary filesystem access.
        source = settings.in_dir / source.name
        original_bytes = await asyncio.to_thread(source.read_bytes)
        request_hash = _request_key(original_bytes, manifest, provider)
        if use_cache and await asyncio.to_thread(_replay_hit, job_id, request_hash,
                                                 original_bytes, manifest, provider):
            _ensure_instant_hotspots(job_id, read_manifest(job_id).get("scene"))
            _schedule_hotspot_refine(job_id, directory, provider)
            return read_manifest(job_id)
        prepared = await asyncio.to_thread(preprocess, original_bytes, manifest["source"].get("is_360"))
        await asyncio.to_thread(_save_image, directory / "band.jpg", prepared.band)
        await asyncio.to_thread(_save_image, directory / "band_ext.jpg", prepared.band_ext)
        geometry = prepared.geometry
        update_manifest(job_id, lambda m: m.update(geometry=geometry, warnings=prepared.warnings,
                                                   stage="scene"))
        stage = "scene"
        band_bytes = await asyncio.to_thread(image_bytes, prepared.band)
        year = manifest_year(manifest)
        weather_block = manifest.get("weather") or {}
        weather_enabled = bool(weather_block.get("enabled"))
        weather_ids_raw = ",".join(weather_block.get("ids") or []) if weather_block.get("ids") else None
        weather_specs = resolve_weathers(weather_enabled, weather_ids_raw)
        # One lane with weather=None when the system is off.
        lanes: list[WeatherSpec | None] = list(weather_specs) if weather_specs else [None]
        primary_id = lanes[0].id if isinstance(lanes[0], WeatherSpec) else None
        tile_limit = 1 if serial else settings.resolve_tile_concurrency(geometry["n"], override=concurrency)
        weather_limit = 1 if serial else settings.resolve_weather_concurrency(len(lanes))
        pool = EditorPool(primary=provider, fallback=settings.provider_fallback,
                          max_concurrency=weather_limit * tile_limit)
        seed = int(manifest.get("job_seed", 0))
        structure_lock = settings.structure_lock
        edit_timeout = settings.openai_image_timeout_s if provider == "openai" else 120.0

        async def scene_and_history():
            nonlocal stage
            result = await parse_scene(band_bytes, provider=provider)
            tokens_vlm = int(result.pop("_tokens", 0))
            update_manifest(job_id, lambda m: (m.update(scene=result, stage="history"),
                                               m["metrics"]["tokens"].update(vlm=tokens_vlm)))
            stage = "history"
            spec = await build_constraints(manifest.get("place", {}), year, result, provider=provider,
                                           structure_lock=structure_lock)
            data = spec.to_dict() if hasattr(spec, "to_dict") else dict(spec)
            tokens_llm = int(getattr(spec, "_tokens", data.pop("_tokens", 0)))
            update_manifest(job_id, lambda m: (m.update(constraints=data, target_year=year, anchor_year=year,
                                                       decade=decade_for_year(year)),
                                              m["metrics"]["tokens"].update(llm=tokens_llm)))
            return result, data

        async def generate_anchor(
            anchor_prompt: str, anchor_negative: str | None, anchor_strength: float, *,
            weather_id: str | None = None, mirror: bool = True,
        ):
            start_at = time.perf_counter()
            rel = _variant_file(weather_id, "anchor.jpg")
            path = _output_path(job_id, rel)

            def mark_running(m):
                payload = dict(status="running", path=path)
                if mirror:
                    m["anchor"].update(payload)
                if weather_id:
                    m["weather"]["variants"][weather_id]["anchor"].update(payload)

            update_manifest(job_id, mark_running)
            try:
                squeezed = await asyncio.to_thread(squeeze_anchor, prepared.band)
                result = await pool.edit(await asyncio.to_thread(image_bytes, squeezed),
                                         anchor_prompt, seed=seed, strength=anchor_strength,
                                         negative=anchor_negative, structure_lock=structure_lock,
                                         timeout_s=edit_timeout)
                anchor = await asyncio.to_thread(open_rgb, result.image)
                await asyncio.to_thread(_save_image, directory / rel, anchor)
                if weather_id and mirror:
                    await asyncio.to_thread(_mirror_root, directory, rel)

                def mark_done(m):
                    payload = dict(status="done", provider=result.provider, attempts=result.attempts,
                                   ms=round((time.perf_counter() - start_at) * 1000), path=path)
                    if mirror:
                        m["anchor"].update(payload)
                    if weather_id:
                        m["weather"]["variants"][weather_id]["anchor"].update(payload)

                update_manifest(job_id, mark_done)
                return anchor
            except Exception as exc:
                reason = _reason(exc)

                def mark_skipped(m):
                    payload = dict(status="skipped", error=f"Anchor unavailable: {reason}",
                                   ms=round((time.perf_counter() - start_at) * 1000), path=path)
                    if mirror:
                        m["anchor"].update(payload)
                    if weather_id:
                        m["weather"]["variants"][weather_id]["anchor"].update(payload)

                update_manifest(job_id, mark_skipped)
                return None
            finally:
                update_manifest(job_id, lambda m: m["metrics"].update(anchor_done_at=time.time(),
                                                                       image_calls=pool.image_calls))

        # Early generic anchor only when weather is off (one lane) under structure lock.
        early_anchor = None
        if structure_lock and not weather_enabled:
            update_manifest(job_id, lambda m: m.update(stage="anchor"))
            stage = "anchor"
            (_scene, constraint_data), early_anchor = await asyncio.gather(
                scene_and_history(),
                generate_anchor(generic_decade_prompt(year), None, .55),
            )
            update_manifest(job_id, lambda m: m["anchor"].update(prompt="generic_decade"))
        else:
            _scene, constraint_data = await scene_and_history()
            if not weather_enabled:
                stage = "anchor"
                update_manifest(job_id, lambda m: m.update(stage="anchor"))
                anchor_strength = .7 if constraint_data.get("historical_context", {}).get("site_state") in {
                    "undeveloped", "agricultural"
                } else .55
                early_anchor = await generate_anchor(
                    constraint_data["prompt_global"], constraint_data.get("negative"), anchor_strength,
                )

        prompt = constraint_data["prompt_global"]  # One immutable era string; weather clauses are appended per lane.
        negative = constraint_data.get("negative")
        strength = .7 if constraint_data.get("historical_context", {}).get("site_state") in {
            "undeveloped", "agricultural"
        } else .55
        priority = viewport_priority(geometry["x"], manifest.get("heading", .5),
                                     geometry["W_ext"], geometry["wrap"])
        originals = [prepared.band_ext.crop((x, 0, x + TILE, H)) for x in geometry["x"]]

        def tile_records(weather_id: str | None):
            return [{"i": i, "x": x, "priority": priority[i], "status": "pending",
                     "raw_path": _output_path(job_id, _variant_file(weather_id, f"t{i}_raw.jpg")),
                     "path": _output_path(job_id, _variant_file(weather_id, f"t{i}.jpg")),
                     "ms": None, "attempts": 0, "provider": provider, "error": None}
                    for i, x in enumerate(geometry["x"])]

        primary_tiles = tile_records(primary_id if weather_enabled else None)
        weather_state = {
            "enabled": weather_enabled,
            "active": primary_id,
            "ids": [spec.id for spec in weather_specs],
            "concurrency": {"weather": weather_limit, "tile": tile_limit},
            "variants": {},
        }
        if weather_enabled:
            for spec in weather_specs:
                weather_state["variants"][spec.id] = {
                    "id": spec.id, "label": spec.label, "status": "pending",
                    "anchor": {"status": "pending",
                               "path": _output_path(job_id, _variant_file(spec.id, "anchor.jpg")), "ms": None},
                    "tiles": tile_records(spec.id),
                    "result": {"path": _output_path(job_id, _variant_file(spec.id, "result.jpg")),
                               "status": "pending"},
                }
        update_manifest(job_id, lambda m: m.update(
            tiles=primary_tiles, stage="tiles", weather=weather_state,
        ))
        stage = "tiles"
        weather_gate = asyncio.Semaphore(weather_limit)
        lane_results: dict[str | None, dict] = {}

        async def generate_tile(
            index: int, *, weather_id: str | None, tile_prompt: str, anchor: Image.Image | None,
            gate: asyncio.Semaphore, mirror: bool,
        ):
            async with gate:
                tile_start = time.perf_counter()

                def mark_running(m):
                    if mirror:
                        m["tiles"][index].update(status="running")
                    if weather_id:
                        m["weather"]["variants"][weather_id]["tiles"][index].update(status="running")

                update_manifest(job_id, mark_running)
                raw_rel = _variant_file(weather_id, f"t{index}_raw.jpg")
                out_rel = _variant_file(weather_id, f"t{index}.jpg")
                try:
                    reference = await asyncio.to_thread(
                        anchor_crop, anchor, geometry["x"][index], geometry["W"], wrap=geometry["wrap"],
                    ) if anchor is not None else None
                    reference_bytes = await asyncio.to_thread(image_bytes, reference) if reference is not None else None
                    result = await pool.edit(
                        await asyncio.to_thread(image_bytes, originals[index]), tile_prompt,
                        reference=reference_bytes, seed=seed, strength=strength,
                        negative=negative, structure_lock=structure_lock, timeout_s=edit_timeout,
                    )
                    raw = await asyncio.to_thread(open_rgb, result.image)
                    if raw.size != (TILE, H):
                        raw = raw.resize((TILE, H), Image.Resampling.LANCZOS)
                    await asyncio.to_thread(_save_image, directory / raw_rel, raw)
                    aligned, alignment = await asyncio.to_thread(align_tile, originals[index], raw)
                    matched = await asyncio.to_thread(color_match, aligned, reference, COLOR_MATCH_K) if reference is not None else aligned
                    await asyncio.to_thread(_save_image, directory / out_rel, matched)
                    if weather_id and mirror:
                        await asyncio.to_thread(_mirror_root, directory, raw_rel)
                        await asyncio.to_thread(_mirror_root, directory, out_rel)

                    def done(m):
                        now = time.time()
                        payload = dict(status="done", provider=result.provider, attempts=result.attempts,
                                       ms=round((time.perf_counter() - tile_start) * 1000), done_at=now,
                                       error=None, align=alignment.to_dict())
                        if mirror:
                            m["tiles"][index].update(payload)
                        if weather_id:
                            m["weather"]["variants"][weather_id]["tiles"][index].update(payload)
                        if m["metrics"]["first_tile_at"] is None:
                            m["metrics"]["first_tile_at"] = now
                            m["metrics"]["first_view_s"] = round(now - started, 4)
                        m["metrics"]["image_calls"] = pool.image_calls

                    update_manifest(job_id, done)
                except Exception as exc:
                    reason = _reason(exc)
                    attempts = getattr(exc, "attempts", 0)
                    failed_provider = getattr(exc, "provider", provider)
                    await asyncio.to_thread(_save_image, directory / raw_rel, originals[index])
                    await asyncio.to_thread(_save_image, directory / out_rel, originals[index])
                    if weather_id and mirror:
                        await asyncio.to_thread(_mirror_root, directory, raw_rel)
                        await asyncio.to_thread(_mirror_root, directory, out_rel)

                    def mark_error(m):
                        payload = dict(status="error",
                                       error=f"Tile generation failed: {reason}; original retained",
                                       attempts=attempts, provider=failed_provider,
                                       ms=round((time.perf_counter() - tile_start) * 1000))
                        if mirror:
                            m["tiles"][index].update(payload)
                        if weather_id:
                            m["weather"]["variants"][weather_id]["tiles"][index].update(payload)

                    update_manifest(job_id, mark_error)

        async def launch_tiles(weather_id: str | None, tile_prompt: str, anchor: Image.Image | None, *, mirror: bool):
            gate = asyncio.Semaphore(tile_limit)
            order = sorted(range(geometry["n"]), key=lambda i: priority[i])
            first = [i for i in order if priority[i] == 0]
            rest = [i for i in order if priority[i] != 0]
            tasks = [asyncio.create_task(generate_tile(
                i, weather_id=weather_id, tile_prompt=tile_prompt, anchor=anchor, gate=gate, mirror=mirror,
            )) for i in first]
            if rest:
                if first and settings.priority_stagger_s > 0:
                    await asyncio.sleep(settings.priority_stagger_s)
                tasks.extend(asyncio.create_task(generate_tile(
                    i, weather_id=weather_id, tile_prompt=tile_prompt, anchor=anchor, gate=gate, mirror=mirror,
                )) for i in rest)
            await asyncio.gather(*tasks)

        def finish_images(weather_id: str | None, failed: frozenset[int], *, mirror: bool):
            raw_paths = [directory / _variant_file(weather_id, f"t{i}_raw.jpg") for i in range(geometry["n"])]
            tile_paths = [directory / _variant_file(weather_id, f"t{i}.jpg") for i in range(geometry["n"])]
            raw = [open_rgb(path) for path in raw_paths]
            matched = [open_rgb(path) for path in tile_paths]
            fused = fuse_overlaps(matched, geometry["x"], fixed=failed)
            compensated, compensation = compensate_exposure(fused, geometry["x"], fixed=failed)
            plan = seam_plan(compensated, geometry["x"])
            result = stitch(compensated, geometry["x"], geometry["overlap"], geometry["wrap"],
                            W=geometry["W"], plan=plan)
            result_rel = _variant_file(weather_id, "result.jpg")
            _save_image(directory / result_rel, result)
            if weather_id and mirror:
                _mirror_root(directory, result_rel)
            for index, tile in enumerate(compensated):
                if index not in failed:
                    out_rel = _variant_file(weather_id, f"t{index}.jpg")
                    _save_image(directory / out_rel, tile)
                    if weather_id and mirror:
                        _mirror_root(directory, out_rel)
            return (seam_metrics(raw, matched, originals, geometry["x"], compensated, plan),
                    compensation, [seam.to_dict() for seam in plan], result_rel)

        async def run_lane(weather: WeatherSpec | None):
            async with weather_gate:
                weather_id = weather.id if weather else None
                mirror = (not weather_enabled) or (weather_id == primary_id)
                tile_prompt = apply_weather(prompt, weather)
                if weather_id:
                    update_manifest(job_id, lambda m: m["weather"]["variants"][weather_id].update(status="running"))

                if weather_enabled:
                    # History is already finished before weather lanes start, so use the
                    # full era prompt (not the thin generic_decade probe). Weather only
                    # overlays atmosphere; weak anchors were drifting into the present.
                    lane_anchor = await generate_anchor(
                        apply_weather(prompt, weather),
                        negative,
                        strength,
                        weather_id=weather_id, mirror=mirror,
                    )
                else:
                    lane_anchor = early_anchor

                await launch_tiles(weather_id if weather_enabled else None, tile_prompt, lane_anchor, mirror=mirror)

                def failed_ids(m):
                    tiles = m["tiles"] if mirror and not weather_enabled else (
                        m["weather"]["variants"][weather_id]["tiles"] if weather_id else m["tiles"]
                    )
                    return frozenset(tile["i"] for tile in tiles if tile.get("status") == "error")

                failed = failed_ids(read_manifest(job_id))
                seams, compensation, seam_details, result_rel = await asyncio.to_thread(
                    finish_images, weather_id if weather_enabled else None, failed, mirror=mirror,
                )

                def mark_variant_done(m):
                    if weather_id:
                        variant = m["weather"]["variants"][weather_id]
                        tiles = variant["tiles"]
                        variant.update(status="done_partial" if any(t["status"] == "error" for t in tiles) else "done")
                        variant["result"].update(status="done", path=_output_path(job_id, result_rel))
                    if mirror:
                        m["result"].update(status="done", path=_output_path(job_id, "result.jpg"))
                        if weather_enabled and weather_id == primary_id:
                            m["tiles"] = copy.deepcopy(m["weather"]["variants"][weather_id]["tiles"])
                            # Point top-level paths at root mirrors for legacy URLs.
                            for tile in m["tiles"]:
                                tile["path"] = _output_path(job_id, f"t{tile['i']}.jpg")
                                tile["raw_path"] = _output_path(job_id, f"t{tile['i']}_raw.jpg")
                            m["anchor"] = copy.deepcopy(m["weather"]["variants"][weather_id]["anchor"])
                            m["anchor"]["path"] = _output_path(job_id, "anchor.jpg")

                update_manifest(job_id, mark_variant_done)
                lane_results[weather_id] = {
                    "seams": seams, "compensation": compensation, "seam_details": seam_details,
                }

        await asyncio.gather(*(run_lane(weather) for weather in lanes))
        primary_metrics = lane_results[primary_id if weather_enabled else None]
        finished = time.time()

        def complete(m):
            tiles = m["tiles"]
            m["metrics"].update(
                timing_metrics(m["metrics"], finished),
                seam_err=primary_metrics["seams"],
                image_calls=pool.image_calls,
                alignment=alignment_metrics(tiles),
                compensation=primary_metrics["compensation"],
                seams=primary_metrics["seam_details"],
            )
            m["hotspots"] = _hotspot_payload(
                instant_hotspots(m.get("scene")), fallback=True, provisional=True,
            )
            m["result"]["status"] = "done"
            partial = any(t["status"] == "error" for t in tiles)
            if weather_enabled:
                partial = partial or any(
                    variant.get("status") == "done_partial"
                    for variant in (m.get("weather") or {}).get("variants", {}).values()
                )
            m["status"] = "done_partial" if partial else "done"
            m["stage"] = "complete"
            m["cache_key"] = cache_key(original_bytes, year, provider, prompt)

        final = update_manifest(job_id, complete)
        _schedule_hotspot_refine(job_id, directory, provider)

        history_cacheable = provider == "demo" or not constraint_data.get("fallback", True)
        if use_cache and final["status"] == "done":
            cache_dir = settings.out_dir / ".cache"
            reuse = _reuse_key(original_bytes, year, provider, _weather_cache_fields(final))
            await asyncio.to_thread(_atomic_json, cache_dir / "reuse" / f"{reuse}.json",
                                    {"job_id": job_id, "cache_key": final.get("cache_key")})
            if history_cacheable:
                await asyncio.to_thread(_atomic_json, cache_dir / f"{final['cache_key']}.json", {"job_id": job_id})
                await asyncio.to_thread(_atomic_json, cache_dir / "requests" / f"{request_hash}.json",
                                        {"cache_key": final["cache_key"]})
        return final
    except Exception as exc:
        # Same photo + year already finished once: reopen that result instead of leaving the user on an error.
        if use_cache and "original_bytes" in locals() and "request_hash" in locals():
            try:
                current = read_manifest(job_id)
                recovered = await asyncio.to_thread(
                    _replay_hit, job_id, request_hash, original_bytes, current, provider,
                )
                if recovered:
                    _ensure_instant_hotspots(job_id, read_manifest(job_id).get("scene"))
                    _schedule_hotspot_refine(job_id, directory, provider)
                    return read_manifest(job_id)
            except Exception:
                pass
        reason = _reason(exc)
        def fail(m):
            m.update(status="error", stage=stage, error=f"Processing failed during {stage}: {reason}")
            m["metrics"].update(timing_metrics(m["metrics"], time.time()))
        return update_manifest(job_id, fail)


async def run_baseline(job_id: str) -> dict:
    """Rerun in an isolated directory without any cache reuse or UI interruption."""
    source = read_manifest(job_id)
    if source.get("status") not in {"done", "done_partial"}:
        raise ValueError("Finish the panorama before measuring its serial baseline")
    baseline_id = f"baseline-{uuid.uuid4().hex}"
    duplicate = copy.deepcopy(source)
    duplicate.update(job_id=baseline_id, baseline_of=job_id, mode="live", status="running")
    update_manifest(baseline_id, lambda m: m.update(duplicate))
    update_manifest(job_id, lambda m: m.update(baseline_status="running", baseline={"status": "running", "job_id": baseline_id}))
    result = await run_job(baseline_id, concurrency=1, use_cache=False)

    def measured(m):
        if result["status"] == "done":
            serial = result["metrics"]["total_s"]
            total = m["metrics"].get("total_s")
            m["metrics"].update(serial_baseline_s=serial, speedup=round(serial / total, 3) if total else None)
            m["baseline"] = {"status": "done", "job_id": baseline_id}
            m["baseline_status"] = "done"
        else:
            m["baseline"] = {"status": "error", "job_id": baseline_id,
                              "error": "Serial run had failed tiles; no speedup claimed."}
            m["baseline_status"] = "error"
    return update_manifest(job_id, measured)
