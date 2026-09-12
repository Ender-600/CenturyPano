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
from .integrity import split_check, worse
from .manifest import job_dir, read_manifest, update_manifest
from .metrics import alignment_metrics, integrity_metrics, seam_metrics, timing_metrics
from .scene import parse_scene
from .stitch import seam_plan, stitch
from .temporal import decade_for_year, manifest_year


def _reason(exc: Exception) -> str:
    """A short, safe cause for the manifest: provider errors already carry no bodies."""
    if isinstance(exc, ProviderError):
        return str(exc)
    return type(exc).__name__


def cache_key(image: bytes, decade: str | int, provider: str, prompt_global: str) -> str:
    """The public cache contract deliberately includes the exact original bytes."""
    return hashlib.sha256(image + str(decade).encode() + provider.encode() + prompt_global.encode()).hexdigest()


def _request_key(image: bytes, manifest: dict, provider: str) -> str:
    # This index allows a replay lookup before making any scene/constraint calls.
    # Location and the 360 override affect interpretation and must not collide.
    context = json.dumps({"target_year": manifest_year(manifest), "provider": provider,
                          "prompt_version": PROMPT_VERSION,
                          "place": manifest.get("place", {}),
                          "is_360": manifest["source"].get("is_360")},
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(image + context.encode()).hexdigest()


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False))
    temporary.replace(path)


def _save_image(path: Path, image: Image.Image) -> None:
    temporary = path.with_suffix(".jpg.tmp")
    image.convert("RGB").save(temporary, "JPEG", quality=94, subsampling=0)
    temporary.replace(path)


def _output_path(job_id: str, filename: str) -> str:
    return f"out/{job_id}/{filename}"


def _replay_hit(job_id: str, request_key: str, original: bytes, current: dict, provider: str) -> bool:
    directory = settings.out_dir / ".cache"
    try:
        index = json.loads((directory / "requests" / f"{request_key}.json").read_text())
        cached_index = json.loads((directory / f"{index['cache_key']}.json").read_text())
        cached = read_manifest(cached_index["job_id"])
        prompt = cached["constraints"]["prompt_global"]
        if cached["constraints"].get("prompt_version") != PROMPT_VERSION:
            return False
        if provider != "demo" and cached["constraints"].get("fallback", True):
            return False  # A recovered historian must get another chance on retry.
        if manifest_year(cached) != manifest_year(current):
            return False
        if cache_key(original, manifest_year(current), provider, prompt) != index["cache_key"]:
            return False
        if cached.get("status") != "done" or cached.get("baseline_of"):
            return False
        old_id = cached["job_id"]
        required = ["band.jpg", "band_ext.jpg", "result.jpg"]
        required.extend(f"t{tile['i']}{suffix}.jpg" for tile in cached["tiles"] for suffix in ("", "_raw"))
        if cached["anchor"]["status"] == "done":
            required.append("anchor.jpg")
        old_dir = job_dir(old_id)
        if not all((old_dir / name).is_file() for name in required):
            return False
        target = job_dir(job_id)
        target.mkdir(parents=True, exist_ok=True)
        if old_id != job_id:
            for name in required:
                shutil.copy2(old_dir / name, target / name)

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
    except (OSError, ValueError, KeyError, TypeError):
        return False


async def run_job(job_id: str, *, concurrency: int | None = None, use_cache: bool = True) -> dict:
    """Run once; persist every visible state transition before exposing its files."""
    started = time.time()
    manifest = read_manifest(job_id)
    provider = manifest.get("provider") or settings.provider
    directory = job_dir(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    stage = "preprocess"

    def start(m):
        m.update(status="running", stage=stage, mode="live", provider=provider,
                 is_demo=provider == "demo", demo=provider == "demo", cache_hit=False)
        m["metrics"] = {"started_at": started, "anchor_done_at": None, "first_tile_at": None,
                        "finished_at": None, "first_view_s": None, "total_s": None,
                        "seam_err": {"raw": None, "after_color_match": None, "originals_floor": None,
                                     "after_compensation": None, "at_seam_cut": None, "carved_seams": None},
                        "compensation": None, "seams": [],
                        "integrity": {"tested": 0, "splits_detected": 0, "retries": 0,
                                      "unresolved": 0, "worst_step_de": None},
                        "serial_baseline_s": None, "speedup": None, "image_calls": 0,
                        "alignment": {"score_before": None, "score_after": None, "mean_shift_px": None, "applied": 0},
                        "tokens": {"vlm": 0, "llm": 0}}
        m["result"] = {"path": _output_path(job_id, "result.jpg"), "status": "pending"}
        m["anchor"] = {"status": "pending", "path": _output_path(job_id, "anchor.jpg"), "ms": None}
        m["tiles"] = []
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
        pool = EditorPool(primary=provider, fallback=settings.provider_fallback)
        seed = int(manifest.get("job_seed", 0))
        structure_lock = settings.structure_lock

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

        async def generate_anchor(anchor_prompt: str, anchor_negative: str | None, anchor_strength: float):
            start_at = time.perf_counter()
            update_manifest(job_id, lambda m: m["anchor"].update(status="running"))
            try:
                squeezed = await asyncio.to_thread(squeeze_anchor, prepared.band)
                result = await pool.edit(await asyncio.to_thread(image_bytes, squeezed),
                                         anchor_prompt, seed=seed, strength=anchor_strength, negative=anchor_negative)
                anchor = await asyncio.to_thread(open_rgb, result.image)
                await asyncio.to_thread(_save_image, directory / "anchor.jpg", anchor)
                update_manifest(job_id, lambda m: m["anchor"].update(status="done", provider=result.provider,
                    attempts=result.attempts, ms=round((time.perf_counter() - start_at) * 1000)))
                return anchor
            except Exception as exc:
                reason = _reason(exc)
                update_manifest(job_id, lambda m: m["anchor"].update(status="skipped",
                    error=f"Anchor unavailable: {reason}",
                    ms=round((time.perf_counter() - start_at) * 1000)))
                return None
            finally:
                update_manifest(job_id, lambda m: m["metrics"].update(anchor_done_at=time.time(),
                                                                       image_calls=pool.image_calls))

        if structure_lock:
            # With every silhouette pinned, the anchor only has to settle sky, light and
            # palette for the year — it does not need the site history. Start it at once,
            # alongside scene parsing and the historian, and save a full round trip.
            update_manifest(job_id, lambda m: m.update(stage="anchor"))
            stage = "anchor"
            (scene, constraint_data), anchor = await asyncio.gather(
                scene_and_history(),
                generate_anchor(generic_decade_prompt(year), None, .55),
            )
            update_manifest(job_id, lambda m: m["anchor"].update(prompt="generic_decade"))
        else:
            scene, constraint_data = await scene_and_history()
            stage = "anchor"
            update_manifest(job_id, lambda m: m.update(stage="anchor"))
            anchor_strength = .7 if constraint_data.get("historical_context", {}).get("site_state") in {
                "undeveloped", "agricultural"
            } else .55
            anchor = await generate_anchor(constraint_data["prompt_global"], constraint_data.get("negative"), anchor_strength)
        prompt = constraint_data["prompt_global"]  # One immutable string shared by every tile.
        negative = constraint_data.get("negative")
        # Under the pixel lock the editor must keep structure: a lower strength keeps
        # edges where they are and moves the era into surfaces and palette.
        strength = .45 if structure_lock else (.7 if constraint_data.get("historical_context", {}).get("site_state") in {
            "undeveloped", "agricultural"
        } else .55)
        priority = viewport_priority(geometry["x"], manifest.get("heading", .5),
                                     geometry["W_ext"], geometry["wrap"])
        tiles = [{"i": i, "x": x, "priority": priority[i], "status": "pending",
                  "raw_path": _output_path(job_id, f"t{i}_raw.jpg"),
                  "path": _output_path(job_id, f"t{i}.jpg"), "ms": None, "attempts": 0,
                  "provider": provider, "error": None}
                 for i, x in enumerate(geometry["x"])]
        update_manifest(job_id, lambda m: m.update(tiles=tiles, stage="tiles"))
        originals = [prepared.band_ext.crop((x, 0, x + TILE, H)) for x in geometry["x"]]
        stage = "tiles"
        gate = asyncio.Semaphore(max(1, min(6, concurrency or settings.max_concurrency)))

        async def generate_tile(index: int):
            async with gate:
                tile_start = time.perf_counter()
                update_manifest(job_id, lambda m: m["tiles"][index].update(status="running"))
                try:
                    reference = await asyncio.to_thread(anchor_crop, anchor, geometry["x"][index],
                        geometry["W"], wrap=geometry["wrap"]) if anchor is not None else None
                    reference_bytes = await asyncio.to_thread(image_bytes, reference) if reference is not None else None
                    original_bytes_tile = await asyncio.to_thread(image_bytes, originals[index])

                    async def attempt():
                        outcome = await pool.edit(original_bytes_tile, prompt, reference=reference_bytes,
                                                  seed=seed, strength=strength, negative=negative)
                        image = await asyncio.to_thread(open_rgb, outcome.image)
                        if image.size != (TILE, H):
                            image = image.resize((TILE, H), Image.Resampling.LANCZOS)
                        return outcome, image, await asyncio.to_thread(split_check, originals[index], image)

                    result, raw, integrity = await attempt()
                    # Occasionally the editor returns two pictures butted together rather
                    # than one repainted view. No amount of stitching can help -- the break
                    # is inside a single tile -- so the only fix is to ask again, and to keep
                    # whichever of the two answers is actually one picture.
                    if integrity.get("split"):
                        try:
                            retried = await attempt()
                        except Exception:
                            retried = None      # A failed retry must not lose a usable tile.
                        if retried is not None:
                            integrity = {**integrity, "retried": True, "first": {
                                key: integrity[key] for key in ("column", "step_de", "broken_rows")
                                if key in integrity}}
                            if worse(integrity, retried[2]):
                                result, raw = retried[0], retried[1]
                                integrity = {**retried[2], "retried": True,
                                             "first": integrity["first"]}
                            else:
                                integrity["kept"] = "first attempt; the retry was no better"
                    await asyncio.to_thread(_save_image, directory / f"t{index}_raw.jpg", raw)
                    # Pixel alignment: register the generation back onto the original tile so the
                    # before/after slider compares the same pixels and neighbouring tiles agree.
                    aligned, alignment = await asyncio.to_thread(align_tile, originals[index], raw)
                    matched = await asyncio.to_thread(color_match, aligned, reference, COLOR_MATCH_K) if reference is not None else aligned
                    await asyncio.to_thread(_save_image, directory / f"t{index}.jpg", matched)

                    def done(m):
                        now = time.time()
                        m["tiles"][index].update(status="done", provider=result.provider, attempts=result.attempts,
                            ms=round((time.perf_counter() - tile_start) * 1000), done_at=now, error=None,
                            align=alignment.to_dict(), integrity=integrity)
                        if m["metrics"]["first_tile_at"] is None:
                            m["metrics"]["first_tile_at"] = now
                            m["metrics"]["first_view_s"] = round(now - started, 4)
                        m["metrics"]["image_calls"] = pool.image_calls
                    update_manifest(job_id, done)
                except Exception as exc:
                    reason = _reason(exc)
                    attempts = getattr(exc, "attempts", 0)
                    failed_provider = getattr(exc, "provider", provider)
                    # Both paths remain inspectable even when the original is the fallback.
                    await asyncio.to_thread(_save_image, directory / f"t{index}_raw.jpg", originals[index])
                    await asyncio.to_thread(_save_image, directory / f"t{index}.jpg", originals[index])
                    update_manifest(job_id, lambda m: m["tiles"][index].update(status="error",
                        error=f"Tile generation failed: {reason}; original retained",
                        attempts=attempts, provider=failed_provider,
                        ms=round((time.perf_counter() - tile_start) * 1000)))

        async def launch_all():
            # Give the tile the viewer is facing a head start; otherwise, when every tile
            # fits inside the concurrency budget, "first tile" is decided by API luck.
            order = sorted(range(geometry["n"]), key=lambda i: priority[i])
            first = [i for i in order if priority[i] == 0]
            rest = [i for i in order if priority[i] != 0]
            tasks = [asyncio.create_task(generate_tile(i)) for i in first]
            if rest:
                if first and settings.priority_stagger_s > 0:
                    await asyncio.sleep(settings.priority_stagger_s)
                tasks.extend(asyncio.create_task(generate_tile(i)) for i in rest)
            await asyncio.gather(*tasks)

        await launch_all()
        stage = "stitch"
        update_manifest(job_id, lambda m: m.update(stage=stage))

        def finish_images(failed: frozenset[int]):
            raw = [open_rgb(directory / f"t{i}_raw.jpg") for i in range(geometry["n"])]
            matched = [open_rgb(directory / f"t{i}.jpg") for i in range(geometry["n"])]
            # Anchor matching makes each tile plausible alone; these two steps make
            # the neighbours agree. Compensation removes tonal drift across the whole
            # band; the carve routes the cut around whatever the tiles drew differently.
            # A failed tile is the unedited photograph and is left exactly as it is.
            compensated, compensation = compensate_exposure(matched, geometry["x"], fixed=failed)
            plan = seam_plan(compensated, geometry["x"])
            result = stitch(compensated, geometry["x"], geometry["overlap"], geometry["wrap"],
                            W=geometry["W"], plan=plan)
            _save_image(directory / "result.jpg", result)
            for index, tile in enumerate(compensated):
                # The published tiles are the ones the result is built from, so the
                # progressive view and the final panorama cannot disagree.
                if index not in failed:
                    _save_image(directory / f"t{index}.jpg", tile)
            return (seam_metrics(raw, matched, originals, geometry["x"], compensated, plan),
                    compensation, [seam.to_dict() for seam in plan])

        failed_tiles = frozenset(tile["i"] for tile in read_manifest(job_id)["tiles"]
                                 if tile.get("status") == "error")
        seams, compensation, seam_details = await asyncio.to_thread(finish_images, failed_tiles)
        finished = time.time()

        def complete(m):
            m["metrics"].update(timing_metrics(m["metrics"], finished), seam_err=seams, image_calls=pool.image_calls,
                                alignment=alignment_metrics(m["tiles"]),
                                integrity=integrity_metrics(m["tiles"]),
                                compensation=compensation, seams=seam_details)
            m["result"]["status"] = "done"
            m["status"] = "done_partial" if any(t["status"] == "error" for t in m["tiles"]) else "done"
            m["stage"] = "complete"
            m["cache_key"] = cache_key(original_bytes, year, provider, prompt)
        final = update_manifest(job_id, complete)
        history_cacheable = provider == "demo" or not constraint_data.get("fallback", True)
        if use_cache and final["status"] == "done" and history_cacheable:
            cache_dir = settings.out_dir / ".cache"
            await asyncio.to_thread(_atomic_json, cache_dir / f"{final['cache_key']}.json", {"job_id": job_id})
            await asyncio.to_thread(_atomic_json, cache_dir / "requests" / f"{request_hash}.json",
                                    {"cache_key": final["cache_key"]})
        return final
    except Exception as exc:
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
