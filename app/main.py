import asyncio
import contextlib
import io
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener
from pydantic import BaseModel, Field

from .config import DECADE_ANCHOR, DEFAULT_DECADE, MAX_UPLOAD_MB, ROOT, settings
from .location import exif_gps, resolve_place, city_from_latlon
from .manifest import create_manifest, job_dir, read_manifest, update_manifest
from .temporal import DEFAULT_YEAR, MAX_YEAR, MIN_YEAR, decade_for_year, manifest_year, resolve_year
from .worlds.router import router as world_router

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 100_000_000
_tasks: dict[str, asyncio.Task] = {}
_baselines: dict[str, asyncio.Task] = {}


@asynccontextmanager
async def lifespan(app):
    settings.in_dir.mkdir(parents=True, exist_ok=True)
    settings.out_dir.mkdir(parents=True, exist_ok=True)
    for path in settings.out_dir.glob('*/manifest.json'):
        try:
            old = read_manifest(path.parent.name)
            if old.get('status') == 'running':
                update_manifest(path.parent.name, lambda m: m.update(status='error', error='服务重启中断了任务，请重新上传。'))
            if old.get('baseline_status') == 'running':
                update_manifest(path.parent.name, lambda m: m.update(baseline_status='error'))
        except (OSError, ValueError):
            continue
    from .worlds import router as world_routes
    await world_routes.startup()
    try:
        yield
    finally:
        await world_routes.shutdown()
        pending = list(_tasks.values()) + list(_baselines.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


app = FastAPI(title='Century Pano', version='0.1.0', lifespan=lifespan)


@app.middleware('http')
async def security_headers(request, call_next):
    length = request.headers.get('content-length')
    if request.url.path.startswith(('/world-plans', '/world-jobs')) and request.method in ('POST', 'PATCH'):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 256 * 1024:
                return PlainTextResponse('区块请求过大。', status_code=413)
        request._body = bytes(body)
    if request.url.path in ('/jobs', '/preview') and length:
        try:
            if int(length) > (MAX_UPLOAD_MB + 1) * 1024 * 1024:
                return PlainTextResponse('图片不能超过 40 MB。', status_code=413)
        except ValueError:
            return PlainTextResponse('Invalid Content-Length', status_code=400)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)'
    if (request.url.path in ('/sw.js', '/health', '/replays') or request.url.path.endswith('/manifest')
            or request.url.path.startswith(('/world-session', '/world-plans', '/world-jobs', '/world-config'))):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.exception_handler(HTTPException)
async def plain_error(request, exc):
    return PlainTextResponse(str(exc.detail), status_code=exc.status_code, headers=exc.headers)


def get_manifest(job_id):
    try:
        return read_manifest(job_id)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, '找不到这个任务。') from None


def initial_manifest(job_id, source, decade, place, heading=0.5, *, target_year=None):
    year = resolve_year(decade if target_year is None else target_year)
    return {
        'job_id': job_id, 'status': 'running', 'mode': 'live', 'provider': settings.provider,
        'demo': settings.provider == 'demo', 'source': source, 'place': place,
        'decade': decade_for_year(year), 'target_year': year, 'anchor_year': year, 'heading': heading,
        'job_seed': int(uuid.UUID(job_id)) % (2**31), 'geometry': None, 'scene': {}, 'constraints': {},
        'anchor': {'status': 'pending', 'path': None, 'ms': None}, 'tiles': [],
        'result': {'path': None, 'status': 'pending'},
        'metrics': {'started_at': time.time(), 'anchor_done_at': None, 'first_tile_at': None,
                    'finished_at': None, 'first_view_s': None, 'total_s': None,
                    'seam_err': {'raw': None, 'after_color_match': None, 'originals_floor': None},
                    'serial_baseline_s': None, 'speedup': None, 'image_calls': 0,
                    'tokens': {'vlm': 0, 'llm': 0}},
    }


async def read_upload(image):
    if image.content_type not in {'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'application/octet-stream'}:
        raise HTTPException(415, '请上传 JPEG、PNG 或 HEIC 全景图片。')
    raw = await image.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
    await image.close()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, '图片不能超过 40 MB。')
    return raw


def inspect_upload(raw, preview=False):
    try:
        with Image.open(io.BytesIO(raw)) as uploaded:
            if uploaded.format not in ('JPEG', 'PNG', 'HEIF', 'HEIC'):
                raise HTTPException(415, '请上传 JPEG、PNG 或 HEIC 全景图片。')
            fmt = uploaded.format
            gps = exif_gps(uploaded)
            w, h = uploaded.size
            if w < 32 or h < 32 or w * h > 100_000_000:
                raise HTTPException(415, '图片尺寸无效；请使用至少 32×32、最多一亿像素的图片。')
            uploaded.load()
            oriented = ImageOps.exif_transpose(uploaded)
            w, h = oriented.size
            if preview:
                converted = oriented.convert('RGB')
                converted.thumbnail((6000, 1200), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                converted.save(output, 'JPEG', quality=90)
                return output.getvalue()
            return fmt, gps, w, h
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(415, '无法读取图片，请使用有效的 JPEG、PNG 或 HEIC。') from None


@app.post('/preview')
async def upload_preview(image: UploadFile = File(...)):
    raw = await read_upload(image)
    converted = await asyncio.to_thread(inspect_upload, raw, True)
    return Response(converted, media_type='image/jpeg', headers={'Cache-Control': 'no-store'})


async def _run(job_id):
    from .pipeline import run_job
    try:
        await run_job(job_id)
    except asyncio.CancelledError:
        raise
    except Exception:
        # Provider details can contain credentials or image URLs. Expose a fixed
        # diagnostic message, and leave detailed per-tile errors to the adapter.
        update_manifest(job_id, lambda m: m.update(status='error', error='处理失败，请检查服务器配置后重试。'))
    finally:
        _tasks.pop(job_id, None)


@app.post('/jobs', status_code=201)
async def create_job(
    image: UploadFile = File(...), decade: str = Form(DEFAULT_DECADE),
    target_year: str | None = Form(None),
    lat: float | None = Form(None, ge=-90, le=90), lon: float | None = Form(None, ge=-180, le=180),
    place: str = Form('', max_length=160), heading: float = Form(0.5, ge=0, le=1),
    is_360: bool | None = Form(None),
):
    try:
        if target_year is None and decade not in DECADE_ANCHOR:
            raise ValueError('Unsupported legacy era')
        # Validate the raw form value so 1945.0, scientific notation and era
        # aliases cannot be silently coerced into an exact calendar year.
        if target_year is not None and not target_year.strip().isascii():
            raise ValueError('Expected an integer year')
        if target_year is not None and not target_year.strip().isdigit():
            raise ValueError('Expected an integer year')
        year = resolve_year(decade if target_year is None else target_year)
    except ValueError:
        raise HTTPException(422, f'请选择 {MIN_YEAR} 至 {MAX_YEAR} 之间的整数年份。') from None
    if (lat is None) != (lon is None):
        raise HTTPException(422, 'Latitude and longitude must be supplied together.')
    if len(_tasks) >= 4:
        raise HTTPException(429, '已有任务正在处理，请稍后再试。')
    if not settings.provider_configured():
        raise HTTPException(503, '请先在服务器 .env 中配置图像服务密钥并重启服务，或使用回放示例。')
    raw = await read_upload(image)
    fmt, gps, w, h = await asyncio.to_thread(inspect_upload, raw)
    job_id = str(uuid.uuid4())
    extension = {'JPEG': 'jpg', 'PNG': 'png', 'HEIF': 'heic', 'HEIC': 'heic'}[fmt]
    input_path = settings.in_dir / f'{job_id}.{extension}'
    location = await asyncio.to_thread(resolve_place, lat, lon, gps, place)
    # Recheck after all awaited validation; no coroutine can reserve another
    # slot between this check and registration below.
    if len(_tasks) >= 4:
        raise HTTPException(429, '已有任务正在处理，请稍后再试。')
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_bytes(raw)
    source = {'path': f'in/{input_path.name}', 'w': w, 'h': h,
              'is_360': abs(w / h - 2.0) < 0.1 if is_360 is None else is_360}
    manifest = initial_manifest(job_id, source, decade, location, heading, target_year=year)
    if w / h < 2:
        manifest['warnings'] = ['这张图片看起来较窄，使用手机全景模式会得到更好的效果。']
    create_manifest(job_id, manifest)
    _tasks[job_id] = asyncio.create_task(_run(job_id))
    return {'job_id': job_id}


@app.get('/jobs/{job_id}/manifest')
async def manifest_route(job_id: str):
    return JSONResponse(get_manifest(job_id), headers={'Cache-Control': 'no-store'})


def output_file(job_id, filename, media_type='image/jpeg'):
    get_manifest(job_id)
    path = job_dir(job_id) / filename
    if not path.is_file():
        raise HTTPException(404, '文件还未生成。')
    return FileResponse(path, media_type=media_type)


@app.get('/jobs/{job_id}/preview')
async def preview(job_id: str):
    return output_file(job_id, 'band.jpg')


@app.get('/jobs/{job_id}/tiles/{i}')
async def tile(job_id: str, i: int, raw: bool = False):
    if not 0 <= i < 8:
        raise HTTPException(404, 'Tile not found')
    return output_file(job_id, f't{i}{"_raw" if raw else ""}.jpg')


@app.get('/jobs/{job_id}/result')
async def result(job_id: str):
    return output_file(job_id, 'result.jpg')


@app.get('/out/{job_id}/{filename}')
async def generated_asset(job_id: str, filename: str):
    allowed = {'band.jpg', 'band_ext.jpg', 'anchor.jpg', 'result.jpg'}
    allowed |= {f't{i}{suffix}.jpg' for i in range(8) for suffix in ('', '_raw')}
    if filename not in allowed:
        raise HTTPException(404, 'File not found')
    return output_file(job_id, filename)


@app.get('/jobs/{job_id}/audio')
async def audio(job_id: str):
    m = get_manifest(job_id)
    year = manifest_year(m)
    audio_era = min(DECADE_ANCHOR, key=lambda era: abs(DECADE_ANCHOR[era] - year))
    path = ROOT / 'web/audio' / f'{audio_era}.wav'
    if not path.is_file():
        raise HTTPException(404, 'Audio unavailable')
    return FileResponse(path, media_type='audio/wav')


@app.post('/jobs/{job_id}/baseline', status_code=202)
async def baseline(job_id: str):
    m = get_manifest(job_id)
    if m['status'] not in ('done', 'done_partial'):
        raise HTTPException(409, '请先等待重建完成。')
    if job_id in _baselines:
        return {'job_id': job_id, 'status': 'running'}
    if len(_baselines) >= 2:
        raise HTTPException(429, '已有基线测试正在运行，请稍后再试。')
    from .pipeline import run_baseline
    async def run():
        try:
            await run_baseline(job_id)
        except Exception:
            update_manifest(job_id, lambda m: m.update(baseline_status='error'))
        finally:
            _baselines.pop(job_id, None)
    update_manifest(job_id, lambda m: m.update(baseline_status='running'))
    _baselines[job_id] = asyncio.create_task(run())
    return {'job_id': job_id, 'status': 'running'}


@app.get('/replays')
async def replays():
    result = []
    for file in sorted(settings.out_dir.glob('*/manifest.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        with contextlib.suppress(OSError, ValueError):
            m = read_manifest(file.parent.name)
            if m.get('mode') == 'replay' and m.get('status') in ('done', 'done_partial') and not m.get('baseline_of'):
                entry = {k: m.get(k) for k in ('job_id', 'place', 'decade', 'anchor_year', 'metrics', 'provider', 'demo', 'title', 'source')}
                entry['target_year'] = manifest_year(m)
                result.append(entry)
    return {'replays': result}


class Coordinates(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)


@app.post('/location/resolve')
async def resolve(coords: Coordinates):
    return await asyncio.to_thread(city_from_latlon, coords.lat, coords.lon)


@app.get('/health')
async def health():
    configured = settings.provider_configured()
    return {'status': 'ok', 'provider': settings.provider, 'configured': configured, 'version': '0.1.0',
            'min_year': MIN_YEAR, 'max_year': MAX_YEAR, 'default_year': DEFAULT_YEAR}


app.include_router(world_router)
app.mount('/world-vendor', StaticFiles(directory=ROOT / 'node_modules', check_dir=False), name='world-vendor')
app.mount('/', StaticFiles(directory=ROOT / 'web', html=True), name='web')
