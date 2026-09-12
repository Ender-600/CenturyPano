"""Publish one existing world through a read-only loopback gateway.

Run the backend first, then serve_world_viewer.py --world EXISTING_JOB_ID.
Point an HTTPS tunnel at http://127.0.0.1:8003 and open
/world/?viewer=1&world=EXISTING_JOB_ID. The public session marker is deliberately
not a credential. Only the selected world, its plan, and their listed assets
are shared; the backend access token stays inside this process.
"""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import json
import re
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
import httpx
from starlette.background import BackgroundTask
import uvicorn


VIEWER_MARKER = 'public-world-viewer-session'
PROBE_PATH = '/world-plans/00000000-0000-0000-0000-000000000000'
REQUEST_HEADERS = {'accept', 'accept-encoding', 'range', 'if-range', 'if-none-match', 'if-modified-since'}
RESPONSE_HEADERS = {'content-type', 'content-length', 'content-encoding', 'content-range',
                    'accept-ranges', 'etag', 'last-modified', 'cache-control', 'expires', 'vary'}
PERMISSIONS_POLICY = 'geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)'


def validate_settings(world: str, port: int, upstream: str) -> httpx.URL:
    if not re.fullmatch(r'[a-f0-9]{32}', world):
        raise ValueError('Select an existing 32-character world job ID.')
    if not 1 <= port <= 65535:
        raise ValueError('Invalid gateway port.')
    parsed = urlsplit(upstream)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or parsed.port is not None and not 1 <= parsed.port <= 65535):
        raise ValueError('The upstream must be an HTTP origin on 127.0.0.1.')
    return httpx.URL(upstream.rstrip('/'))


def valid_path(path: str) -> bool:
    return (path.startswith('/') and not any(c in path for c in ('\\', '%', '?', '#'))
            and '//' not in path and not any(part in ('.', '..') for part in path.split('/'))
            and all(32 < ord(c) < 127 for c in path))


def listed_assets(job: dict, plan: dict, job_path: str, plan_path: str) -> frozenset[str]:
    """Accept only literal, direct-child API asset URLs belonging to this world."""
    paths = set()
    job_assets, plan_assets = job.get('assets', []), plan.get('assets', {})
    if not isinstance(job_assets, list) or not isinstance(plan_assets, dict):
        raise ValueError('Invalid asset list.')
    for prefix, values in ((job_path + '/assets/', [item.get('url') for item in job_assets if isinstance(item, dict)]),
                           (plan_path + '/assets/', plan_assets.values())):
        for value in values:
            if (not isinstance(value, str) or not valid_path(value) or not value.startswith(prefix)
                    or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', value[len(prefix):])):
                raise ValueError('Invalid asset URL.')
            paths.add(value)
    return frozenset(paths)


def create_app(*, world: str, port: int = 8003, upstream: str = 'http://127.0.0.1:8001',
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    upstream_url = validate_settings(world, port, upstream)
    job_path = '/world-jobs/' + world

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                     timeout=httpx.Timeout(180, connect=5)) as client:
            async def fetch_json(path, token=None):
                headers = {'authorization': 'Bearer ' + token} if token else {}
                response = await client.get(upstream_url.copy_with(path=path), headers=headers)
                response.raise_for_status()
                value = response.json()
                if not isinstance(value, dict):
                    raise ValueError('Invalid response.')
                return value

            try:
                token = (await fetch_json('/world-session'))['access_token']
                if (not isinstance(token, str) or not 16 <= len(token) <= 512
                        or not token.isascii() or not all(32 < ord(c) < 127 for c in token)):
                    raise ValueError('Invalid session.')
                job = await fetch_json(job_path, token)
                if job.get('job_id', job.get('id')) != world or job.get('stage', job.get('status')) != 'ready':
                    raise ValueError('Unexpected world.')
                plan_id = job['plan_id']
                if not isinstance(plan_id, str) or not re.fullmatch(r'[a-f0-9-]{36}', plan_id):
                    raise ValueError('Invalid world plan.')
                plan_path = '/world-plans/' + plan_id
                plan = await fetch_json(plan_path, token)
                if plan.get('plan_id') != plan_id:
                    raise ValueError('Unexpected plan.')
                assets = listed_assets(job, plan, job_path, plan_path)
                job = {key: job[key] for key in ('id', 'job_id', 'plan_id', 'model', 'year', 'stage',
                       'status', 'input_kind', 'assets', 'validation', 'review', 'error_code') if key in job}
                plan = {key: plan[key] for key in ('plan_id', 'input_kind', 'source', 'location',
                        'location_source', 'target_year', 'modern_buildings', 'historical_buildings',
                        'changes', 'sources', 'uncertainties', 'assets', 'camera_position', 'camera_location',
                        'heading_deg', 'coordinate_frame', 'geometry', 'source_panorama', 'attribution')
                        if key in plan}
                if isinstance(plan.get('source_panorama'), dict):
                    panorama_metadata = plan['source_panorama'].get('metadata', {})
                    plan['source_panorama'] = {'metadata': {key: panorama_metadata[key] for key in
                        ('heading', 'tilt', 'roll', 'distance_m', 'copyright', 'date', 'lat', 'lon',
                         'width', 'height') if key in panorama_metadata}}
                config = await fetch_json('/world-config')
                # Return only documented presentation settings, never arbitrary backend fields.
                config = {key: config[key] for key in ('model', 'models', 'min_year', 'max_year',
                          'test_location', 'default_source', 'default_location_source', 'historical_accuracy')
                          if key in config}
                config.update(configured=False, viewer_only=True, viewer_world=world,
                              panorama_editor_configured=False, phone_ar=False,
                              streetview={'configured': False, 'ai_authorized': False, 'available': False})
                job['can_resume'] = False
                # Fail closed if a backend unexpectedly includes its credential in metadata.
                if token in json.dumps([job, plan, config]):
                    raise ValueError('Unexpected private metadata.')
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                raise RuntimeError('Cannot open the selected world from the local backend. Start the backend and verify the world ID.') from None
            app.state.client, app.state.backend_token = client, token
            app.state.metadata = {job_path: job, plan_path: plan, '/world-config': config}
            app.state.asset_paths = assets
            try:
                yield
            finally:
                app.state.backend_token = ''

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def read_only_boundary(request: Request, call_next):
        if request.method not in ('GET', 'HEAD'):
            response = JSONResponse({'detail': 'This world viewer is read-only.'}, status_code=405,
                                    headers={'Allow': 'GET, HEAD'})
        else:
            response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Permissions-Policy'] = PERMISSIONS_POLICY
        if request.url.path.startswith(('/world-session', '/world-config', '/world-plans', '/world-jobs')):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.api_route('/{path:path}', methods=['GET', 'HEAD'])
    async def proxy(request: Request, path: str):
        route = '/' + path
        if not valid_path(route):
            return JSONResponse({'detail': 'Invalid path.'}, status_code=400)
        if route in ('/', '/world'):
            return RedirectResponse(f'/world/?viewer=1&world={world}', status_code=307)
        if route == '/world-session':
            return JSONResponse({'access_token': VIEWER_MARKER, 'viewer_only': True, 'world': world})
        protected = route.startswith(('/world-plans/', '/world-jobs/'))
        if protected and request.headers.get('authorization') != 'Bearer ' + VIEWER_MARKER:
            return JSONResponse({'detail': 'Open the public world viewer session first.'}, status_code=401)
        if route in app.state.metadata:
            return JSONResponse(app.state.metadata[route])
        static = route.startswith(('/world/', '/world-vendor/three/', '/world-vendor/@sparkjsdev/spark/'))
        asset = route in app.state.asset_paths
        if not static and not asset:
            return JSONResponse({'detail': 'Not found.'}, status_code=404)
        headers = {key: value for key, value in request.headers.items() if key.lower() in REQUEST_HEADERS}
        if asset:
            headers['authorization'] = 'Bearer ' + app.state.backend_token
        # URL queries carry only frontend state/cache busting and never reach upstream.
        destination = upstream_url.copy_with(path=route)
        upstream_request = app.state.client.build_request(request.method, destination, headers=headers)
        # httpx remembers upstream Set-Cookie headers; never reuse those ambient credentials.
        upstream_request.headers.pop('cookie', None)
        try:
            response = await app.state.client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            return JSONResponse({'detail': 'The world viewer backend is unavailable.'}, status_code=502)
        if response.is_redirect or response.status_code >= 400:
            status = response.status_code if response.status_code in (404, 416) else 502
            await response.aclose()
            return JSONResponse({'detail': 'The requested world resource is unavailable.'}, status_code=status)
        outgoing = {key: value for key, value in response.headers.items() if key.lower() in RESPONSE_HEADERS}

        async def body():
            try:
                async for chunk in response.aiter_raw():
                    yield chunk
            finally:
                await response.aclose()

        return StreamingResponse(body(), status_code=response.status_code, headers=outgoing,
                                 background=BackgroundTask(response.aclose))

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--world', required=True, help='Existing world job ID to publish')
    parser.add_argument('--port', type=int, default=8003)
    parser.add_argument('--upstream', default='http://127.0.0.1:8001')
    args = parser.parse_args()
    try:
        app = create_app(world=args.world, port=args.port, upstream=args.upstream)
    except ValueError as exc:
        parser.error(str(exc))
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, proxy_headers=False)


if __name__ == '__main__':
    main()
