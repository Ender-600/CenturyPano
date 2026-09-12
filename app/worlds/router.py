"""Private, single-process historical-block planning and world generation routes."""
from __future__ import annotations

import asyncio
from hashlib import sha256
import json
from pathlib import Path
import re
import secrets
import time
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.constraints import PROMPT_VERSION
from app.temporal import DEFAULT_YEAR, MIN_YEAR, MAX_YEAR
from app.worlds.profiles import DEFAULT_WORLD_MODEL, WORLD_MODELS, WorldModel

router = APIRouter()
_manager = None
_hotspots = None
_plan_lock = asyncio.Lock()
_prefetch_requests: dict[str, asyncio.Task] = {}
_prefetch_preparations: dict[str, asyncio.Task] = {}
_ID = re.compile(r'[a-f0-9-]{36}\Z')
_PLAN_FILES = {'modern.glb', 'historical.glb', 'depth.png', 'depth_preview.png', 'source_panorama.jpg'}


async def startup():
    global _manager, _hotspots
    from app.worlds.jobs import WorldJobManager
    from app.worlds.hotspots import WorldHotspots
    _manager = WorldJobManager(settings.world_dir / 'jobs', settings.worldlab_api_key)
    _hotspots = WorldHotspots(_manager)
    await _manager.resume_all()


async def shutdown():
    global _manager, _hotspots
    pending = set(_prefetch_requests.values()) | set(_prefetch_preparations.values())
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    _prefetch_requests.clear()
    _prefetch_preparations.clear()
    if _hotspots is not None:
        await _hotspots.aclose()
    _hotspots = None
    if _manager is not None:
        await _manager.aclose()
    _manager = None


def manager():
    if _manager is None:
        raise HTTPException(503, 'The world generation service has not started yet.')
    return _manager


async def require_access(request: Request):
    supplied = request.headers.get('authorization', '')
    if not secrets.compare_digest(supplied.encode(), ('Bearer ' + settings.world_access_token).encode()):
        raise HTTPException(401, 'Please connect to the generation service. Remote access requires a separate access code.')
    if request.method in ('POST', 'PATCH'):
        # Bound the actual body, including requests without Content-Length.
        if len(await request.body()) > 256 * 1024:
            raise HTTPException(413, 'The world plan request is too large.')


@router.get('/world-config')
async def configuration():
    return {'configured': bool(settings.worldlab_api_key), 'model': DEFAULT_WORLD_MODEL,
            'models': list(WORLD_MODELS.values()),
            'min_year': MIN_YEAR, 'max_year': MAX_YEAR, 'default_year': DEFAULT_YEAR,
            'test_location': {'lat': 40.4433, 'lon': -79.9436, 'radius_m': 100},
            'default_source': 'google_streetview', 'default_location_source': 'device',
            'streetview': {'configured': bool(settings.google_maps_api_key),
                           'ai_authorized': settings.google_streetview_ai_authorized,
                           'available': bool(settings.google_maps_api_key) and settings.google_streetview_ai_authorized},
            'panorama_editor_configured': bool(settings.openai_api_key),
            'prefetch': {'available': bool(settings.google_maps_api_key and settings.openai_api_key)
                                     and settings.google_streetview_ai_authorized,
                         'max_accuracy_m': 35, 'min_speed_mps': .4, 'max_speed_mps': 3.5,
                         'min_lookahead_m': 30, 'max_lookahead_m': 150},
            'historical_accuracy': 'unverified', 'phone_ar': False}


@router.get('/world-session')
async def local_session(request: Request):
    origin = request.headers.get('origin')
    local = request.client and request.client.host in ('127.0.0.1', '::1', 'testclient')
    local_host = request.url.hostname in ('localhost', '127.0.0.1', '::1', 'testserver')
    if (not local or not local_host or request.headers.get('sec-fetch-site') == 'cross-site'
            or origin and origin.rstrip('/') != str(request.base_url).rstrip('/')):
        raise HTTPException(403, 'Remote access requires a separate access code.')
    return JSONResponse({'access_token': settings.world_access_token}, headers={'Cache-Control': 'no-store'})


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    lat: float = Field(ge=-85, le=85, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    year: int = Field(ge=MIN_YEAR, le=MAX_YEAR, strict=True)
    radius_m: int = Field(default=100, ge=50, le=150, strict=True)
    source: Literal['google_streetview', 'osm', 'cmu_snapshot'] = 'google_streetview'
    location_source: Literal['device', 'test'] = 'device'
    location_accuracy_m: float | None = Field(default=None, ge=0, le=100000, allow_inf_nan=False)
    location_timestamp_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    heading_deg: float = Field(default=0, ge=0, lt=360, allow_inf_nan=False)


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    plan_id: str
    model: WorldModel = DEFAULT_WORLD_MODEL
    kind: Literal['world', 'panorama'] = 'world'


class PrefetchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    plan_id: str
    lat: float = Field(ge=-85, le=85, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    location_accuracy_m: float = Field(ge=0, le=35, allow_inf_nan=False)
    location_timestamp_ms: float = Field(ge=0, allow_inf_nan=False)
    heading_deg: float = Field(ge=0, lt=360, allow_inf_nan=False)
    speed_mps: float = Field(ge=.4, le=3.5, allow_inf_nan=False)
    lookahead_m: float = Field(default=55, ge=30, le=150, allow_inf_nan=False)


class EditsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    edits: list[dict] = Field(min_length=1, max_length=20)


def plan_dir(plan_id: str) -> Path:
    if not _ID.fullmatch(plan_id):
        raise HTTPException(404, 'World plan not found.')
    return settings.world_dir / 'plans' / plan_id


def _read_plan(plan_id: str) -> dict:
    try:
        return json.loads((plan_dir(plan_id) / 'plan.json').read_text())
    except (OSError, ValueError):
        raise HTTPException(404, 'World plan not found.') from None


def _atomic_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.json.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2))
    temp.replace(path)


def _materialize(plan: dict, directory: Path) -> dict:
    from app.worlds.geometry import render_depth
    options = {'camera_position': plan.get('camera_position', [0, 1.6, 0]),
               'heading_deg': plan.get('heading_deg', 0)}
    historic = render_depth(plan['historical_buildings'], **options)
    modern = render_depth(plan['modern_buildings'], **options)
    directory.mkdir(parents=True, exist_ok=False)
    for name, contents in {'modern.glb': modern['mesh_glb'], 'historical.glb': historic['mesh_glb'],
                           'depth.png': historic['depth_png'], 'depth_preview.png': historic['preview_png']}.items():
        (directory / name).write_bytes(contents)
    plan['geometry'] = historic['metadata']
    plan['assets'] = {name: f'/world-plans/{plan["plan_id"]}/assets/{name}' for name in _PLAN_FILES if (directory / name).is_file()}
    _atomic_json(directory / 'plan.json', plan)
    return plan


def _validate_location(payload: PlanRequest):
    if payload.location_source == 'device':
        if payload.location_timestamp_ms is None or payload.location_accuracy_m is None:
            raise HTTPException(422, 'Allow location access and retrieve your current phone location. Switch to test mode to use a test location.')
        age_ms = time.time() * 1000 - payload.location_timestamp_ms
        if not -30000 <= age_ms <= 120000:
            raise HTTPException(422, 'The location has expired. Retrieve your current phone location again.')
    if payload.source in ('osm', 'cmu_snapshot') and payload.location_source != 'test':
        raise HTTPException(422, 'Rough building models are available only in test mode. The main experience uses Street View 360° panoramas.')


def _location_provenance(payload: PlanRequest) -> dict:
    return {'lat': payload.lat, 'lon': payload.lon, 'radius_m': payload.radius_m,
            'coordinate_provenance': 'browser_geolocation' if payload.location_source == 'device' else 'explicit_test_point',
            'location_source': payload.location_source, 'accuracy_m': payload.location_accuracy_m,
            'timestamp_ms': payload.location_timestamp_ms, 'verification': 'client_reported_not_attested'}


async def _prepare_streetview(payload: PlanRequest, plan_id: str, *, source: dict | None = None,
                              prediction: dict | None = None) -> dict:
    from app.worlds.streetview import GoogleStreetViewClient
    from app.worlds.photo_history import photo_history
    if source is None:
        async with GoogleStreetViewClient(settings.google_maps_api_key,
                                        ai_authorized=settings.google_streetview_ai_authorized) as client:
            source = await client.fetch_panorama(payload.lat, payload.lon, radius_m=payload.radius_m)
    metadata = source['metadata']
    history = await photo_history(metadata['lat'], metadata['lon'], payload.year)
    plan = {**history, 'plan_id': plan_id, 'input_kind': 'streetview_panorama', 'source': 'google_streetview',
            'location': _location_provenance(payload), 'target_year': payload.year,
            'created_at': time.time(), 'generation_profile': 'streetview-rgb-history-v1',
            'panorama_editor': {'model': settings.world_openai_image_model, 'quality': settings.openai_image_quality},
            'modern_buildings': [], 'historical_buildings': [], 'camera_position': [0, 0, 0],
            'camera_location': {'lat': metadata['lat'], 'lon': metadata['lon'], 'source': 'streetview_capture'},
            'heading_deg': metadata.get('heading', 0), 'coordinate_frame': 'panorama_camera_relative_unverified',
            'source_panorama': {'filename': 'source_panorama.jpg', 'sha256': sha256(source['image_bytes']).hexdigest(),
                                'metadata': metadata},
            'attribution': metadata.get('copyright', 'Google Street View'),
            'status': 'needs_review', 'historical_geometry_verified': False}
    if prediction is not None:
        plan['prediction'] = prediction
        plan['parent_plan_id'] = prediction['from_plan_id']
        plan['location'] = {'lat': metadata['lat'], 'lon': metadata['lon'], 'radius_m': payload.radius_m,
                            'coordinate_provenance': 'predicted_streetview_link',
                            'location_source': 'prediction', 'verification': 'prediction_not_device_fix'}
    directory = plan_dir(plan_id)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'source_panorama.jpg').write_bytes(source['image_bytes'])
    plan['assets'] = {'source_panorama.jpg': f'/world-plans/{plan_id}/assets/source_panorama.jpg'}
    _atomic_json(directory / 'plan.json', plan)
    return plan


async def _shared_prefetch(tasks: dict, key: str, factory):
    """Coalesce identical preparation without ever taking the foreground plan lock."""
    task = tasks.get(key)
    if task is None:
        task = asyncio.create_task(factory())
        tasks[key] = task
        def finished(done):
            if tasks.get(key) is done:
                tasks.pop(key, None)
            if not done.cancelled():
                done.exception()  # Retrieve errors even if the requesting browser disconnected.
        task.add_done_callback(finished)
    return await asyncio.shield(task)


async def _prepare_prefetch(payload: PrefetchRequest, current: dict) -> dict:
    from app.worlds.streetview import GoogleStreetViewClient, StreetViewError
    async with GoogleStreetViewClient(settings.google_maps_api_key,
                                    ai_authorized=settings.google_streetview_ai_authorized) as client:
        try:
            selection = await client.select_forward_panorama(payload.lat, payload.lon,
                heading_deg=payload.heading_deg, lookahead_m=payload.lookahead_m,
                current_pano_id=current.get('source_panorama', {}).get('metadata', {}).get('pano_id'))
        except StreetViewError as exc:
            if exc.code == 'no_coverage':
                return {'status': 'skipped', 'reason': 'no_coverage'}
            raise
        if selection.get('status') == 'skipped':
            return selection
        metadata = selection['metadata']
        prediction = {'from_plan_id': current['plan_id'], 'method': 'streetview_links_heading_v1',
            'origin': {'lat': payload.lat, 'lon': payload.lon, 'accuracy_m': payload.location_accuracy_m,
                       'timestamp_ms': payload.location_timestamp_ms, 'coordinate_provenance': 'browser_geolocation',
                       'verification': 'client_reported_not_attested'},
            'heading_deg': payload.heading_deg, 'speed_mps': payload.speed_mps,
            'lookahead_m': payload.lookahead_m, 'distance_m': selection['distance_m'],
            'path': selection['path'], 'created_at': time.time()}
        # Reuse a complete frozen plan. GPS jitter/timestamps are deliberately
        # absent; source version, year, and editor configuration are not.
        identity = {'source': 'google_streetview', 'target_year': current['target_year'],
                    'source_version': {key: metadata.get(key) for key in
                        ('pano_id', 'date', 'lat', 'lon', 'source_image_width', 'source_image_height',
                         'heading', 'tilt', 'roll')},
                    'profile': 'streetview-rgb-history-v1', 'history_prompt_version': PROMPT_VERSION,
                    'editor': {'model': settings.world_openai_image_model, 'quality': settings.openai_image_quality}}
        key = sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        index = settings.world_dir / 'prefetch-index' / f'{key}.json'
        async def prepare():
            try:
                cached = json.loads(index.read_text())
                if time.time() - cached['created_at'] < 3600:
                    return _read_plan(cached['plan_id'])
            except (OSError, ValueError, KeyError, HTTPException):
                pass
            source = await client.fetch_panorama_by_id(metadata['pano_id'], lat=metadata['lat'], lon=metadata['lon'])
            origin = PlanRequest(lat=payload.lat, lon=payload.lon, year=current['target_year'],
                location_accuracy_m=payload.location_accuracy_m, location_timestamp_ms=payload.location_timestamp_ms)
            plan = await _prepare_streetview(origin, str(uuid.uuid4()), source=source, prediction=prediction)
            _atomic_json(index, {'plan_id': plan['plan_id'], 'created_at': time.time()})
            return plan
        plan = await _shared_prefetch(_prefetch_preparations, key, prepare)
    job = await manager().start_panorama(plan, speculative=True, expires_at=time.time() + 180)
    return {'plan': plan, 'job': job, 'prediction': prediction}


@router.post('/world-prefetch', dependencies=[Depends(require_access)])
async def prefetch_panorama(payload: PrefetchRequest):
    if not -5000 <= time.time() * 1000 - payload.location_timestamp_ms <= 30000:
        raise HTTPException(422, 'Walking prediction requires a location fix from the last 30 seconds.')
    current = _read_plan(payload.plan_id)
    if current.get('input_kind') != 'streetview_panorama' or current.get('source') != 'google_streetview':
        raise HTTPException(422, 'Walking prediction requires a Street View panorama plan.')
    if not (settings.google_maps_api_key and settings.google_streetview_ai_authorized and settings.openai_api_key):
        raise HTTPException(503, 'Street View panorama generation is not configured.')
    # Concurrent identical fixes share even the metadata walk. Completed requests
    # may recheck live adjacency, but reuse the target plan and its generated job.
    values = payload.model_dump(exclude={'location_timestamp_ms', 'location_accuracy_m'})
    key = sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    try:
        result = await _shared_prefetch(_prefetch_requests, key, lambda: _prepare_prefetch(payload, current))
        return JSONResponse(result, headers={'Cache-Control': 'no-store'})
    except HTTPException:
        raise
    except Exception as exc:
        code = getattr(exc, 'code', 'prefetch_unavailable')
        raise HTTPException(502, f'Unable to prepare the next panorama ({code}).') from None


@router.post('/world-plans', dependencies=[Depends(require_access)])
async def create_plan(payload: PlanRequest):
    from app.worlds.planning import prepare_plan
    from app.worlds.jobs import GENERATION_PROFILE
    _validate_location(payload)
    if payload.source == 'google_streetview':
        if not settings.google_maps_api_key:
            raise HTTPException(503, 'Google Street View is not configured, so a panorama of your current location is unavailable. You can open Google Street View to explore.')
        if not settings.google_streetview_ai_authorized:
            raise HTTPException(503, 'External AI generation using Google Street View has not been enabled.')
    values = {k: v for k, v in payload.model_dump().items() if k not in ('location_accuracy_m', 'location_timestamp_ms')}
    values['history_prompt_version'] = PROMPT_VERSION
    values['generation_profile'] = ('streetview-rgb-history-v1:' + settings.world_openai_image_model + ':' + settings.openai_image_quality
                                    if payload.source == 'google_streetview' else GENERATION_PROFILE)
    key = sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()
    index = settings.world_dir / 'plan-index' / f'{key}.json'
    async with _plan_lock:
        try:
            cached = json.loads(index.read_text())
            if time.time() - cached['created_at'] < 3600:
                return _read_plan(cached['plan_id'])
        except (OSError, ValueError, KeyError, HTTPException):
            pass
        try:
            plan_id = str(uuid.uuid4())
            if payload.source == 'google_streetview':
                result = await _prepare_streetview(payload, plan_id)
            else:
                plan = await prepare_plan(payload.lat, payload.lon, payload.year,
                                          radius_m=payload.radius_m, source=payload.source)
                plan.update(plan_id=plan_id, heading_deg=payload.heading_deg, created_at=time.time(),
                            generation_profile=GENERATION_PROFILE, location=_location_provenance(payload))
                result = await asyncio.to_thread(_materialize, plan, plan_dir(plan_id))
        except HTTPException:
            raise
        except Exception as exc:
            # Fail explicitly; never substitute invented real-location buildings.
            code = getattr(exc, 'code', 'plan_unavailable')
            if payload.source == 'google_streetview':
                if code == 'no_coverage':
                    raise HTTPException(404, 'No Google Street View panorama is available near your current location. Move to another location and try again.') from None
                raise HTTPException(502, f'Unable to retrieve Google Street View ({code}). No other location or rough model was substituted.') from None
            raise HTTPException(422, f'World plan preparation failed ({code}). Check location coverage or adjust your viewpoint and try again.') from None
        _atomic_json(index, {'plan_id': result['plan_id'], 'created_at': time.time()})
        return result


@router.get('/world-plans/{plan_id}', dependencies=[Depends(require_access)])
async def get_plan(plan_id: str):
    return _read_plan(plan_id)


@router.post('/world-plans/{plan_id}/edits', dependencies=[Depends(require_access)])
async def edit_plan(plan_id: str, payload: EditsRequest):
    from app.worlds.edits import apply_edits, PlanEditError
    original = _read_plan(plan_id)
    if original.get('input_kind') == 'streetview_panorama':
        raise HTTPException(422, 'The current input is a Street View photo. Building geometry JSON edits cannot be applied to photos.')
    try:
        updated = await asyncio.to_thread(apply_edits, original, payload.edits)
        updated.update(plan_id=str(uuid.uuid4()), parent_plan_id=plan_id, created_at=time.time())
        return await asyncio.to_thread(_materialize, updated, plan_dir(updated['plan_id']))
    except PlanEditError as exc:
        raise HTTPException(422, f'Historical geometry edits were not applied: {exc}') from None


@router.get('/world-plans/{plan_id}/assets/{filename}', dependencies=[Depends(require_access)])
async def plan_asset(plan_id: str, filename: str):
    if filename not in _PLAN_FILES:
        raise HTTPException(404, 'File not found.')
    path = plan_dir(plan_id) / filename
    if not path.is_file():
        raise HTTPException(404, 'File not found.')
    return FileResponse(path, media_type='model/gltf-binary' if filename.endswith('.glb') else 'image/jpeg' if filename.endswith('.jpg') else 'image/png',
                        headers={'Cache-Control': 'private, no-store'})


@router.post('/world-jobs', dependencies=[Depends(require_access)])
async def generate(payload: GenerateRequest):
    plan = _read_plan(payload.plan_id)
    if payload.kind == 'panorama' and plan.get('input_kind') != 'streetview_panorama':
        raise HTTPException(422, 'Panorama walking requires a Street View panorama plan.')
    if payload.kind == 'world' and not settings.worldlab_api_key:
        raise HTTPException(503, 'The World Labs API key is not configured on the server.')
    if plan.get('input_kind') == 'streetview_panorama' and not settings.openai_api_key:
        raise HTTPException(503, 'The historical panorama image editing service is not configured.')
    try:
        if payload.kind == 'panorama':
            return await manager().start_panorama(plan, speculative=False)
        return await manager().start(plan, model=payload.model)
    except Exception as exc:
        code = getattr(exc, 'code', 'generation_unavailable')
        raise HTTPException(409, f'Unable to start generation ({code}).') from None


@router.get('/world-jobs/{job_id}', dependencies=[Depends(require_access)])
async def get_job(job_id: str):
    try:
        job = manager().get(job_id)
    except ValueError:
        job = None
    if job is None:
        raise HTTPException(404, 'World job not found.')
    return job


class WorldExplainRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    hotspot_id: str = Field(pattern=r'^h[0-9]{1,2}$')
    revision: str = Field(pattern=r'^[a-f0-9]{64}$')


@router.get('/world-jobs/{job_id}/hotspots', dependencies=[Depends(require_access)])
@router.post('/world-jobs/{job_id}/hotspots', dependencies=[Depends(require_access)])
async def world_hotspots(job_id: str, request: Request):
    manager()
    return JSONResponse(_hotspots.get(job_id, refine=request.method == 'POST'),
                        headers={'Cache-Control': 'private, no-store'})


@router.post('/world-jobs/{job_id}/explain', dependencies=[Depends(require_access)])
async def explain_world_hotspot(job_id: str, body: WorldExplainRequest):
    manager()
    return await _hotspots.explain(job_id, body.hotspot_id, body.revision)


@router.post('/world-jobs/{job_id}/cancel', dependencies=[Depends(require_access)])
async def cancel_panorama(job_id: str):
    try:
        return await manager().cancel_panorama(job_id)
    except (ValueError, FileNotFoundError):
        raise HTTPException(404, 'World job not found.') from None
    except Exception as exc:
        code = getattr(exc, 'code', 'cancellation_unavailable')
        status = 404 if code == 'job_not_found' else 409
        raise HTTPException(status, f'This panorama job cannot be cancelled ({code}).') from None


@router.post('/world-jobs/{job_id}/resume', dependencies=[Depends(require_access)])
async def resume_job(job_id: str):
    from app.worlds.marble import MarbleError
    try:
        return await manager().resume(job_id)
    except MarbleError as exc:
        status = {'job_not_found': 404, 'missing_key': 503}.get(exc.code, 409)
        raise HTTPException(status, f'This job cannot resume yet ({exc.code}). Generation will not be submitted again.') from None
    except (ValueError, FileNotFoundError):
        raise HTTPException(409, 'This job cannot safely resume. The generation that was already billed will not be submitted again.') from None


@router.get('/world-jobs/{job_id}/assets/{filename}', dependencies=[Depends(require_access)])
async def job_asset(job_id: str, filename: str):
    try:
        path = manager().artifact_path(job_id, filename)
    except ValueError:
        path = None
    if path is None or not path.is_file():
        raise HTTPException(404, 'The asset is not ready yet.')
    return FileResponse(path, headers={'Cache-Control': 'private, no-store'})
