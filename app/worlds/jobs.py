"""Durable depth → RGB panorama → Marble world jobs.

Only one POST per stage is allowed. Ambiguous submissions stop until reconciled;
recovery of an accepted stage uses its stored operation ID. Provider responses
and signed asset URLs remain in private files, never in public job records.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import time
from typing import Any

import httpx
from PIL import Image

from .assets import AssetError, _download, _validate_url, download_assets, inspect_image
from .marble import MarbleClient, MarbleError, SubmissionUnknown, _finite_number, _valid_id


_JOB_ID = re.compile(r"[0-9a-f]{32}\Z")
_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\Z")
_TERMINAL = {"ready", "error", "submission_unknown", "insufficient_credits"}
GENERATION_PROFILE = 'depth-history-v2'
_GENERATION_FIELDS = (
    "target_year", "location", "history_context", "changes", "modern_buildings", "historical_buildings",
    "camera_position", "heading_deg", "geometry_source", "coordinate_frame", "sources", "uncertainties", "generation_profile",
)


def _atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".save-", delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _write_json(path: Path, value: Any) -> None:
    _atomic_bytes(path, json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2).encode())


def _read_json(path: Path) -> dict:
    result = json.loads(path.read_text())
    if not isinstance(result, dict):
        raise ValueError("Invalid stored world job")
    return result


def _generation_hash(plan: dict) -> str:
    content = {key: plan[key] for key in _GENERATION_FIELDS if key in plan}
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


@asynccontextmanager
async def _file_lock(path: Path, *, wait: bool = True):
    """Protect shared worktree/reload workers without blocking the event loop."""
    with path.open("a+b") as lock:
        acquired = False
        try:
            while not acquired:
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except BlockingIOError:
                    if not wait:
                        break
                    await asyncio.sleep(.1)
            yield acquired
        finally:
            if acquired:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _prompt(plan: dict) -> str:
    year = plan["target_year"]
    context = plan.get("history_context", "")
    def prose(value, limit):
        # Human prose only: never waste the budget on serialized metadata or
        # cut JSON halfway through a Unicode escape sequence.
        return re.sub(r"https?://\S+", "", value).strip()[:limit] if isinstance(value, str) else ''
    location = plan.get('location', {})
    place = ''
    if isinstance(context, dict):
        described = context.get('location', {})
        if isinstance(described, dict):
            place = ', '.join(prose(described.get(key), 60) for key in ('city', 'admin1', 'country')
                              if prose(described.get(key), 60))
        summary = prose(context.get('period_summary'), 240)
        details = context.get('local_context', [])
        context = summary + ' ' + ' '.join(prose(item, 120) for item in details[:3]) if isinstance(details, list) else summary
    context = prose(context, 420)
    # The campus label is tied to coordinates and curated evidence, not a
    # matching building name at an unrelated location.
    lat, lon = location.get('lat'), location.get('lon')
    if (_finite_number(lat) and _finite_number(lon) and 40.435 <= lat <= 40.450
            and -79.952 <= lon <= -79.933
            and any(str(source.get('id', '')).startswith('cmu-') for source in plan.get('sources', [])
                    if isinstance(source, dict))):
        place = 'Carnegie Institute of Technology campus (now Carnegie Mellon), Pittsburgh, Pennsylvania, United States'
    place = place or (f'latitude {lat}, longitude {lon}' if lat is not None and lon is not None else 'the selected site')
    buildings = {item.get("id"): item.get("label", item.get("id"))
                 for item in plan.get("modern_buildings", []) if isinstance(item, dict)}
    removed = [buildings.get(item.get("building_id"), item.get("name", item.get("building_id", "modern building")))
               for item in plan.get("changes", []) if isinstance(item, dict) and item.get("action") == "remove"]
    changes = ', '.join(prose(item, 75) for item in removed[:6])[:350]
    edited_ids = {item.get('building_id') for item in plan.get('changes', [])
                  if isinstance(item, dict) and item.get('action') in ('add', 'replace')}
    edited = ', '.join(prose(item.get('label', item.get('id')), 70)
                       for item in plan.get('historical_buildings', [])
                       if isinstance(item, dict) and item.get('id') in edited_ids)[:180]
    return (
        f"Create a historically plausible outdoor scene at {place} in the year {year}. "
        "Use the supplied full spherical depth panorama as a coarse layout reference. "
        "Preserve the visible building silhouettes, scale and horizon. The flat ground does not encode roads: "
        "do not invent broad highways, parking lots or dense towers in empty areas. Do not restore modern "
        "buildings removed from the geometry. Depict period-appropriate architecture and materials. "
        + ("For this pre-1940 scene omit modern lane markings, modern vehicles, glass office towers, "
           "billboards and digital signs. " if year < 1940 else '')
        + "Return a continuous 360 by 180 degree panorama without borders or added text. "
        "Uncertain historical details are imagined, not verified reconstruction. "
        f"Removed modern buildings: {changes}. Their predecessors or earlier land use are unknown. "
        + (f"User-supplied historical structures, not independently verified: {edited}. " if edited else '')
        + f"Historical context: {context}."
    )[:2000]


async def _download_pano(url: str, directory: Path) -> Path:
    """The only image fetch path: same explicit CDN policy as world assets, no key."""
    url = _validate_url(url)
    with tempfile.TemporaryDirectory(prefix=".pano-", dir=directory) as staging:
        source_path = Path(staging) / "source"
        async with httpx.AsyncClient(
            trust_env=False, follow_redirects=False, headers={"Accept-Encoding": "identity"},
            timeout=httpx.Timeout(60, connect=15),
        ) as client:
            await _download(client, url, source_path)
        checked = await asyncio.to_thread(inspect_image, source_path)
        extension = "png" if checked["format"] == "png" else "jpg"
        target = directory / f"panorama_source.{extension}"
        _atomic_bytes(target, source_path.read_bytes())
    return target


def _pano_jpeg(path: Path) -> bytes:
    with Image.open(path) as source:
        if source.width != 2 * source.height:
            raise AssetError("invalid_panorama", "Generated panorama does not have full spherical dimensions.")
        # Do not transpose EXIF, rotate, crop, or resize a spherical projection.
        # Its pixel coordinate frame must remain exactly as delivered.
        output = io.BytesIO()
        source.convert("RGB").save(output, "JPEG", quality=95, subsampling=0)
    if len(output.getvalue()) > 10 * 1024 * 1024:
        raise AssetError("panorama_too_large", "Generated panorama exceeds the inline world input limit.")
    return output.getvalue()


def _geometry_renderer(**arguments):
    from .geometry import render_depth
    return render_depth(**arguments)


class WorldJobManager:
    def __init__(
        self, root_dir: Path, api_key: str, *, client_factory=None, poll_s: float = 5,
        asset_downloader=None, pano_downloader=None, renderer=None,
    ) -> None:
        self.root_dir = Path(root_dir).resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._api_key = api_key
        self._client_factory = client_factory or (lambda: MarbleClient(api_key))
        self._asset_downloader = asset_downloader or download_assets
        self._pano_downloader = pano_downloader or _download_pano
        self._renderer = renderer or _geometry_renderer
        if not _finite_number(poll_s) or poll_s <= 0:
            raise ValueError("Invalid world polling interval")
        self._poll_s = poll_s
        self._tasks: dict[str, asyncio.Task] = {}
        self._closed = False

    def _directory(self, job_id: str) -> Path:
        if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            raise ValueError("Invalid world job ID")
        return self.root_dir / job_id

    def _save(self, record: dict) -> None:
        record["updated_at"] = time.time()
        _write_json(self._directory(record["id"]) / "record.json", record)

    def _stage(self, record: dict, stage: str) -> None:
        record["stage"] = stage
        record["stage_times"].setdefault(stage, time.time())
        record.pop("error_code", None)
        self._save(record)

    def _schedule(self, job_id: str) -> None:
        if self._closed:
            return
        previous = self._tasks.get(job_id)
        if previous is None or previous.done():
            task = asyncio.create_task(self._run(job_id), name=f"world-{job_id}")
            self._tasks[job_id] = task
            # _run handles provider and local failures without exposing response bodies.
            task.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)

    async def start(self, plan: dict, model: str = "marble-1.0-draft") -> dict:
        if self._closed:
            raise ValueError("World job manager is closed")
        if not isinstance(self._api_key, str) or not self._api_key.strip():
            raise MarbleError("WORLDLAB_API_KEY is not configured", code="missing_key")
        if model != "marble-1.0-draft":
            raise ValueError("This world pipeline currently supports Marble Draft only")
        try:
            encoded = json.dumps(plan, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
            frozen = json.loads(encoded)
            if (not isinstance(frozen, dict) or type(frozen.get("target_year")) is not int
                    or not 1 <= frozen["target_year"] <= 2100
                    or not isinstance(frozen.get("historical_buildings"), list)
                    or not isinstance(frozen.get("camera_position"), (list, dict))):
                raise ValueError
        except (ValueError, TypeError, UnicodeError):
            raise ValueError("Invalid frozen historical world plan") from None
        # A UI record ID does not make otherwise identical paid generation new.
        # Cache timestamps, parent/UI IDs and rendered asset URLs do not affect
        # generated appearance or geometry. Bound evidence remains part of it.
        plan_hash = _generation_hash(frozen)
        job_id = hashlib.sha256((plan_hash + ":" + model).encode()).hexdigest()[:32]
        directory = self._directory(job_id)
        async with _file_lock(self.root_dir / ".creation.lock"):
            if not (directory / "record.json").exists():
                # Older versions included UI metadata in the hash. Reuse their
                # accepted operation receipts instead of starting paid work again.
                for previous in self.root_dir.iterdir():
                    if not previous.is_dir() or not _JOB_ID.fullmatch(previous.name):
                        continue
                    try:
                        stored = _read_json(previous / "record.json")
                        if (stored.get("model") == model and stored.get("id") == previous.name
                                and _generation_hash(_read_json(previous / "plan.json")) == plan_hash):
                            directory, job_id = previous, previous.name
                            break
                    except (OSError, ValueError, TypeError):
                        continue
            if not (directory / "record.json").exists():
                directory.mkdir(exist_ok=True, mode=0o700)
                _write_json(directory / "plan.json", frozen)
                self._save({
                    "schema_version": 1, "id": job_id, "plan_hash": plan_hash,
                    **({"plan_id": frozen["plan_id"]} if _valid_id(frozen.get("plan_id")) else {}),
                    "model": model, "year": frozen["target_year"], "prompt": _prompt(frozen),
                    "stage": "queued", "created_at": time.time(), "stage_times": {},
                    "timing_s": {}, "generation_calls": {"depth": 0, "world": 0},
                    "cost_credits": {"depth": None, "world": None}, "assets": [],
                })
        record = _read_json(directory / "record.json")
        if record["stage"] not in _TERMINAL:
            self._schedule(job_id)
        return self.get(job_id)

    def get(self, job_id: str) -> dict | None:
        path = self._directory(job_id) / "record.json"
        if not path.is_file():
            return None
        record = _read_json(path)
        result = {key: record[key] for key in (
            "id", "plan_id", "model", "year", "stage", "created_at", "updated_at", "timing_s",
            "generation_calls", "error_code", "http_status", "credits_before_depth",
            "credits_before_world", "credits_after",
        ) if key in record}
        result.update(job_id=record["id"], status=record["stage"], can_resume=self._can_resume(record))
        costs = {name: record.get("cost_credits", {}).get(name) for name in ("depth", "world")}
        known = [value for value in costs.values() if _finite_number(value) and value >= 0]
        costs["known_total"] = sum(known)
        costs["total"] = sum(known) if len(known) == 2 else None
        result["cost_credits"] = costs
        result["assets"] = []
        for item in record.get("assets", []):
            public = {key: item[key] for key in (
                "kind", "filename", "bytes", "sha256", "media_type", "validation", "lod",
                "semantics_metadata", "semantics_status",
            ) if key in item}
            public["url"] = f"/world-jobs/{job_id}/assets/{item['filename']}"
            result["assets"].append(public)
        result["validation"] = {
            "historical_accuracy": "unverified", "geometry": "coarse_reference",
            "gpu_rendering": "unverified", "phone_6dof": "unverified", "coordinate_alignment": "unverified",
        }
        review = record.get('review')
        if isinstance(review, dict) and review.get('status') == 'rejected':
            result['review'] = {key: review[key] for key in ('status', 'scope', 'notes', 'reviewed_at') if key in review}
            result['validation']['historical_accuracy'] = 'failed_visual_review'
        return result

    @staticmethod
    def _can_resume(record: dict) -> bool:
        if record.get("stage") not in {"paused", "error"} or record.get("error_code") in {
            "submission_unknown", "operation_failed", "insufficient_credits",
        }:
            return False
        # A paid attempt without a durable accepted operation cannot be replayed,
        # even if an older record accidentally describes it as merely paused.
        for stage in ("depth", "world"):
            if record.get("generation_calls", {}).get(stage, 0) and not _valid_id(record.get(f"{stage}_operation_id")):
                return False
        if record["stage"] == "paused":
            return True
        return record.get("resume_stage") in {
            "generating_depth", "fetching_pano", "pano_ready", "generating_world", "fetching_assets",
        } and any(_valid_id(record.get(f"{stage}_operation_id")) for stage in ("depth", "world"))

    async def resume(self, job_id: str) -> dict:
        """Continue safe work; never reset operation IDs, costs, or paid counters."""
        if self._closed:
            raise ValueError("World job manager is closed")
        if not isinstance(self._api_key, str) or not self._api_key.strip():
            raise MarbleError("WORLDLAB_API_KEY is not configured", code="missing_key")
        directory = self._directory(job_id)
        if not (directory / "record.json").is_file():
            raise MarbleError("World job was not found", code="job_not_found")
        async with _file_lock(directory / ".job.lock", wait=False) as acquired:
            if not acquired:
                return self.get(job_id)
            record = _read_json(directory / "record.json")
            if record.get("stage") not in _TERMINAL and record.get("stage") != "paused":
                # A duplicate resume request sees the already-running state.
                return self.get(job_id)
            if not self._can_resume(record):
                raise MarbleError("This world job cannot be safely resumed", code="resume_not_allowed")
            self._stage(record, "queued")
        self._schedule(job_id)
        return self.get(job_id)

    def artifact_path(self, job_id: str, filename: str) -> Path | None:
        directory = self._directory(job_id)
        if not isinstance(filename, str) or not _FILENAME.fullmatch(filename):
            return None
        try:
            record = _read_json(directory / "record.json")
        except FileNotFoundError:
            return None
        for item in record.get("assets", []):
            if item.get("filename") == filename:
                path = (directory / item["relative_path"]).resolve()
                if path.is_relative_to(directory) and path.is_file():
                    return path
        return None

    async def resume_all(self) -> None:
        if self._closed:
            raise ValueError("World job manager is closed")
        for directory in self.root_dir.iterdir():
            if not directory.is_dir() or not _JOB_ID.fullmatch(directory.name):
                continue
            try:
                record = _read_json(directory / "record.json")
            except (OSError, ValueError):
                continue
            if record.get("stage") not in _TERMINAL:
                self._schedule(directory.name)

    async def aclose(self) -> None:
        self._closed = True
        tasks = [task for task in self._tasks.values() if not task.done()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _asset(self, record: dict, path: Path, kind: str, media_type: str, **extra) -> None:
        directory = self._directory(record["id"])
        relative = path.resolve().relative_to(directory)
        if not _FILENAME.fullmatch(path.name):
            raise AssetError("invalid_asset_metadata", "Asset filename is not supported.")
        data = path.read_bytes()
        item = {"kind": kind, "filename": path.name, "relative_path": relative.as_posix(),
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "media_type": media_type, **extra}
        record["assets"] = [old for old in record["assets"] if old["filename"] != item["filename"]] + [item]

    async def _render(self, record: dict, plan: dict, directory: Path) -> None:
        if record.get("geometry_ready"):
            return
        self._stage(record, "rendering_depth")
        started = time.time()
        rendered = await asyncio.to_thread(
            self._renderer, buildings=plan["historical_buildings"], camera_position=plan["camera_position"],
            heading_deg=plan.get("heading_deg", 0),
        )
        if not isinstance(rendered, dict):
            rendered = {key: getattr(rendered, key) for key in ("depth_png", "preview_png", "mesh_glb", "metadata")}
        for key, filename, kind, mime in (
            ("depth_png", "depth.png", "depth", "image/png"),
            ("preview_png", "depth_preview.png", "depth_preview", "image/png"),
            ("mesh_glb", "coarse.glb", "coarse_mesh", "model/gltf-binary"),
        ):
            _atomic_bytes(directory / filename, rendered[key])
            self._asset(record, directory / filename, kind, mime)
        record["depth_metadata"] = rendered["metadata"]
        record["geometry_ready"] = True
        record["timing_s"]["depth_render"] = time.time() - started
        self._save(record)

    def _accept(self, record: dict, stage: str, operation: dict) -> None:
        if (not isinstance(operation, dict) or not _valid_id(operation.get("operation_id"))
                or type(operation.get("done")) is not bool):
            raise SubmissionUnknown()
        # The separate receipt survives a crash before record.json is replaced.
        _write_json(self._directory(record["id"]) / f"{stage}_operation.json", operation)
        record[f"{stage}_operation_id"] = operation["operation_id"]
        self._stage(record, f"generating_{stage}")

    async def _poll(self, record: dict, stage: str, client) -> dict:
        path = self._directory(record["id"]) / f"{stage}_operation.json"
        operation = _read_json(path) if path.exists() else {"done": False}
        failures = 0
        while not operation.get("done"):
            await asyncio.sleep(self._poll_s)
            try:
                operation = await client.operation(record[f"{stage}_operation_id"])
                failures = 0
            except MarbleError as exc:
                failures += 1
                if not exc.retryable or failures >= 3:
                    raise
                continue
            _write_json(path, operation)
        cost = operation.get("cost") or {}
        amount = cost.get("total_credits") if isinstance(cost, dict) else None
        record["cost_credits"][stage] = amount if _finite_number(amount) and amount >= 0 else None
        submitted = record["stage_times"].get(f"submitting_{stage}")
        if submitted is not None:
            record["timing_s"].setdefault(f"{stage}_generation_observed", time.time() - submitted)
        record[f"{stage}_complete"] = operation.get("error") is None
        self._save(record)
        if operation.get("error") is not None:
            raise MarbleError("Marble generation failed", code="operation_failed")
        return operation

    async def _ensure_operation(self, record: dict, stage: str, client, directory: Path) -> dict:
        # Keep the lock through completion so separate jobs cannot overlap paid
        # stages or preflight against a balance before an earlier stage settles.
        async with _file_lock(self.root_dir / ".paid.lock"):
            if not record.get(f"{stage}_operation_id"):
                if record.get("generation_calls", {}).get(stage, 0):
                    raise SubmissionUnknown()
                await self._submit(record, stage, client, directory)
            self._stage(record, f"generating_{stage}")
            return await self._poll(record, stage, client)

    async def _submit(self, record: dict, stage: str, client, directory: Path) -> None:
        balance = (await client.credits())["remaining_credits"]
        record[f"credits_before_{stage}"] = balance
        # Depth-to-RGB has no explicit tariff in the public pricing table.
        # This checks the known Draft requirement, not a guaranteed total cap.
        if balance < 150 or stage == "depth" and balance == 150:
            raise MarbleError("Insufficient Marble credits", code="insufficient_credits")
        self._stage(record, f"submitting_{stage}")
        record["generation_calls"][stage] += 1
        self._save(record)
        if stage == "depth":
            bounds = record["depth_metadata"]
            operation = await client.generate_depth(
                (directory / "depth.png").read_bytes(), record["prompt"],
                z_min=bounds["z_min"], z_max=bounds["z_max"],
            )
        else:
            appearance_prompt = record["prompt"].replace(
                "Use the supplied full spherical depth panorama as a coarse layout reference.",
                "Use the supplied full spherical historical RGB panorama as the appearance and layout reference.",
            )[:2000]
            operation = await client.generate_image(
                (directory / "historical_panorama.jpg").read_bytes(), appearance_prompt,
                f"CenturyPano imagined {record['year']}", model=record["model"], is_pano=True,
            )
        self._accept(record, stage, operation)

    async def _run(self, job_id: str) -> None:
        directory = self._directory(job_id)
        async with _file_lock(directory / ".job.lock", wait=False) as acquired:
            if not acquired:
                return
            record = _read_json(directory / "record.json")
            if record["stage"] in _TERMINAL:
                return
            client = None
            try:
                for stage in ("depth", "world"):
                    if record["stage"] == f"submitting_{stage}" and not record.get(f"{stage}_operation_id"):
                        receipt = directory / f"{stage}_operation.json"
                        if not receipt.exists():
                            raise SubmissionUnknown()
                        self._accept(record, stage, _read_json(receipt))
                plan = _read_json(directory / "plan.json")
                client = self._client_factory()
                await self._render(record, plan, directory)
                depth_operation = await self._ensure_operation(record, "depth", client, directory)
                if not record.get("pano_ready"):
                    self._stage(record, "fetching_pano")
                    response = depth_operation.get("response")
                    pano_url = response.get("pano_url") if isinstance(response, dict) else None
                    # The live API also returns a World-shaped result for pano
                    # operations, despite the documented flat PanoDepthToRgbResult.
                    if not pano_url and isinstance(response, dict):
                        assets = response.get("assets")
                        imagery = assets.get("imagery") if isinstance(assets, dict) else None
                        pano_url = imagery.get("pano_url") if isinstance(imagery, dict) else None
                    if not isinstance(pano_url, str):
                        raise AssetError("missing_panorama", "Completed depth generation has no panorama.")
                    pano = await self._pano_downloader(pano_url, directory)
                    # Even injected downloaders must provide a complete spherical JPEG.
                    prepared = await asyncio.to_thread(_pano_jpeg, Path(pano))
                    _atomic_bytes(directory / "historical_panorama.jpg", prepared)
                    checked = await asyncio.to_thread(inspect_image, directory / "historical_panorama.jpg")
                    self._asset(record, directory / "historical_panorama.jpg", "historical_pano", "image/jpeg",
                                validation=checked)
                    record["pano_ready"] = True
                    self._stage(record, "pano_ready")
                    await asyncio.sleep(0)
                operation = await self._ensure_operation(record, "world", client, directory)
                response = operation.get("response") or {}
                if isinstance(response, dict) and isinstance(response.get("world"), dict):
                    response = response["world"]
                metadata = operation.get("metadata") or {}
                world_id = (response.get("world_id") or response.get("id")) if isinstance(response, dict) else None
                if not world_id and isinstance(metadata, dict):
                    world_id = metadata.get("world_id")
                if not _valid_id(world_id):
                    raise AssetError("missing_world_id", "Completed world generation has no world ID.")
                record["world_id"] = world_id
                self._stage(record, "fetching_assets")
                world = await client.world(world_id)
                _write_json(directory / "world.json", world)
                assets = await self._asset_downloader(world, directory / "assets")
                for item in assets:
                    extras = {key: item[key] for key in ("validation", "lod", "semantics_metadata", "semantics_status")
                              if key in item}
                    self._asset(record, Path(item["path"]), item["kind"], item.get("media_type", "application/octet-stream"),
                                **extras)
                if not any(item["kind"] == "spz" for item in record["assets"]):
                    raise AssetError("missing_spz", "No SPZ asset is available for the completed world.")
                record["timing_s"]["total_to_assets"] = time.time() - record["created_at"]
                self._stage(record, "ready")
                try:
                    record["credits_after"] = (await client.credits())["remaining_credits"]
                    self._save(record)
                except MarbleError:
                    pass
            except asyncio.CancelledError:
                self._failure(record, None)
                raise
            except Exception as exc:
                self._failure(record, exc)
            finally:
                if client is not None:
                    await client.aclose()

    def _failure(self, record: dict, exc: Exception | None) -> None:
        previous = record["stage"]
        uncertain = isinstance(exc, SubmissionUnknown) or previous.startswith("submitting_") and not isinstance(exc, MarbleError)
        code = exc.code if isinstance(exc, (MarbleError, AssetError)) else "interrupted" if exc is None else "job_failed"
        if uncertain:
            stage, code = "submission_unknown", "submission_unknown"
        elif code == "insufficient_credits":
            stage = "insufficient_credits"
        elif code in {"operation_failed", "invalid_input", "missing_key", "invalid_key", "http_error"} and (
            previous.startswith("submitting_") or code != "http_error"
        ):
            stage = "error"
        else:
            stage = "paused"
        record.update(stage=stage, error_code=code, resume_stage=previous)
        if isinstance(exc, MarbleError) and exc.status_code is not None:
            record["http_status"] = exc.status_code
        self._save(record)
