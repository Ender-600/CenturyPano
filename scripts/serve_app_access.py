"""Serve all four app modes behind an existing WORLD_ACCESS_TOKEN.

Run behind an HTTPS tunnel. Vercel rewrites the API paths to this gateway;
--public-origin must include the Vercel site origin for cookie-authenticated
mutations. Credentials stay in a Secure, HttpOnly cookie and are revalidated by
the backend on every private request. This process never starts workers.
"""
from __future__ import annotations

import argparse
import base64
import binascii
from contextlib import asynccontextmanager
import json
import re
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
import httpx
from starlette.background import BackgroundTask
import uvicorn

if __package__:
    from .serve_world_access import REQUEST_HEADERS, RESPONSE_HEADERS, valid_path, validate_settings
else:
    from serve_world_access import REQUEST_HEADERS, RESPONSE_HEADERS, valid_path, validate_settings


MAX_JSON_BYTES = 256 * 1024
MAX_UPLOAD_BYTES = 41 * 1024 * 1024
SESSION_COOKIE = '__Host-century_pano_session'
SESSION_SECONDS = 12 * 60 * 60
STATIC_PATHS = {
    '/', '/index.html', '/app.js', '/access.js', '/capture.js', '/motion.js',
    '/mode-tabs.js', '/sw.js', '/style.css', '/scene.svg', '/window-scene.png',
    '/world/', '/world/index.html', '/world/app.js', '/world/prefetch.js',
    '/world/location.js', '/world/motion.js', '/world/gps-walking.js', '/world/scale.js',
    '/world/style.css', '/world/panorama.js', '/world/orientation.js',
    '/world/year-wheel.js', '/world/edits-example.json',
    '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
    '/vendor/leaflet/images/marker-shadow.png', '/vendor/leaflet/images/marker-icon.png',
    '/vendor/leaflet/images/marker-icon-2x.png',
}
STATIC_PREFIXES = ('/world-vendor/three/', '/world-vendor/@sparkjsdev/spark/')
READ = ('GET', 'HEAD')
API_ROUTES = (
    (re.compile(r'/(health|replays|world-config|world-auth)'), READ),
    (re.compile(r'/(preview|jobs|location/resolve|world-prefetch|world-plans|world-jobs)'), ('POST',)),
    (re.compile(r'/jobs/[^/]+/(manifest|preview|result|tiles/[0-7])'), READ),
    (re.compile(r'/jobs/[^/]+/(explain|hotspots|baseline)'), ('POST',)),
    (re.compile(r'/out/[^/]+/.+'), READ),
    (re.compile(r'/world-(plans|jobs)/[^/]+(/assets/[^/]+)?'), READ),
    (re.compile(r'/world-plans/[^/]+/edits'), ('POST',)),
    (re.compile(r'/world-jobs/[^/]+/(cancel|resume)'), ('POST',)),
)


def normalize_origin(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('Public origins must be HTTP(S) origins without a path.')
    port = parsed.port
    host = parsed.hostname.lower()
    if ':' in host:
        host = f'[{host}]'
    suffix = f':{port}' if port is not None and port != (443 if parsed.scheme == 'https' else 80) else ''
    return f'{parsed.scheme}://{host}{suffix}'


def valid_token(value: object) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 1024 and all(32 < ord(c) < 127 for c in value)


def request_credential(request: Request) -> tuple[str | None, bool]:
    """Explicit bearer auth takes precedence; never fall back from invalid auth."""
    authorization = request.headers.getlist('authorization')
    if authorization:
        if len(authorization) != 1:
            raise HTTPException(400, 'Invalid authorization header.')
        scheme, _, token = authorization[0].partition(' ')
        return (token if scheme.lower() == 'bearer' and valid_token(token) else None), False
    encoded = request.cookies.get(SESSION_COOKIE)
    if not encoded or len(encoded) > 1400:
        return None, False
    # Ambiguous cookies are not accepted, including duplicate Cookie headers.
    count = sum(part.strip().partition('=')[0] == SESSION_COOKIE
                for header in request.headers.getlist('cookie') for part in header.split(';'))
    if count != 1:
        return None, True
    try:
        token = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True).decode('ascii')
    except (ValueError, UnicodeError, binascii.Error):
        return None, True
    return (token if valid_token(token) else None), True


async def read_body(request: Request, limit: int) -> bytes:
    length = request.headers.get('content-length')
    if length is not None:
        if not length.isascii() or not length.isdigit():
            raise HTTPException(400, 'Invalid Content-Length.')
        if int(length) > limit:
            raise HTTPException(413, 'The request is too large.')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(413, 'The request is too large.')
    return bytes(body)


def create_app(*, port: int = 8005, upstream: str = 'http://127.0.0.1:8001',
               public_origins: tuple[str, ...] = (),
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    upstream_url = validate_settings(port, upstream)
    origins = {normalize_origin(origin) for origin in public_origins}

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                     timeout=httpx.Timeout(180, connect=5)) as client:
            app.state.client = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        response.headers['Permissions-Policy'] = (
            'camera=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)')
        return response

    def check_origin(request: Request, *, required: bool):
        origin = request.headers.get('origin')
        try:
            valid = origin is not None and normalize_origin(origin) in {
                *origins, normalize_origin(str(request.base_url))}
        except ValueError:
            valid = False
        if (required and not valid or origin is not None and not valid
                or request.headers.get('sec-fetch-site') == 'cross-site'):
            raise HTTPException(403, 'This request must come from the application.')

    async def validate_access(token: str | None):
        if token is None:
            raise HTTPException(401, 'Enter the application access code.')
        check = app.state.client.build_request('GET', upstream_url.copy_with(path='/world-auth'),
                                               headers={'authorization': 'Bearer ' + token})
        check.headers.pop('cookie', None)
        try:
            response = await app.state.client.send(check)
        except httpx.HTTPError:
            raise HTTPException(502, 'The application backend is unavailable.') from None
        try:
            if response.status_code in (401, 403):
                raise HTTPException(401, 'The application access code is not valid.')
            if response.status_code == 200 and response.json() == {'authenticated': True}:
                return
        except ValueError:
            pass
        finally:
            await response.aclose()
        raise HTTPException(502, 'The application backend is unavailable.')

    def clear_session(response: JSONResponse):
        response.delete_cookie(SESSION_COOKIE, path='/', secure=True, httponly=True, samesite='strict')
        return response

    @app.api_route('/app-session', methods=['GET', 'POST', 'DELETE'])
    async def session(request: Request):
        if request.method == 'DELETE':
            check_origin(request, required=True)
            return clear_session(JSONResponse({'authenticated': False}))
        if request.method == 'POST':
            check_origin(request, required=False)
            try:
                payload = json.loads(await read_body(request, MAX_JSON_BYTES))
            except (ValueError, UnicodeError):
                raise HTTPException(400, 'Send an application access code.') from None
            if not isinstance(payload, dict) or set(payload) != {'access_code'} or not valid_token(payload['access_code']):
                raise HTTPException(400, 'Send an application access code.')
            token = payload['access_code']
            await validate_access(token)
            response = JSONResponse({'authenticated': True})
            encoded = base64.urlsafe_b64encode(token.encode('ascii')).decode('ascii').rstrip('=')
            response.set_cookie(SESSION_COOKIE, encoded, max_age=SESSION_SECONDS, path='/',
                                secure=True, httponly=True, samesite='strict')
            return response
        token, _ = request_credential(request)
        try:
            await validate_access(token)
        except HTTPException as exc:
            if exc.status_code == 401:
                return clear_session(JSONResponse({'authenticated': False}, status_code=401))
            raise
        return JSONResponse({'authenticated': True})

    @app.api_route('/{path:path}', methods=['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'])
    async def proxy(request: Request, path: str):
        route = '/' + path
        if not valid_path(route):
            raise HTTPException(400, 'Invalid path.')
        if route == '/world-session':
            raise HTTPException(403, 'Remote access requires a separate access code.')
        if route == '/world' and request.method in READ:
            return RedirectResponse('/world/', status_code=307)
        static = route in STATIC_PATHS or route.startswith(STATIC_PREFIXES)
        allowed = READ if static else next((methods for pattern, methods in API_ROUTES
                                            if pattern.fullmatch(route)), None)
        if allowed is None:
            raise HTTPException(404, 'Not found.')
        if request.method not in allowed:
            raise HTTPException(405, 'Method not allowed.', headers={'Allow': ', '.join(allowed)})
        token = None
        if not static and route != '/world-config':
            token, from_cookie = request_credential(request)
            if from_cookie and request.method not in READ:
                check_origin(request, required=True)
            await validate_access(token)
        body = await read_body(request, MAX_UPLOAD_BYTES if route in ('/preview', '/jobs') else MAX_JSON_BYTES)
        headers = {key: value for key, value in request.headers.items() if key.lower() in REQUEST_HEADERS}
        if token is not None:
            headers['authorization'] = 'Bearer ' + token
        destination = upstream_url.copy_with(path=route, query=request.scope.get('query_string', b''))
        upstream_request = app.state.client.build_request(request.method, destination,
                                                         headers=headers, content=body)
        upstream_request.headers.pop('cookie', None)
        try:
            response = await app.state.client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            raise HTTPException(502, 'The application backend is unavailable.') from None
        if response.is_redirect or response.status_code >= 500:
            await response.aclose()
            raise HTTPException(502, 'The application backend response is unavailable.')
        outgoing = {key: value for key, value in response.headers.items() if key.lower() in RESPONSE_HEADERS}

        async def response_body():
            try:
                async for chunk in response.aiter_raw():
                    yield chunk
            finally:
                await response.aclose()

        return StreamingResponse(response_body(), status_code=response.status_code, headers=outgoing,
                                 background=BackgroundTask(response.aclose))

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8005)
    parser.add_argument('--upstream', default='http://127.0.0.1:8001')
    parser.add_argument('--public-origin', action='append', default=[])
    args = parser.parse_args()
    try:
        app = create_app(port=args.port, upstream=args.upstream, public_origins=tuple(args.public_origin))
    except ValueError as exc:
        parser.error(str(exc))
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, proxy_headers=False)


if __name__ == '__main__':
    main()
