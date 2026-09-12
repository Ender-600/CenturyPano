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

from .config import COLOR_MATCH_K, DECADE_ANCHOR, H, TILE, settings
from .consistency import anchor_crop, color_match, squeeze_anchor
from .constraints import build_constraints, generic_decade_prompt
from .editors.base import EditorPool
from .geometry import image_bytes, open_rgb, preprocess, viewport_priority
from .manifest import job_dir, read_manifest, update_manifest
from .metrics import seam_metrics, timing_metrics
from .scene import parse_scene
from .stitch import stitch


def cache_key(image: bytes, decade: str, provider: str, prompt_global: str) -> str:
    """The public cache contract deliberately includes the exact original bytes."""
    return hashlib.sha256(image + decade.encode() + provider.encode() + prompt_global.encode()).hexdigest()


def _request_key(image: bytes, manifest: dict, provider: str) -> str:
    # This index allows a replay lookup before making any scene/constraint calls.
    # Location and the 360 override affect interpretation and must not collide.
    context_data = {"decade": manifest["decade"], "provider": provider,
                    "place": manifest.get("place", {}),
                    "is_360": manifest["source"].get("is_360")}
    # Do not add an empty profile to legacy requests: existing demo cache hashes
    # must remain valid. OpenAI model and quality are part of image identity.
    if "image_config" in manifest:
        context_data["image_config"] = manifest["image_config"]
    context = json.dumps(context_data, sort_keys=True, separators=(",", ":"))
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
        cached_id = index.get("job_id")
        if cached_id is None:
            # Older indexes used this shared secondary pointer. New requests
            # point to their own job so equal prompts cannot cross profiles.
            cached_index = json.loads((directory / f"{index['cache_key']}.json").read_text())
            cached_id = cached_index["job_id"]
        cached = read_manifest(cached_id)
        if cached.get("image_config") != current.get("image_config"):
            return False
        if cached.get("provider", provider) != provider or cached["decade"] != current["decade"]:
            return False
        prompt = cached["constraints"]["prompt_global"]
        if cache_key(original, current["decade"], provider, prompt) != index["cache_key"]:
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
    image_config = None
    if provider == "openai":
        saved_config = manifest.get("image_config") or {}
        image_config = {"model": saved_config.get("model", settings.openai_image_model),
                        "quality": saved_config.get("quality", settings.openai_image_quality)}
        manifest["image_config"] = image_config
    directory = job_dir(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    stage = "preprocess"

    def start(m):
        m.update(status="running", stage=stage, mode="live", provider=provider,
                 is_demo=provider == "demo", demo=provider == "demo", cache_hit=False)
        if image_config is not None:
            m["image_config"] = dict(image_config)
        m["metrics"] = {"started_at": started, "anchor_done_at": None, "first_tile_at": None,
                        "finished_at": None, "first_view_s": None, "total_s": None,
                        "seam_err": {"raw": None, "after_color_match": None, "originals_floor": None},
                        "serial_baseline_s": None, "speedup": None, "image_calls": 0,
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
        scene = await parse_scene(band_bytes, provider=provider)
        tokens_vlm = int(scene.pop("_tokens", 0))
        update_manifest(job_id, lambda m: (m.update(scene=scene, stage="anchor"),
                                           m["metrics"]["tokens"].update(vlm=tokens_vlm)))
        stage = "anchor"
        primary = provider
        if provider == "openai":
            from .editors.openai import OpenAIImageEditor
            primary = OpenAIImageEditor(model=image_config["model"], quality=image_config["quality"])
        pool = EditorPool(primary=primary, fallback=settings.provider_fallback)
        seed = int(manifest.get("job_seed", 0))
        decade = manifest["decade"]

        async def generate_anchor():
            start_at = time.perf_counter()
            update_manifest(job_id, lambda m: m["anchor"].update(status="running"))
            try:
                squeezed = await asyncio.to_thread(squeeze_anchor, prepared.band)
                result = await pool.edit(await asyncio.to_thread(image_bytes, squeezed),
                                         generic_decade_prompt(decade), seed=seed, strength=.45)
                anchor = await asyncio.to_thread(open_rgb, result.image)
                await asyncio.to_thread(_save_image, directory / "anchor.jpg", anchor)
                update_manifest(job_id, lambda m: m["anchor"].update(status="done", provider=result.provider,
                    attempts=result.attempts, ms=round((time.perf_counter() - start_at) * 1000)))
                return anchor
            except Exception as exc:
                error_type = type(exc).__name__
                update_manifest(job_id, lambda m: m["anchor"].update(status="skipped",
                    error=f"Anchor unavailable ({error_type})",
                    ms=round((time.perf_counter() - start_at) * 1000)))
                return None
            finally:
                update_manifest(job_id, lambda m: m["metrics"].update(anchor_done_at=time.time(),
                                                                       image_calls=pool.image_calls))

        constraints, anchor = await asyncio.gather(build_constraints(manifest.get("place", {}), decade, scene, provider=provider),
                                                    generate_anchor())
        constraint_data = constraints.to_dict() if hasattr(constraints, "to_dict") else dict(constraints)
        prompt = constraint_data["prompt_global"]  # One immutable string shared by every tile.
        negative = constraint_data.get("negative")
        tokens_llm = int(getattr(constraints, "_tokens", constraint_data.pop("_tokens", 0)))
        priority = viewport_priority(geometry["x"], manifest.get("heading", .5),
                                     geometry["W_ext"], geometry["wrap"])
        tiles = [{"i": i, "x": x, "priority": priority[i], "status": "pending",
                  "raw_path": _output_path(job_id, f"t{i}_raw.jpg"),
                  "path": _output_path(job_id, f"t{i}.jpg"), "ms": None, "attempts": 0,
                  "provider": provider, "error": None}
                 for i, x in enumerate(geometry["x"])]
        update_manifest(job_id, lambda m: (m.update(constraints=constraint_data, tiles=tiles, stage="tiles",
                                                    anchor_year=DECADE_ANCHOR[decade]),
                                          m["metrics"]["tokens"].update(llm=tokens_llm)))
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
                    result = await pool.edit(await asyncio.to_thread(image_bytes, originals[index]), prompt,
                                             reference=reference_bytes, seed=seed, strength=.45, negative=negative)
                    raw = await asyncio.to_thread(open_rgb, result.image)
                    if raw.size != (TILE, H):
                        raw = raw.resize((TILE, H), Image.Resampling.LANCZOS)
                    await asyncio.to_thread(_save_image, directory / f"t{index}_raw.jpg", raw)
                    matched = await asyncio.to_thread(color_match, raw, reference, COLOR_MATCH_K) if reference is not None else raw
                    await asyncio.to_thread(_save_image, directory / f"t{index}.jpg", matched)

                    def done(m):
                        now = time.time()
                        m["tiles"][index].update(status="done", provider=result.provider, attempts=result.attempts,
                            ms=round((time.perf_counter() - tile_start) * 1000), done_at=now, error=None)
                        if m["metrics"]["first_tile_at"] is None:
                            m["metrics"]["first_tile_at"] = now
                            m["metrics"]["first_view_s"] = round(now - started, 4)
                        m["metrics"]["image_calls"] = pool.image_calls
                    update_manifest(job_id, done)
                except Exception as exc:
                    error_type = type(exc).__name__
                    attempts = getattr(exc, "attempts", 0)
                    failed_provider = getattr(exc, "provider", provider)
                    # Both paths remain inspectable even when the original is the fallback.
                    await asyncio.to_thread(_save_image, directory / f"t{index}_raw.jpg", originals[index])
                    await asyncio.to_thread(_save_image, directory / f"t{index}.jpg", originals[index])
                    update_manifest(job_id, lambda m: m["tiles"][index].update(status="error",
                        error=f"Tile generation failed ({error_type}); original retained",
                        attempts=attempts, provider=failed_provider,
                        ms=round((time.perf_counter() - tile_start) * 1000)))

        await asyncio.gather(*(generate_tile(i) for i in sorted(range(geometry["n"]), key=lambda i: priority[i])))
        stage = "stitch"
        update_manifest(job_id, lambda m: m.update(stage=stage))

        def finish_images():
            raw = [open_rgb(directory / f"t{i}_raw.jpg") for i in range(geometry["n"])]
            matched = [open_rgb(directory / f"t{i}.jpg") for i in range(geometry["n"])]
            result = stitch(matched, geometry["x"], geometry["overlap"], geometry["wrap"], W=geometry["W"])
            _save_image(directory / "result.jpg", result)
            return seam_metrics(raw, matched, originals, geometry["x"])

        seams = await asyncio.to_thread(finish_images)
        finished = time.time()

        def complete(m):
            m["metrics"].update(timing_metrics(m["metrics"], finished), seam_err=seams, image_calls=pool.image_calls)
            m["result"]["status"] = "done"
            m["status"] = "done_partial" if any(t["status"] == "error" for t in m["tiles"]) else "done"
            m["stage"] = "complete"
            m["cache_key"] = cache_key(original_bytes, decade, provider, prompt)
        final = update_manifest(job_id, complete)
        if use_cache and final["status"] == "done":
            cache_dir = settings.out_dir / ".cache"
            await asyncio.to_thread(_atomic_json, cache_dir / f"{final['cache_key']}.json", {"job_id": job_id})
            await asyncio.to_thread(_atomic_json, cache_dir / "requests" / f"{request_hash}.json",
                                    {"cache_key": final["cache_key"], "job_id": job_id})
        return final
    except Exception as exc:
        error_type = type(exc).__name__
        def fail(m):
            m.update(status="error", stage=stage, error=f"Processing failed during {stage} ({error_type})")
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
