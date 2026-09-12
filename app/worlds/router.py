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
from app.temporal import MIN_YEAR, MAX_YEAR

router = APIRouter()
_manager = None
_plan_lock = asyncio.Lock()
_ID = re.compile(r'[a-f0-9-]{36}\Z')
_PLAN_FILES = {'modern.glb', 'historical.glb', 'depth.png', 'depth_preview.png'}


async def startup():
    global _manager
    from app.worlds.jobs import WorldJobManager
    _manager = WorldJobManager(settings.world_dir / 'jobs', settings.worldlab_api_key)
    await _manager.resume_all()


async def shutdown():
    global _manager
    if _manager is not None:
        await _manager.aclose()
    _manager = None


def manager():
    if _manager is None:
        raise HTTPException(503, '世界生成服务尚未启动。')
    return _manager


async def require_access(request: Request):
    supplied = request.headers.get('authorization', '')
    if not secrets.compare_digest(supplied.encode(), ('Bearer ' + settings.world_access_token).encode()):
        raise HTTPException(401, '请连接生成服务；远程访问需要独立访问码。')
    if request.method in ('POST', 'PATCH'):
        # Bound the actual body, including requests without Content-Length.
        if len(await request.body()) > 256 * 1024:
            raise HTTPException(413, '区块请求过大。')


@router.get('/world-config')
async def configuration():
    return {'configured': bool(settings.worldlab_api_key), 'model': 'marble-1.0-draft',
            'min_year': MIN_YEAR, 'max_year': MAX_YEAR,
            'default_location': {'lat': 40.4433, 'lon': -79.9436, 'radius_m': 100},
            'historical_accuracy': 'unverified', 'phone_ar': False}


@router.get('/world-session')
async def local_session(request: Request):
    origin = request.headers.get('origin')
    local = request.client and request.client.host in ('127.0.0.1', '::1', 'testclient')
    local_host = request.url.hostname in ('localhost', '127.0.0.1', '::1', 'testserver')
    if (not local or not local_host or request.headers.get('sec-fetch-site') == 'cross-site'
            or origin and origin.rstrip('/') != str(request.base_url).rstrip('/')):
        raise HTTPException(403, '远程访问需要独立访问码。')
    return JSONResponse({'access_token': settings.world_access_token}, headers={'Cache-Control': 'no-store'})


class PlanRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    lat: float = Field(ge=-85, le=85, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    year: int = Field(ge=MIN_YEAR, le=MAX_YEAR, strict=True)
    radius_m: int = Field(default=100, ge=50, le=150, strict=True)
    source: Literal['osm', 'cmu_snapshot'] = 'osm'
    heading_deg: float = Field(default=0, ge=0, lt=360, allow_inf_nan=False)


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    plan_id: str
    model: Literal['marble-1.0-draft'] = 'marble-1.0-draft'


class EditsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    edits: list[dict] = Field(min_length=1, max_length=20)


def plan_dir(plan_id: str) -> Path:
    if not _ID.fullmatch(plan_id):
        raise HTTPException(404, '找不到这个区块。')
    return settings.world_dir / 'plans' / plan_id


def _read_plan(plan_id: str) -> dict:
    try:
        return json.loads((plan_dir(plan_id) / 'plan.json').read_text())
    except (OSError, ValueError):
        raise HTTPException(404, '找不到这个区块。') from None


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
    plan['assets'] = {name: f'/world-plans/{plan["plan_id"]}/assets/{name}' for name in _PLAN_FILES}
    _atomic_json(directory / 'plan.json', plan)
    return plan


@router.post('/world-plans', dependencies=[Depends(require_access)])
async def create_plan(payload: PlanRequest):
    from app.worlds.planning import prepare_plan
    from app.worlds.jobs import GENERATION_PROFILE
    values = {**payload.model_dump(), 'generation_profile': GENERATION_PROFILE}
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
            plan = await prepare_plan(payload.lat, payload.lon, payload.year,
                                      radius_m=payload.radius_m, source=payload.source)
            plan.update(plan_id=str(uuid.uuid4()), heading_deg=payload.heading_deg, created_at=time.time(),
                        generation_profile=GENERATION_PROFILE)
            result = await asyncio.to_thread(_materialize, plan, plan_dir(plan['plan_id']))
        except HTTPException:
            raise
        except Exception as exc:
            # Fail explicitly; never substitute invented real-location buildings.
            code = getattr(exc, 'code', 'plan_unavailable')
            raise HTTPException(422, f'区块准备失败（{code}）。请检查地点覆盖，或调整观察位置后重试。') from None
        _atomic_json(index, {'plan_id': plan['plan_id'], 'created_at': time.time()})
        return result


@router.get('/world-plans/{plan_id}', dependencies=[Depends(require_access)])
async def get_plan(plan_id: str):
    return _read_plan(plan_id)


@router.post('/world-plans/{plan_id}/edits', dependencies=[Depends(require_access)])
async def edit_plan(plan_id: str, payload: EditsRequest):
    from app.worlds.edits import apply_edits, PlanEditError
    original = _read_plan(plan_id)
    try:
        updated = await asyncio.to_thread(apply_edits, original, payload.edits)
        updated.update(plan_id=str(uuid.uuid4()), parent_plan_id=plan_id, created_at=time.time())
        return await asyncio.to_thread(_materialize, updated, plan_dir(updated['plan_id']))
    except PlanEditError as exc:
        raise HTTPException(422, f'历史几何编辑未应用：{exc}') from None


@router.get('/world-plans/{plan_id}/assets/{filename}', dependencies=[Depends(require_access)])
async def plan_asset(plan_id: str, filename: str):
    if filename not in _PLAN_FILES:
        raise HTTPException(404, '找不到文件。')
    path = plan_dir(plan_id) / filename
    if not path.is_file():
        raise HTTPException(404, '找不到文件。')
    return FileResponse(path, media_type='model/gltf-binary' if filename.endswith('.glb') else 'image/png',
                        headers={'Cache-Control': 'private, no-store'})


@router.post('/world-jobs', dependencies=[Depends(require_access)])
async def generate(payload: GenerateRequest):
    if not settings.worldlab_api_key:
        raise HTTPException(503, '服务器尚未配置 World Labs 密钥。')
    plan = _read_plan(payload.plan_id)
    try:
        return await manager().start(plan, model=payload.model)
    except Exception as exc:
        code = getattr(exc, 'code', 'generation_unavailable')
        raise HTTPException(409, f'无法启动生成（{code}）。') from None


@router.get('/world-jobs/{job_id}', dependencies=[Depends(require_access)])
async def get_job(job_id: str):
    try:
        job = manager().get(job_id)
    except ValueError:
        job = None
    if job is None:
        raise HTTPException(404, '找不到世界任务。')
    return job


@router.post('/world-jobs/{job_id}/resume', dependencies=[Depends(require_access)])
async def resume_job(job_id: str):
    from app.worlds.marble import MarbleError
    try:
        return await manager().resume(job_id)
    except MarbleError as exc:
        status = {'job_not_found': 404, 'missing_key': 503}.get(exc.code, 409)
        raise HTTPException(status, f'此任务暂不能继续（{exc.code}）。不会重复提交生成。') from None
    except (ValueError, FileNotFoundError):
        raise HTTPException(409, '此任务无法安全继续；不会重新提交已收费的生成。') from None


@router.get('/world-jobs/{job_id}/assets/{filename}', dependencies=[Depends(require_access)])
async def job_asset(job_id: str, filename: str):
    try:
        path = manager().artifact_path(job_id, filename)
    except ValueError:
        path = None
    if path is None or not path.is_file():
        raise HTTPException(404, '资产尚未就绪。')
    return FileResponse(path, headers={'Cache-Control': 'private, no-store'})
