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

from .config import DECADE_ANCHOR, MAX_UPLOAD_MB, ROOT, settings
from .hotspots import explain_hotspot
from .location import city_from_latlon, coords_for_place, exif_gps, resolve_place
from .manifest import create_manifest, job_dir, read_manifest, update_manifest
from .temporal import DEFAULT_YEAR, MAX_YEAR, MIN_YEAR, decade_for_year, manifest_year, resolve_year
from .weather import DEFAULT_WEATHER_IDS, parse_weather_ids, weather_subdir
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
                update_manifest(path.parent.name, lambda m: m.update(status='error', error='A server restart interrupted this job. Please upload again.'))
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
        from .pipeline import _hotspot_tasks
        loop = asyncio.get_running_loop()
        pending = [task for registry in (_tasks, _baselines, _hotspot_tasks)
                   for task in registry.values() if not task.done() and task.get_loop() is loop]
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        _tasks.clear()
        _baselines.clear()
        _hotspot_tasks.clear()


app = FastAPI(title='Century Pano', version='0.1.0', lifespan=lifespan)


@app.middleware('http')
async def security_headers(request, call_next):
    length = request.headers.get('content-length')
    if request.url.path.startswith(('/world-plans', '/world-jobs', '/world-prefetch')) and request.method in ('POST', 'PATCH'):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 256 * 1024:
                return PlainTextResponse('The world plan request is too large.', status_code=413)
        request._body = bytes(body)
    if request.url.path in ('/jobs', '/preview') and length:
        try:
            if int(length) > (MAX_UPLOAD_MB + 1) * 1024 * 1024:
                return PlainTextResponse('Images must be 40 MB or smaller.', status_code=413)
        except ValueError:
            return PlainTextResponse('Invalid Content-Length', status_code=400)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # OSM's public tile service requires a Referer for web requests.  The
    # previous same-origin policy stripped it from the cross-origin tile
    # requests and could result in 403 responses.
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)'
    if (request.url.path in ('/sw.js', '/health', '/replays') or request.url.path.endswith('/manifest')
            or request.url.path.startswith(('/world-session', '/world-plans', '/world-jobs', '/world-config', '/world-prefetch'))):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.exception_handler(HTTPException)
async def plain_error(request, exc):
    if request.url.path.startswith('/world-'):
        return JSONResponse({'detail': str(exc.detail)}, status_code=exc.status_code, headers=exc.headers)
    return PlainTextResponse(str(exc.detail), status_code=exc.status_code, headers=exc.headers)


def get_manifest(job_id):
    try:
        return read_manifest(job_id)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, 'This job could not be found.') from None


def initial_manifest(job_id, source, decade, place, heading=0.5, *, target_year=None,
                     weather_enabled=False, weather_ids=None):
    year = resolve_year(decade if target_year is None else target_year)
    ids = list(weather_ids or DEFAULT_WEATHER_IDS) if weather_enabled else []
    return {
        'job_id': job_id, 'status': 'running', 'mode': 'live', 'provider': settings.provider,
        'demo': settings.provider == 'demo', 'source': source, 'place': place,
        'decade': decade_for_year(year), 'target_year': year, 'anchor_year': year, 'heading': heading,
        'job_seed': int(uuid.UUID(job_id)) % (2**31), 'geometry': None, 'scene': {}, 'constraints': {},
        'anchor': {'status': 'pending', 'path': None, 'ms': None}, 'tiles': [],
        'result': {'path': None, 'status': 'pending'},
        'hotspots': {'status': 'pending', 'items': [], 'fallback': None},
        'weather': {
            'enabled': bool(weather_enabled),
            'active': ids[0] if ids else None,
            'ids': ids,
            'variants': {},
        },
        'metrics': {'started_at': time.time(), 'anchor_done_at': None, 'first_tile_at': None,
                    'finished_at': None, 'first_view_s': None, 'total_s': None,
                    'seam_err': {'raw': None, 'after_color_match': None, 'originals_floor': None},
                    'serial_baseline_s': None, 'speedup': None, 'image_calls': 0,
                    'tokens': {'vlm': 0, 'llm': 0}},
    }


async def read_upload(image):
    if image.content_type not in {'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'application/octet-stream'}:
        raise HTTPException(415, 'Please upload a JPEG, PNG or HEIC panorama image.')
    raw = await image.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
    await image.close()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, 'Images must be 40 MB or smaller.')
    return raw


def inspect_upload(raw, preview=False):
    try:
        with Image.open(io.BytesIO(raw)) as uploaded:
            if uploaded.format not in ('JPEG', 'PNG', 'HEIF', 'HEIC'):
                raise HTTPException(415, 'Please upload a JPEG, PNG or HEIC panorama image.')
            fmt = uploaded.format
            gps = exif_gps(uploaded)
            w, h = uploaded.size
            if w < 32 or h < 32 or w * h > 100_000_000:
                raise HTTPException(415, 'Invalid image dimensions; use an image of at least 32×32 and at most 100 megapixels.')
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
        raise HTTPException(415, 'This image could not be read. Please use a valid JPEG, PNG or HEIC.') from None


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
        update_manifest(job_id, lambda m: m.update(status='error', error='Processing failed. Check the server configuration and try again.'))
    finally:
        _tasks.pop(job_id, None)


@app.post('/jobs', status_code=201)
async def create_job(
    image: UploadFile = File(...), decade: str | None = Form(None),
    target_year: str | None = Form(None),
    lat: float | None = Form(None, ge=-90, le=90), lon: float | None = Form(None, ge=-180, le=180),
    place: str = Form('', max_length=160), heading: float = Form(0.5, ge=0, le=1),
    is_360: bool | None = Form(None),
    weather_enabled: bool | None = Form(None),
    weathers: str | None = Form(None),
):
    try:
        if target_year is None and decade is not None and decade not in DECADE_ANCHOR:
            raise ValueError('Unsupported legacy era')
        # Validate the raw form value so 1945.0, scientific notation and era
        # aliases cannot be silently coerced into an exact calendar year.
        if target_year is not None and not target_year.strip().isascii():
            raise ValueError('Expected an integer year')
        if target_year is not None and not target_year.strip().isdigit():
            raise ValueError('Expected an integer year')
        year = resolve_year((decade if decade is not None else DEFAULT_YEAR) if target_year is None else target_year)
    except ValueError:
        raise HTTPException(422, f'Choose a whole year between {MIN_YEAR} and {MAX_YEAR}.') from None
    if (lat is None) != (lon is None):
        raise HTTPException(422, 'Latitude and longitude must be supplied together.')
    use_weather = settings.weather_enabled if weather_enabled is None else bool(weather_enabled)
    weather_ids = None
    if use_weather:
        try:
            weather_ids = parse_weather_ids(weathers)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
    if len(_tasks) >= 4:
        raise HTTPException(429, 'Another job is already processing. Please try again shortly.')
    if not settings.provider_configured():
        raise HTTPException(503, 'Set an image service API key in the server .env and restart, or use a replay example.')
    raw = await read_upload(image)
    fmt, gps, w, h = await asyncio.to_thread(inspect_upload, raw)
    job_id = str(uuid.uuid4())
    extension = {'JPEG': 'jpg', 'PNG': 'png', 'HEIF': 'heic', 'HEIC': 'heic'}[fmt]
    input_path = settings.in_dir / f'{job_id}.{extension}'
    location = await asyncio.to_thread(resolve_place, lat, lon, gps, place)
    # Recheck after all awaited validation; no coroutine can reserve another
    # slot between this check and registration below.
    if len(_tasks) >= 4:
        raise HTTPException(429, 'Another job is already processing. Please try again shortly.')
    input_path.parent.mkdir(parents=True, exist_ok=True)
    input_path.write_bytes(raw)
    source = {'path': f'in/{input_path.name}', 'w': w, 'h': h,
              'is_360': abs(w / h - 2.0) < 0.1 if is_360 is None else is_360}
    manifest = initial_manifest(
        job_id, source, decade, location, heading, target_year=year,
        weather_enabled=use_weather, weather_ids=weather_ids,
    )
    if w / h < 2:
        manifest['warnings'] = ['This image looks narrow. Your phone panorama mode will give a better result.']
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
        raise HTTPException(404, 'This file has not been generated yet.')
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


class ExplainRequest(BaseModel):
    hotspot_id: str = Field(min_length=2, max_length=4, pattern=r'^h[0-9]{1,2}$')


_explains: dict[str, asyncio.Task] = {}


@app.post('/jobs/{job_id}/explain')
async def explain_region(job_id: str, body: ExplainRequest):
    manifest = get_manifest(job_id)
    if manifest.get('status') not in ('done', 'done_partial'):
        raise HTTPException(409, 'Wait for the reconstruction to finish first.')
    items = (manifest.get('hotspots') or {}).get('items') or []
    hotspot = next((item for item in items if item.get('id') == body.hotspot_id), None)
    if hotspot is None:
        raise HTTPException(404, 'That highlighted region was not found.')
    path = job_dir(job_id) / 'result.jpg'
    if not path.is_file():
        raise HTTPException(404, 'The reconstructed image is not available yet.')
    if len(_explains) >= 6:
        raise HTTPException(429, 'Too many explanations are running. Please try again shortly.')
    key = f'{job_id}:{body.hotspot_id}'
    if key in _explains:
        raise HTTPException(429, 'That region is already being explained.')

    async def run():
        try:
            image = await asyncio.to_thread(path.read_bytes)
            return await explain_hotspot(
                image, hotspot,
                year=manifest_year(manifest),
                place=manifest.get('place'),
                historical_context=(manifest.get('constraints') or {}).get('historical_context'),
                scene=manifest.get('scene'),
            )
        finally:
            _explains.pop(key, None)

    task = asyncio.create_task(run())
    _explains[key] = task
    try:
        return await task
    except Exception:
        raise HTTPException(502, 'The explanation service did not respond. Please try again.') from None


@app.post('/jobs/{job_id}/hotspots')
async def refresh_hotspots(job_id: str):
    """Return dots immediately; refine with VLM in the background."""
    from .pipeline import _ensure_instant_hotspots, _schedule_hotspot_refine

    manifest = get_manifest(job_id)
    if manifest.get('status') not in ('done', 'done_partial'):
        raise HTTPException(409, 'Wait for the reconstruction to finish first.')
    path = job_dir(job_id) / 'result.jpg'
    if not path.is_file():
        raise HTTPException(404, 'The reconstructed image is not available yet.')
    hotspots = _ensure_instant_hotspots(job_id, manifest.get('scene'))
    _schedule_hotspot_refine(job_id, job_dir(job_id), manifest.get('provider') or settings.provider)
    return hotspots


@app.get('/out/{job_id}/{filename:path}')
async def generated_asset(job_id: str, filename: str):
    allowed = {'band.jpg', 'band_ext.jpg', 'anchor.jpg', 'result.jpg'}
    allowed |= {f't{i}{suffix}.jpg' for i in range(8) for suffix in ('', '_raw')}
    for weather_id in DEFAULT_WEATHER_IDS:
        prefix = weather_subdir(weather_id)
        allowed |= {
            f'{prefix}/anchor.jpg', f'{prefix}/result.jpg',
            *{f'{prefix}/t{i}{suffix}.jpg' for i in range(8) for suffix in ('', '_raw')},
        }
    if filename not in allowed:
        raise HTTPException(404, 'File not found')
    return output_file(job_id, filename)



@app.post('/jobs/{job_id}/baseline', status_code=202)
async def baseline(job_id: str):
    m = get_manifest(job_id)
    if m['status'] not in ('done', 'done_partial'):
        raise HTTPException(409, 'Wait for the reconstruction to finish first.')
    if job_id in _baselines:
        return {'job_id': job_id, 'status': 'running'}
    if len(_baselines) >= 2:
        raise HTTPException(429, 'A baseline test is already running. Please try again shortly.')
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
                coords = coords_for_place(m.get('place'))
                if coords:
                    entry['lat'], entry['lon'] = coords
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
            'min_year': MIN_YEAR, 'max_year': MAX_YEAR, 'default_year': DEFAULT_YEAR,
            'weather_enabled': settings.weather_enabled, 'weather_ids': list(DEFAULT_WEATHER_IDS)}


app.include_router(world_router)
app.mount('/world-vendor', StaticFiles(directory=ROOT / 'node_modules', check_dir=False), name='world-vendor')
app.mount('/', StaticFiles(directory=ROOT / 'web', html=True), name='web')
