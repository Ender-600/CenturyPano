"""Durable historical RGB/depth panorama → Marble world jobs.

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
import inspect
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid
from typing import Any

import httpx
from PIL import Image

from .assets import AssetError, _download, _validate_url, download_assets, inspect_image
from .marble import MarbleClient, MarbleError, SubmissionUnknown, _finite_number, _valid_id
from .panorama import (HistoricalPanoramaEditor, PanoramaEditError, PanoramaSubmissionUnknown,
                       _image_size, _safe_usage, panorama_prompt, _PROJECTION_INSTRUCTIONS)
from .paid_queue import paid_queue
from .profiles import DEFAULT_WORLD_MODEL, world_credits


_JOB_ID = re.compile(r"[0-9a-f]{32}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_EDITOR_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\Z")
_TERMINAL = {"ready", "error", "submission_unknown", "insufficient_credits", "cancelled", "expired"}
PANORAMA_PREFETCH_TTL_S = 180
PANORAMA_PREFETCH_MAX_TTL_S = 300
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
    if plan.get("input_kind") == "streetview_panorama":
        source = plan.get("source_panorama", {})
        metadata = source.get("metadata", {})
        content = {key: plan[key] for key in (
            "input_kind", "target_year", "history_context", "changes", "sources", "uncertainties",
            "generation_profile", "panorama_editor",
        ) if key in plan}
        content["source_panorama"] = {"sha256": source.get("sha256"), "capture": {
            key: metadata[key] for key in ("pano_id", "lat", "lon", "heading", "date") if key in metadata}}
        content["image_request_hash"] = _panorama_hash(plan)
    else:
        content = {key: plan[key] for key in _GENERATION_FIELDS if key in plan}
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _panorama_hash(plan: dict) -> str:
    """Only immutable input and the complete effective image request identify a cache entry."""
    source = plan["source_panorama"]
    metadata = source["metadata"]
    content = {"sha256": source["sha256"], "capture": {
        key: metadata[key] for key in ("pano_id", "lat", "lon", "heading", "date") if key in metadata},
        "year": plan["target_year"], "editor": plan["panorama_editor"],
        "prompt": panorama_prompt(plan), "projection": _PROJECTION_INSTRUCTIONS}
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _freeze_plan(plan: dict, *, panorama_only: bool = False) -> dict:
    try:
        frozen = json.loads(json.dumps(plan, sort_keys=True, separators=(",", ":"), allow_nan=False))
        if (not isinstance(frozen, dict) or type(frozen.get("target_year")) is not int
                or not 1 <= frozen["target_year"] <= 2100
                or not isinstance(frozen.get("historical_buildings"), list)
                or not isinstance(frozen.get("camera_position"), (list, dict))
                or panorama_only and frozen.get("input_kind") != "streetview_panorama"):
            raise ValueError
        if frozen.get("input_kind") == "streetview_panorama":
            source, profile = frozen.get("source_panorama"), frozen.get("panorama_editor")
            if (str(uuid.UUID(frozen.get("plan_id", ""))) != frozen["plan_id"]
                    or not isinstance(source, dict) or source.get("filename") != "source_panorama.jpg"
                    or not isinstance(source.get("sha256"), str) or not _SHA256.fullmatch(source["sha256"])
                    or not isinstance(source.get("metadata"), dict)
                    or not isinstance(profile, dict) or not isinstance(profile.get("model"), str)
                    or not _EDITOR_MODEL.fullmatch(profile["model"])
                    or profile.get("quality") not in {"low", "medium", "high", "xhigh", "max", "auto"}):
                raise ValueError
        return frozen
    except (ValueError, TypeError, AttributeError, UnicodeError):
        raise ValueError("Invalid frozen historical world plan") from None


class _PanoramaDiscarded(Exception):
    def __init__(self, stage):
        self.stage = stage


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
        asset_downloader=None, pano_downloader=None, renderer=None, panorama_editor_factory=None, source_loader=None,
    ) -> None:
        self.root_dir = Path(root_dir).resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._api_key = api_key
        self._client_factory = client_factory or (lambda: MarbleClient(api_key))
        self._asset_downloader = asset_downloader or download_assets
        self._pano_downloader = pano_downloader or _download_pano
        self._renderer = renderer or _geometry_renderer
        self._panorama_editor_factory = panorama_editor_factory
        self._source_loader = source_loader
        self._source_root = (self.root_dir.parent / "plans").resolve()
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
        path = self._directory(record["id"]) / "record.json"
        if record.get("kind") == "panorama" and path.is_file():
            stored = _read_json(path)
            if stored.get("updated_at", 0) > record.get("updated_at", 0):
                record.update(speculative=stored.get("speculative"), expires_at=stored.get("expires_at"))
            if stored.get("speculative") is False and stored.get("stage") not in {"cancelled", "expired"}:
                record.update(speculative=False, expires_at=None)
            discard = path.parent / "discard.json"
            if discard.is_file() and not self._image_attempted(record):
                record["stage"] = _read_json(discard)["stage"]
        record["updated_at"] = time.time()
        _write_json(path, record)

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
            def completed(task):
                paid_queue(self.root_dir).release((id(self), job_id))
                if not task.cancelled():
                    task.exception()
            task.add_done_callback(completed)

    async def start(self, plan: dict, model: str = DEFAULT_WORLD_MODEL) -> dict:
        if self._closed:
            raise ValueError("World job manager is closed")
        if not isinstance(self._api_key, str) or not self._api_key.strip():
            raise MarbleError("WORLDLAB_API_KEY is not configured", code="missing_key")
        world_credits(model)
        frozen = _freeze_plan(plan)
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
                    except (OSError, ValueError, TypeError, AttributeError):
                        continue
            if not (directory / "record.json").exists():
                directory.mkdir(exist_ok=True, mode=0o700)
                _write_json(directory / "plan.json", frozen)
                self._save({
                    "schema_version": 1, "id": job_id, "plan_hash": plan_hash,
                    **({"plan_id": frozen["plan_id"]} if _valid_id(frozen.get("plan_id")) else {}),
                    "model": model, "year": frozen["target_year"],
                    "prompt": ("Reconstruct the supplied full spherical historical RGB panorama as a coherent "
                               "three-dimensional world. Preserve the already edited scene, camera origin, "
                               "architecture, materials and layout; do not restyle it or return modern objects. "
                               "Maintain a continuous 360 by 180 degree environment."
                               if frozen.get("input_kind") == "streetview_panorama" else _prompt(frozen)),
                    **({"input_kind": "streetview_panorama"} if frozen.get("input_kind") == "streetview_panorama" else {}),
                    "stage": "queued", "created_at": time.time(), "stage_times": {},
                    "timing_s": {}, "generation_calls": ({"image_edit": 0, "world": 0}
                        if frozen.get("input_kind") == "streetview_panorama" else {"depth": 0, "world": 0}),
                    "cost_credits": {"depth": None, "world": None}, "assets": [],
                })
        record = _read_json(directory / "record.json")
        if record["stage"] not in _TERMINAL:
            if frozen.get("input_kind") == "streetview_panorama":
                paid_queue(self.root_dir).promote((id(self), job_id), _panorama_hash(frozen))
            self._schedule(job_id)
        return self.get(job_id)

    async def start_panorama(self, plan: dict, *, speculative: bool = True, expires_at=None) -> dict:
        """Prepare only the historical JPEG. No Marble client, key or credits are needed."""
        if self._closed:
            raise ValueError("World job manager is closed")
        if type(speculative) is not bool:
            raise ValueError("Invalid panorama priority")
        now = time.time()
        if expires_at is not None and (not _finite_number(expires_at) or expires_at <= 0):
            raise ValueError("Invalid panorama expiry")
        deadline = min(expires_at or now + PANORAMA_PREFETCH_TTL_S,
                       now + PANORAMA_PREFETCH_MAX_TTL_S) if speculative else None
        frozen = _freeze_plan(plan, panorama_only=True)
        image_key = _panorama_hash(frozen)
        job_id = hashlib.sha256((image_key + ":panorama").encode()).hexdigest()[:32]
        directory = self._directory(job_id)
        async with _file_lock(self.root_dir / ".creation.lock"):
            if not (directory / "record.json").exists():
                directory.mkdir(exist_ok=True, mode=0o700)
                _write_json(directory / "plan.json", frozen)
                self._save({"schema_version": 1, "id": job_id, "plan_id": frozen["plan_id"],
                    "kind": "panorama", "plan_hash": _generation_hash(frozen), "image_key": image_key,
                    "input_kind": "streetview_panorama", "model": frozen["panorama_editor"]["model"],
                    "year": frozen["target_year"], "speculative": speculative, "expires_at": deadline,
                    "stage": "queued", "created_at": now, "stage_times": {}, "timing_s": {},
                    "generation_calls": {"image_edit": 0, "world": 0}, "cost_credits": {}, "assets": []})
            record = _read_json(directory / "record.json")
            if record["stage"] in {"cancelled", "expired"} and not self._image_attempted(record):
                # A new visit renews an unsubmitted prediction. An old worker
                # reads this renewed lease before spending, even if it is still
                # unwinding the previously discarded queue ticket.
                (directory / "discard.json").unlink(missing_ok=True)
                record.update(speculative=speculative, expires_at=deadline)
                self._stage(record, "queued")
            if not speculative:
                record.update(speculative=False, expires_at=None)
                self._save(record)
            elif record["stage"] not in _TERMINAL and record.get("speculative"):
                record["expires_at"] = deadline
                self._save(record)
            # Predictions have one provider execution plus at most one pending
            # location across managers sharing this directory. Replace stale
            # queued guesses, never interrupt an accepted image request.
            if speculative and record["stage"] not in _TERMINAL:
                for path in self.root_dir.glob("*/record.json"):
                    try:
                        previous = _read_json(path)
                    except (OSError, ValueError):
                        continue
                    if (previous.get("id") != job_id and previous.get("kind") == "panorama"
                            and previous.get("speculative") and previous.get("stage") not in _TERMINAL
                            and not self._image_attempted(previous)
                            and previous.get("image_key") not in paid_queue(self.root_dir).foreground_images):
                        self._discard_panorama(previous, "cancelled")
        if record["stage"] not in _TERMINAL:
            if not speculative:
                paid_queue(self.root_dir).promote((id(self), job_id), image_key)
            self._schedule(job_id)
        return self.get(job_id)

    @staticmethod
    def _image_attempted(record: dict) -> bool:
        return bool(record.get("image_edit_attempted") or record.get("generation_calls", {}).get("image_edit"))

    def _discard_panorama(self, record: dict, stage: str) -> None:
        _write_json(self._directory(record["id"]) / "discard.json", {"stage": stage})
        self._stage(record, stage)

    async def cancel_panorama(self, job_id: str) -> dict:
        directory = self._directory(job_id)
        async with _file_lock(self.root_dir / ".creation.lock"):
            if not (directory / "record.json").is_file():
                raise MarbleError("World job was not found", code="job_not_found")
            record = _read_json(directory / "record.json")
            if record.get("kind") != "panorama":
                raise MarbleError("Only panorama jobs can be cancelled", code="cancel_not_allowed")
            if record["stage"] not in _TERMINAL and not self._image_attempted(record):
                self._discard_panorama(record, "cancelled")
        return self.get(job_id)

    def _check_panorama_interest(self, record: dict) -> None:
        if record.get("kind") != "panorama" or self._image_attempted(record) or record.get("pano_ready"):
            return
        directory = self._directory(record["id"])
        if (directory / "discard.json").is_file():
            raise _PanoramaDiscarded(_read_json(directory / "discard.json")["stage"])
        current = _read_json(directory / "record.json")
        if (current.get("speculative") and current.get("image_key") not in paid_queue(self.root_dir).foreground_images
                and current.get("expires_at", float("inf")) <= time.time()):
            raise _PanoramaDiscarded("expired")

    @asynccontextmanager
    async def _paid_slot(self, record: dict):
        queue = paid_queue(self.root_dir)
        def priority():
            return int(bool(record.get("speculative")) and record.get("image_key") not in queue.foreground_images)
        while True:
            async with queue.slot(priority, lambda: self._check_panorama_interest(record)):
                async with _file_lock(self.root_dir / ".paid.lock", wait=False) as acquired:
                    if acquired:
                        self._check_panorama_interest(record)
                        yield
                        return
            await asyncio.sleep(.05)

    def get(self, job_id: str) -> dict | None:
        path = self._directory(job_id) / "record.json"
        if not path.is_file():
            return None
        record = _read_json(path)
        result = {key: record[key] for key in (
            "id", "plan_id", "model", "year", "stage", "created_at", "updated_at", "timing_s",
            "generation_calls", "error_code", "http_status", "credits_before_depth",
            "credits_before_world", "credits_after", "input_kind", "credits_before_image_edit", "image_edit_model",
            "kind", "speculative", "expires_at", "image_edit_reused_from",
        ) if key in record}
        result.update(job_id=record["id"], status=record["stage"], can_resume=self._can_resume(record))
        if record.get("kind") == "panorama":
            result["can_cancel"] = record["stage"] not in _TERMINAL and not self._image_attempted(record)
        costs = {name: record.get("cost_credits", {}).get(name) for name in ("depth", "world")}
        known = [value for value in costs.values() if _finite_number(value) and value >= 0]
        costs["known_total"] = sum(known)
        costs["total"] = sum(known) if len(known) == (1 if record.get("input_kind") == "streetview_panorama" else 2) else None
        if record.get("kind") == "panorama":
            costs["total"] = 0
        if record.get("input_kind") == "streetview_panorama":
            result["image_edit_usage"] = _safe_usage(record.get("image_edit_usage"))
            result["image_edit_billing"] = {"provider": "openai", "included_in_worldlabs_credits": False,
                                            "amount": None, "currency": None}
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
            "historical_accuracy": "unverified", "geometry": ("generated_from_rgb_unverified"
                if record.get("input_kind") == "streetview_panorama" else "coarse_reference"),
            "gpu_rendering": "unverified", "phone_6dof": "unverified", "coordinate_alignment": "unverified",
        }
        review = record.get('review')
        if isinstance(review, dict) and review.get('status') == 'rejected':
            result['review'] = {key: review[key] for key in ('status', 'scope', 'notes', 'reviewed_at') if key in review}
            result['validation']['historical_accuracy'] = 'failed_visual_review'
        return result

    def _can_resume(self, record: dict) -> bool:
        if record.get("stage") not in {"paused", "error"} or record.get("error_code") in {
            "submission_unknown", "operation_failed", "insufficient_credits",
        }:
            return False
        image_receipt = False
        if (self._image_attempted(record) or record.get("image_edit_complete")
                or record.get("image_edit_reused_from")):
            try:
                self._read_image_receipt(self._directory(record["id"]), record)
                image_receipt = True
            except (OSError, ValueError, SubmissionUnknown):
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
            "submitting_image_edit", "editing_panorama",
        } and (image_receipt or any(
            _valid_id(record.get(f"{stage}_operation_id")) for stage in ("depth", "world")))

    async def resume(self, job_id: str) -> dict:
        """Continue safe work; never reset operation IDs, costs, or paid counters."""
        if self._closed:
            raise ValueError("World job manager is closed")
        directory = self._directory(job_id)
        if not (directory / "record.json").is_file():
            raise MarbleError("World job was not found", code="job_not_found")
        async with _file_lock(directory / ".job.lock", wait=False) as acquired:
            if not acquired:
                return self.get(job_id)
            record = _read_json(directory / "record.json")
            if record.get("kind") != "panorama" and (not isinstance(self._api_key, str) or not self._api_key.strip()):
                raise MarbleError("WORLDLAB_API_KEY is not configured", code="missing_key")
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
        queue = paid_queue(self.root_dir)
        for owner in list(queue.promotions):
            if owner[0] == id(self):
                queue.release(owner)

    def _asset(self, record: dict, path: Path, kind: str, media_type: str, **extra) -> None:
        directory = self._directory(record["id"])
        relative = path.resolve().relative_to(directory)
        if not _FILENAME.fullmatch(path.name):
            raise AssetError("invalid_asset_metadata", "Asset filename is not supported.")
        data = path.read_bytes()
        item = {"kind": kind, "filename": path.name, "relative_path": relative.as_posix(),
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "media_type": media_type, **extra}
        record["assets"] = [old for old in record["assets"] if old["filename"] != item["filename"]] + [item]

    def _read_image_receipt(self, directory: Path, record: dict) -> dict:
        """A receipt is usable only while its complete validated JPEG still exists."""
        try:
            receipt = _read_json(directory / "image_edit_receipt.json")
            image_path = directory / "historical_panorama.jpg"
            expected = receipt.get("sha256")
            if (receipt.get("filename") != image_path.name or not isinstance(expected, str)
                    or not _SHA256.fullmatch(expected) or not image_path.is_file()
                    or image_path.stat().st_size > 10 * 1024 * 1024
                    or hashlib.sha256(image_path.read_bytes()).hexdigest() != expected
                    or not isinstance(receipt.get("model"), str) or not _EDITOR_MODEL.fullmatch(receipt["model"])
                    or not _finite_number(receipt.get("completed_at")) or receipt["completed_at"] <= 0):
                raise ValueError
            return receipt
        except (OSError, ValueError, TypeError):
            raise SubmissionUnknown() from None

    async def _photo_source(self, record: dict, plan: dict, directory: Path) -> bytes:
        target = directory / "source_panorama.jpg"
        if record.get("source_ready") and target.is_file():
            data = await asyncio.to_thread(target.read_bytes)
        elif self._source_loader:
            data = self._source_loader(plan)
            if inspect.isawaitable(data):
                data = await data
        else:
            # The plan itself was created by the server. Still reject path-like
            # IDs, mutable filenames and symlinks escaping its private root.
            plan_id = str(uuid.UUID(plan["plan_id"]))
            source_directory = (self._source_root / plan_id).resolve()
            source_path = (source_directory / "source_panorama.jpg").resolve()
            if (not source_directory.is_relative_to(self._source_root)
                    or not source_path.is_relative_to(source_directory)):
                raise AssetError("invalid_source_path", "The stored panorama path is invalid.")
            if source_path.stat().st_size > 10 * 1024 * 1024:
                raise AssetError("invalid_source_image", "The source panorama exceeds its size limit.")
            data = await asyncio.to_thread(source_path.read_bytes)
        if (not isinstance(data, bytes) or hashlib.sha256(data).hexdigest() != plan["source_panorama"]["sha256"]):
            raise AssetError("source_hash_mismatch", "The source panorama no longer matches its frozen plan.")
        await asyncio.to_thread(_image_size, data)
        if not record.get("source_ready"):
            _atomic_bytes(target, data)
            self._asset(record, target, "source_pano", "image/jpeg")
            record["source_ready"] = True
            self._save(record)
        return data

    def _cached_photo(self, record: dict, image_key: str):
        matches = []
        for path in self.root_dir.glob("*/record.json"):
            try:
                other = _read_json(path)
                if (other.get("id") == record["id"] or other.get("input_kind") != "streetview_panorama"
                        or not _JOB_ID.fullmatch(other.get("id", ""))):
                    continue
                key = other.get("image_key") or _panorama_hash(_read_json(path.parent / "plan.json"))
                if key == image_key and (self._image_attempted(other) or (path.parent / "image_edit_receipt.json").is_file()):
                    matches.append((other, path.parent))
            except (OSError, ValueError, TypeError, KeyError):
                continue
        # Prefer an existing complete receipt when migrating legacy jobs which
        # could have repeated the same image for different Marble models.
        matches.sort(key=lambda item: not (item[1] / "image_edit_receipt.json").is_file())
        for other, directory in matches:
            if (directory / "image_edit_receipt.json").is_file():
                return other, directory, self._read_image_receipt(directory, other)
            if other.get("stage") == "error" and other.get("error_code") not in {"job_failed", "submission_unknown"}:
                raise PanoramaEditError(other["error_code"], other.get("http_status"))
            # The shared image lock is no longer held by this old job. A paid
            # marker without a receipt is ambiguous, even after process death.
            raise SubmissionUnknown()
        return None

    def _adopt_photo(self, record: dict, directory: Path, cached) -> dict:
        other, cached_directory, receipt = cached
        _atomic_bytes(directory / "historical_panorama.jpg", (cached_directory / receipt["filename"]).read_bytes())
        _write_json(directory / "image_edit_receipt.json", receipt)
        record["image_edit_reused_from"] = other["id"]
        record["timing_s"]["image_edit"] = other.get("timing_s", {}).get("image_edit", max(0,
            receipt["completed_at"] - other["stage_times"].get("submitting_image_edit", other["created_at"])))
        return receipt

    async def _ensure_photo_panorama(self, record: dict, plan: dict, client, directory: Path) -> None:
        image_key = _panorama_hash(plan)
        record["image_key"] = image_key
        async with self._image_slot(record, image_key):
            self._check_panorama_interest(record)
            if self._image_attempted(record) or (directory / "image_edit_receipt.json").exists():
                receipt = self._read_image_receipt(directory, record)
            elif cached := self._cached_photo(record, image_key):
                await self._photo_source(record, plan, directory)
                receipt = self._adopt_photo(record, directory, cached)
            else:
                source = await self._photo_source(record, plan, directory)
                async with self._paid_slot(record):
                    # A worker from before the image-key lock was introduced
                    # may have completed while we waited on the paid file lock.
                    if cached := self._cached_photo(record, image_key):
                        receipt = self._adopt_photo(record, directory, cached)
                    else:
                        receipt = await self._edit_photo(record, plan, client, directory, source)
            record.update(image_edit_complete=True, image_edit_model=receipt["model"],
                          image_edit_usage=_safe_usage(receipt.get("usage")), pano_ready=True)
            record["timing_s"].setdefault("image_edit", max(0, receipt.get("completed_at", time.time())
                - record["stage_times"].get("submitting_image_edit", record["created_at"])))
            checked = await asyncio.to_thread(inspect_image, directory / "historical_panorama.jpg")
            self._asset(record, directory / "historical_panorama.jpg", "historical_pano", "image/jpeg", validation=checked)
            self._stage(record, "pano_ready")
            await asyncio.sleep(0)

    @asynccontextmanager
    async def _image_slot(self, record, image_key):
        while True:
            self._check_panorama_interest(record)
            async with _file_lock(self.root_dir / f".image-{image_key}.lock", wait=False) as acquired:
                if acquired:
                    yield
                    return
            await asyncio.sleep(.05)

    async def _edit_photo(self, record, plan, client, directory, source):
        profile = plan.get("panorama_editor", {})
        editor = (self._panorama_editor_factory() if self._panorama_editor_factory
                  else HistoricalPanoramaEditor(model=profile.get("model"), quality=profile.get("quality")))
        api_key = getattr(editor, "api_key", None)
        if not api_key:
            raise PanoramaEditError("not_configured")
        if not isinstance(api_key, str) or len(api_key) > 4096 or not re.fullmatch(r"[\x21-\x7e]+", api_key):
            raise PanoramaEditError("invalid_configuration")
        prompt = panorama_prompt(plan)
        if client is not None:
            balance = (await client.credits())["remaining_credits"]
            record["credits_before_image_edit"] = balance
            if balance < world_credits(record["model"]):
                raise MarbleError("Insufficient Marble credits", code="insufficient_credits")
        # Serialize the last cancellation/expiry check with the durable paid
        # marker, including other server processes sharing this worktree.
        async with _file_lock(self.root_dir / ".creation.lock"):
            self._check_panorama_interest(record)
            record["generation_calls"]["image_edit"] = 1
            record["image_edit_attempted"] = True
            self._stage(record, "submitting_image_edit")
        result = await editor.edit(source, prompt)
        try:
            image = result["image_bytes"]
            await asyncio.to_thread(_image_size, image, output=True)
            # Saving JPEG preserves angular projection; never resize,
            # crop, rotate, stretch or tile the returned panorama.
            with Image.open(io.BytesIO(image)) as decoded:
                output = io.BytesIO()
                decoded.convert("RGB").save(output, "JPEG", quality=95, subsampling=0)
            prepared = output.getvalue()
            if len(prepared) > 10 * 1024 * 1024:
                raise ValueError
            model = result.get("model")
            if not isinstance(model, str) or not _EDITOR_MODEL.fullmatch(model) or model != profile.get("model"):
                raise ValueError
            receipt = {"filename": "historical_panorama.jpg", "sha256": hashlib.sha256(prepared).hexdigest(),
                       "model": model, "usage": _safe_usage(result.get("usage")), "completed_at": time.time()}
            _atomic_bytes(directory / "historical_panorama.jpg", prepared)
            _write_json(directory / "image_edit_receipt.json", receipt)
        except (ValueError, TypeError, KeyError, OSError, PanoramaEditError):
            raise PanoramaSubmissionUnknown() from None
        return receipt

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
        async with self._paid_slot(record):
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
        # Reserve the selected world's known requirement before upstream work;
        # an accepted older job keeps using its recorded model on resume.
        required = world_credits(record["model"])
        if balance < required or stage == "depth" and balance == required:
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
                if plan.get("input_kind") == "streetview_panorama" and not record.get("speculative"):
                    paid_queue(self.root_dir).promote((id(self), job_id), _panorama_hash(plan))
                self._check_panorama_interest(record)
                if record.get("kind") != "panorama":
                    client = self._client_factory()
                if plan.get("input_kind") == "streetview_panorama":
                    await self._ensure_photo_panorama(record, plan, client, directory)
                    if record.get("kind") == "panorama":
                        record["timing_s"]["total_to_assets"] = time.time() - record["created_at"]
                        self._stage(record, "ready")
                        return
                else:
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
            except _PanoramaDiscarded as exc:
                self._discard_panorama(record, exc.stage)
            except Exception as exc:
                self._failure(record, exc)
            finally:
                if client is not None:
                    await client.aclose()

    def _failure(self, record: dict, exc: Exception | None) -> None:
        previous = record["stage"]
        known_error = isinstance(exc, (MarbleError, PanoramaEditError))
        uncertain = isinstance(exc, (SubmissionUnknown, PanoramaSubmissionUnknown)) or (
            previous.startswith("submitting_") and not known_error)
        if previous == "submitting_image_edit":
            try:
                self._read_image_receipt(self._directory(record["id"]), record)
                uncertain = False
            except SubmissionUnknown:
                pass
        code = exc.code if isinstance(exc, (MarbleError, AssetError, PanoramaEditError)) else (
            "interrupted" if exc is None else "job_failed")
        if uncertain:
            stage, code = "submission_unknown", "submission_unknown"
        elif code == "insufficient_credits":
            stage = "insufficient_credits"
        elif isinstance(exc, PanoramaEditError):
            stage = "error"
        elif code in {"operation_failed", "invalid_input", "missing_key", "invalid_key", "http_error"} and (
            previous.startswith("submitting_") or code != "http_error"
        ):
            stage = "error"
        else:
            stage = "paused"
        record.update(stage=stage, error_code=code, resume_stage=previous)
        if isinstance(exc, (MarbleError, PanoramaEditError)) and exc.status_code is not None:
            record["http_status"] = exc.status_code
        self._save(record)
