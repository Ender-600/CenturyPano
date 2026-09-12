"""Expose the authenticated world app through a loopback HTTPS-tunnel gateway.

Point the tunnel at http://127.0.0.1:8004 and open /world/. The browser supplies
the existing world access code; this process never obtains or stores it and
never starts generation workers. Legacy upload APIs are not exposed.
"""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
import httpx
from starlette.background import BackgroundTask
import uvicorn


MAX_BODY_BYTES = 256 * 1024
REQUEST_HEADERS = {'accept', 'accept-encoding', 'content-type', 'range', 'if-range',
                   'if-none-match', 'if-modified-since'}
RESPONSE_HEADERS = {'content-type', 'content-length', 'content-encoding', 'content-range',
                    'accept-ranges', 'etag', 'last-modified', 'vary', 'allow'}
PERMISSIONS_POLICY = 'geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)'


def validate_settings(port: int, upstream: str) -> httpx.URL:
    if not 1 <= port <= 65535:
        raise ValueError('Invalid gateway port.')
    parsed = urlsplit(upstream)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or parsed.port is not None and not 1 <= parsed.port <= 65535):
        raise ValueError('The upstream must be an HTTP origin on 127.0.0.1.')
    if parsed.port == port:
        raise ValueError('The gateway and backend need separate ports.')
    return httpx.URL(upstream.rstrip('/'))


def valid_path(path: str) -> bool:
    return (path.startswith('/') and not any(c in path for c in ('\\', '%', '?', '#'))
            and '//' not in path and not any(part in ('.', '..') for part in path.split('/'))
            and all(32 < ord(c) < 127 for c in path))


def create_app(*, port: int = 8004, upstream: str = 'http://127.0.0.1:8001',
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    upstream_url = validate_settings(port, upstream)

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
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Permissions-Policy'] = PERMISSIONS_POLICY
        return response

    @app.api_route('/{path:path}', methods=['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'])
    async def proxy(request: Request, path: str):
        route = '/' + path
        if not valid_path(route):
            return JSONResponse({'detail': 'Invalid path.'}, status_code=400)
        if route in ('/', '/world') and request.method in ('GET', 'HEAD'):
            return RedirectResponse('/world/', status_code=307)
        if route == '/world-session':
            return JSONResponse({'detail': 'Remote access requires a separate access code.'}, status_code=403)
        protected = any(route == prefix or route.startswith(prefix + '/')
                        for prefix in ('/world-plans', '/world-jobs', '/world-prefetch'))
        static = route.startswith(('/world/', '/world-vendor/three/', '/world-vendor/@sparkjsdev/spark/'))
        if not protected and not (route == '/world-config' or static):
            return JSONResponse({'detail': 'Not found.'}, status_code=404)
        allowed = ('GET', 'HEAD', 'POST', 'PATCH') if protected else ('GET', 'HEAD')
        if request.method not in allowed:
            return JSONResponse({'detail': 'Method not allowed.'}, status_code=405,
                                headers={'Allow': ', '.join(allowed)})
        if len(request.headers.getlist('authorization')) > 1:
            return JSONResponse({'detail': 'Invalid authorization header.'}, status_code=400)
        try:
            if int(request.headers.get('content-length', '0')) > MAX_BODY_BYTES:
                return JSONResponse({'detail': 'The world request is too large.'}, status_code=413)
        except ValueError:
            return JSONResponse({'detail': 'Invalid Content-Length.'}, status_code=400)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BODY_BYTES:
                return JSONResponse({'detail': 'The world request is too large.'}, status_code=413)
        headers = {key: value for key, value in request.headers.items() if key.lower() in REQUEST_HEADERS}
        if protected and 'authorization' in request.headers:
            # The existing backend is the sole authority for accepting a code.
            headers['authorization'] = request.headers['authorization']
        destination = upstream_url.copy_with(path=route, query=request.scope.get('query_string', b''))
        upstream_request = app.state.client.build_request(request.method, destination, headers=headers,
                                                         content=bytes(body))
        # A response may populate httpx's cookie jar. Never reuse ambient auth.
        upstream_request.headers.pop('cookie', None)
        try:
            response = await app.state.client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            return JSONResponse({'detail': 'The world backend is unavailable.'}, status_code=502)
        if response.is_redirect or response.status_code >= 500:
            await response.aclose()
            return JSONResponse({'detail': 'The world backend response is unavailable.'}, status_code=502)
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
    parser.add_argument('--port', type=int, default=8004)
    parser.add_argument('--upstream', default='http://127.0.0.1:8001')
    args = parser.parse_args()
    try:
        app = create_app(port=args.port, upstream=args.upstream)
    except ValueError as exc:
        parser.error(str(exc))
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, proxy_headers=False)


if __name__ == '__main__':
    main()
