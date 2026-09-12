"""Share the existing world backend with one explicitly selected private LAN.

Start the normal backend first, then run, for example:
  .venv/bin/python scripts/serve_world_lan.py \
      --host 192.168.1.10 --network 192.168.1.0/24 --port 8002
Open http://192.168.1.10:8002/world/ on the same Wi-Fi. The gateway retrieves
the backend's local session once; its separate, temporary LAN session never
contains the backend access code or provider keys. It runs no generation jobs.
Stop the gateway to revoke its LAN session. HTTP does not provide the secure
context that phone browsers require for GPS and motion sensors.
"""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from ipaddress import IPv4Address, IPv4Network
import secrets
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
import httpx
from starlette.background import BackgroundTask
import uvicorn


PRIVATE_NETWORKS = tuple(IPv4Network(cidr) for cidr in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
REQUEST_HEADERS = {'accept', 'accept-encoding', 'content-type', 'content-length',
                   'range', 'if-range', 'if-none-match', 'if-modified-since'}
RESPONSE_HEADERS = {'content-type', 'content-length', 'content-encoding', 'content-range',
                    'accept-ranges', 'etag', 'last-modified', 'cache-control', 'expires',
                    'vary', 'content-disposition', 'permissions-policy'}


def validate_settings(host: str, network: str, port: int, upstream: str):
    """Require a literal RFC1918 interface and a contained, explicit LAN subnet."""
    address, subnet = IPv4Address(host), IPv4Network(network)
    if str(address) != host or not any(subnet.subnet_of(private) for private in PRIVATE_NETWORKS):
        raise ValueError('Use an RFC1918 IPv4 address and subnet, never all interfaces.')
    if address not in subnet or not 1 <= port <= 65535:
        raise ValueError('The bind address must belong to the LAN subnet and the port must be valid.')
    parsed = urlsplit(upstream)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('The upstream must be an HTTP origin on 127.0.0.1.')
    # Accessing .port also validates invalid ports without ever fetching a URL.
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError('Invalid upstream port.')
    return address, subnet, httpx.URL(upstream.rstrip('/'))


def create_app(*, host: str, network: str, port: int = 8002,
               upstream: str = 'http://127.0.0.1:8001',
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    address, subnet, upstream_url = validate_settings(host, network, port, upstream)
    authority = str(address) if port == 80 else f'{address}:{port}'
    origin = f'http://{authority}'

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                     timeout=httpx.Timeout(180, connect=5)) as client:
            try:
                response = await client.get(upstream_url.copy_with(path='/world-session'))
                response.raise_for_status()
                backend_token = response.json()['access_token']
                if (not isinstance(backend_token, str) or not 16 <= len(backend_token) <= 512
                        or not backend_token.isascii() or not all(32 < ord(c) < 127 for c in backend_token)):
                    raise ValueError('Invalid session.')
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                # Do not include response bodies, credentials, or request headers in errors.
                raise RuntimeError('Cannot connect to the local world backend session. Start it first.') from None
            app.state.client = client
            app.state.backend_token = backend_token
            app.state.lan_token = secrets.token_urlsafe(32)
            try:
                yield
            finally:
                app.state.backend_token = app.state.lan_token = ''

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def lan_boundary(request: Request, call_next):
        try:
            allowed_client = request.client is not None and IPv4Address(request.client.host) in subnet
        except ValueError:
            allowed_client = False
        request_origin = request.headers.get('origin')
        if (not allowed_client or request.headers.getlist('host') != [authority]
                or request_origin is not None and request_origin != origin
                or request.headers.get('sec-fetch-site', 'none') not in ('same-origin', 'none')):
            return JSONResponse({'detail': 'This gateway is available only from its selected LAN origin.'},
                                status_code=403, headers={'Cache-Control': 'no-store'})
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        if request.url.path.startswith(('/world-session', '/world-config', '/world-plans', '/world-jobs')):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.api_route('/{path:path}', methods=['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])
    async def proxy(request: Request, path: str):
        route = '/' + path
        if ('\\' in route or '%' in route or '//' in route
                or any(part in ('.', '..') for part in route.split('/'))
                or any(ord(character) < 32 for character in route)):
            return JSONResponse({'detail': 'Invalid path.'}, status_code=400)
        if route in ('/', '/world') and request.method in ('GET', 'HEAD'):
            return RedirectResponse('/world/', status_code=307)
        if route == '/world-session':
            if request.method != 'GET':
                return JSONResponse({'detail': 'Method not allowed.'}, status_code=405)
            return JSONResponse({'access_token': app.state.lan_token})
        protected = any(route == prefix or route.startswith(prefix + '/')
                        for prefix in ('/world-plans', '/world-jobs'))
        static = route.startswith(('/world/', '/world-vendor/three/', '/world-vendor/@sparkjsdev/spark/'))
        if not protected and not (route == '/world-config' or static):
            return JSONResponse({'detail': 'Not found.'}, status_code=404)
        if not protected and request.method not in ('GET', 'HEAD'):
            return JSONResponse({'detail': 'Method not allowed.'}, status_code=405)
        if protected and not secrets.compare_digest(request.headers.get('authorization', '').encode(),
                                                    ('Bearer ' + app.state.lan_token).encode()):
            return JSONResponse({'detail': 'Connect to the LAN session first.'}, status_code=401)
        headers = {key: value for key, value in request.headers.items() if key.lower() in REQUEST_HEADERS}
        if protected:
            headers['authorization'] = 'Bearer ' + app.state.backend_token
        destination = upstream_url.copy_with(path=route, query=request.scope.get('query_string', b''))
        upstream_request = app.state.client.build_request(request.method, destination, headers=headers,
                                                         content=request.stream())
        try:
            response = await app.state.client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            return JSONResponse({'detail': 'The local world backend is unavailable.'}, status_code=502)
        if response.is_redirect:
            await response.aclose()
            return JSONResponse({'detail': 'Unexpected upstream redirect.'}, status_code=502)
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
    parser.add_argument('--host', required=True, help='Literal RFC1918 IPv4 address of the Wi-Fi interface')
    parser.add_argument('--network', required=True, help='Actual Wi-Fi IPv4 network in CIDR notation')
    parser.add_argument('--port', type=int, default=8002)
    parser.add_argument('--upstream', default='http://127.0.0.1:8001')
    args = parser.parse_args()
    try:
        app = create_app(host=args.host, network=args.network, port=args.port, upstream=args.upstream)
    except ValueError as exc:
        parser.error(str(exc))
    # Peer checks must use socket addresses, never X-Forwarded-For supplied by clients.
    uvicorn.run(app, host=args.host, port=args.port, access_log=False, proxy_headers=False)


if __name__ == '__main__':
    main()
