"""Public four-mode gateway boundaries, using only mocked providers and codes."""
import gzip

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

from scripts.serve_app_access import (
    MAX_JSON_BYTES, MAX_UPLOAD_BYTES, SESSION_COOKIE, create_app, normalize_origin,
)


TOKEN = 'test-only-full-app-code'
AUTH = {'authorization': 'Bearer ' + TOKEN}
ORIGIN = 'https://century.example'


class Chunks(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data, self.closed = data, False

    async def __aiter__(self):
        for offset in range(0, len(self.data), 1024):
            yield self.data[offset:offset + 1024]

    async def aclose(self):
        self.closed = True


@pytest.fixture
def gateway(request):
    calls, streams = [], []
    state = {'token': TOKEN, 'auth_status': 200}
    binary = b'glTF' + bytes(range(256)) * 1000

    async def backend(request):
        calls.append(request)
        route = request.url.path
        if route == '/world-auth':
            if request.headers.get('authorization') != 'Bearer ' + state['token']:
                return httpx.Response(401, json={'detail': 'private-auth-detail'})
            return httpx.Response(state['auth_status'], json={'authenticated': True},
                                  headers={'set-cookie': 'upstream_auth=private'})
        if route == '/jobs/redirect/manifest':
            return httpx.Response(307, headers={'location': 'https://external.example/'})
        if route == '/jobs/error/manifest':
            return httpx.Response(500, text='private-backend-error')
        if route == '/jobs/offline/manifest':
            raise httpx.ConnectError('private connection detail', request=request)
        if route == '/jobs/missing/manifest':
            return httpx.Response(404, stream=Chunks(b'{"detail":"Job not found."}'))
        data = binary if route.endswith(('.glb', '.jpg')) else b'{"ok":true}'
        headers = {'content-type': 'application/octet-stream' if data is binary else 'application/json',
                   'set-cookie': 'access=private', 'authorization': AUTH['authorization'],
                   'x-private': 'private', 'cache-control': 'public, max-age=86400'}
        status = 200
        if request.headers.get('range') == 'bytes=0-99':
            headers['content-range'] = f'bytes 0-99/{len(data)}'
            data, status = data[:100], 206
        if request.headers.get('accept-encoding') == 'gzip':
            data = gzip.compress(data)
            headers['content-encoding'] = 'gzip'
        headers['content-length'] = str(len(data))
        stream = Chunks(data)
        streams.append(stream)
        return httpx.Response(status, headers=headers, stream=stream)

    return create_app(public_origins=(ORIGIN,),
                      public_access_token=TOKEN if getattr(request, 'param', False) else None,
                      transport=httpx.MockTransport(backend)), calls, streams, binary, state


def login(client):
    return client.post('/app-session', json={'access_code': TOKEN}, headers={'origin': ORIGIN})


def test_explicit_backend_validator_requires_code_and_never_returns_it(monkeypatch):
    # No backend lifespan or workers are started for this authentication-only test.
    from app.config import settings
    from app.worlds.router import router
    monkeypatch.setattr(settings, 'world_access_token', TOKEN)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        for headers in ({}, {'authorization': 'Bearer wrong'}):
            assert client.get('/world-auth', headers=headers).status_code == 401
        response = client.get('/world-auth', headers=AUTH)
        assert response.status_code == 200
        assert response.json() == {'authenticated': True}
        assert response.headers['cache-control'] == 'no-store'
        assert TOKEN not in response.text


def test_session_cookie_lifecycle_and_token_rotation(gateway):
    app, calls, _, _, state = gateway
    with TestClient(app, base_url=ORIGIN) as client:
        assert client.get('/app-session').json() == {'authenticated': False}
        assert calls == []
        response = login(client)
        assert response.status_code == 200
        assert response.json() == {'authenticated': True}
        cookie = response.headers['set-cookie']
        for attribute in (SESSION_COOKIE, 'HttpOnly', 'Secure', 'SameSite=strict', 'Path=/'):
            assert attribute in cookie
        assert 'Domain=' not in cookie and TOKEN not in response.text
        assert client.get('/app-session').json() == {'authenticated': True}
        assert client.get('/jobs/example/manifest').status_code == 200
        state['token'] = 'rotated-code'
        assert client.get('/jobs/example/manifest').status_code == 401
        assert client.get('/app-session').status_code == 401
        assert SESSION_COOKIE not in client.cookies
        state['token'] = TOKEN
        assert login(client).status_code == 200
        assert client.delete('/app-session', headers={'origin': ORIGIN}).json() == {'authenticated': False}
        assert SESSION_COOKIE not in client.cookies
        assert client.get('/jobs/example/manifest').status_code == 401
    assert app.state.client.is_closed
    assert all(request.url.path != '/world-session' for request in calls)


def test_login_rejects_invalid_codes_payloads_and_upstream_failures(gateway):
    app, calls, _, _, state = gateway
    with TestClient(app, base_url=ORIGIN) as client:
        for payload in ({}, [], {'access_code': ''}, {'access_code': '\r\nsecret'},
                        {'access_code': 'ü'}, {'access_code': TOKEN, 'extra': True},
                        {'access_code': 123}, {'access_code': 'x' * 1025}):
            assert client.post('/app-session', json=payload).status_code == 400
        assert client.post('/app-session', content=b'{').status_code == 400
        assert calls == []
        response = client.post('/app-session', json={'access_code': 'wrong'})
        assert response.status_code == 401
        assert 'private' not in response.text and 'set-cookie' not in response.headers
        for status in (301, 404, 500):
            state['auth_status'] = status
            response = login(client)
            assert response.status_code == 502
            assert 'set-cookie' not in response.headers


PRIVATE_ROUTES = (
    ('GET', '/health'), ('GET', '/replays'), ('POST', '/preview'), ('POST', '/jobs'),
    ('POST', '/location/resolve'), ('GET', '/jobs/example/manifest'),
    ('GET', '/jobs/example/preview'), ('GET', '/jobs/example/tiles/0'),
    ('GET', '/jobs/example/result'), ('POST', '/jobs/example/explain'),
    ('POST', '/jobs/example/hotspots'), ('POST', '/jobs/example/baseline'),
    ('GET', '/out/example/weather/rain/result.jpg'),
    ('POST', '/world-prefetch'), ('POST', '/world-plans'),
    ('GET', '/world-plans/example'), ('POST', '/world-plans/example/edits'),
    ('GET', '/world-plans/example/assets/depth.png'), ('POST', '/world-jobs'),
    ('GET', '/world-jobs/example'), ('POST', '/world-jobs/example/cancel'),
    ('POST', '/world-jobs/example/resume'), ('GET', '/world-jobs/example/assets/world.glb'),
)


def test_every_private_route_requires_backend_validation_before_forwarding(gateway):
    app, calls, _, _, _ = gateway
    with TestClient(app, base_url=ORIGIN) as client:
        for method, route in PRIVATE_ROUTES:
            before = len(calls)
            assert client.request(method, route).status_code == 401
            assert len(calls) == before
            assert client.request(method, route, headers={'authorization': 'Bearer wrong'}).status_code == 401
            assert len(calls) == before + 1 and calls[-1].url.path == '/world-auth'
            response = client.request(method, route + '?mode=test', content=b'{}', headers={
                **AUTH, 'cookie': 'private=cookie', 'x-api-key': 'private',
                'x-forwarded-for': 'private', 'forwarded': 'host=private', 'proxy-authorization': 'private'})
            assert response.status_code == 200
            assert calls[-2].url.path == '/world-auth'
            assert calls[-1].url.path == route
            assert calls[-1].url.query == b'mode=test'
            assert calls[-1].content == b'{}'
            assert calls[-1].headers['authorization'] == AUTH['authorization']
            for header in ('cookie', 'x-api-key', 'x-forwarded-for', 'forwarded', 'proxy-authorization'):
                assert header not in calls[-1].headers
            for header in ('set-cookie', 'authorization', 'x-private'):
                assert header not in response.headers
            assert response.headers['cache-control'] == 'private, no-store'
        assert all('cookie' not in request.headers for request in calls)


def test_cookie_upload_and_private_image_use_same_session(gateway):
    app, calls, _, binary, _ = gateway
    with TestClient(app, base_url=ORIGIN) as client:
        assert login(client).status_code == 200
        response = client.post('/jobs', files={'image': ('photo.jpg', b'photo-bytes', 'image/jpeg')},
                               data={'target_year': '1925'}, headers={'origin': ORIGIN})
        assert response.status_code == 200
        assert b'photo-bytes' in calls[-1].content
        assert 'multipart/form-data; boundary=' in calls[-1].headers['content-type']
        assert client.get('/out/example/result.jpg').content == binary
        assert client.get('/jobs/example/manifest', headers={'authorization': 'Bearer wrong'}).status_code == 401


def test_cookie_csrf_and_session_login_origin_are_checked(gateway):
    app, calls, _, _, _ = gateway
    with TestClient(app, base_url='https://gateway.example') as client:
        for origin in ('https://evil.example', 'null', ORIGIN + '/other'):
            assert client.post('/app-session', json={'access_code': TOKEN}, headers={'origin': origin}).status_code == 403
        assert calls == []
        assert login(client).status_code == 200
        for headers in ({}, {'origin': 'https://evil.example'},
                        {'origin': ORIGIN, 'sec-fetch-site': 'cross-site'}):
            before = len(calls)
            assert client.post('/jobs', content=b'upload', headers=headers).status_code == 403
            assert client.delete('/app-session', headers=headers).status_code == 403
            assert len(calls) == before
        assert client.post('/jobs', content=b'upload', headers={'origin': ORIGIN}).status_code == 200
        assert client.post('/jobs', content=b'upload', headers=AUTH).status_code == 200
        assert client.delete('/app-session', headers={'origin': ORIGIN}).status_code == 200


def test_public_static_allowlist_does_not_expose_backend_or_credential_routes(gateway):
    app, calls, _, _, _ = gateway
    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as client:
        for route in ('/', '/index.html', '/app.js', '/access.js', '/mode-tabs.js', '/world/', '/world-config',
                      '/world/app.js', '/world/year-wheel.js', '/vendor/leaflet/leaflet.js',
                      '/world-vendor/three/build/three.module.js',
                      '/world-vendor/@sparkjsdev/spark/dist/spark.module.js'):
            assert client.get(route, headers=AUTH).status_code == 200
            assert 'authorization' not in calls[-1].headers
            assert 'cookie' not in calls[-1].headers
        assert client.get('/world').headers['location'] == '/world/'
        before = len(calls)
        for route in ('/.env', '/docs', '/openapi.json', '/anything', '/world/private.txt',
                      '/world-vendor/unrelated/file', '/world-jobs-evil', '/world-prefetch-evil',
                      '/jobs/example/delete', '/jobs/example/tiles/8', '/location/resolve/evil'):
            assert client.get(route, headers=AUTH).status_code == 404
        for method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'):
            assert client.request(method, '/world-session', headers=AUTH).status_code == 403
        for route in ('/world/%2e%2e/world-session', '/world/%252e%252e/world-session',
                      '/world/%5csecret', '/world/foo//bar', '/world/%00secret'):
            assert client.get(route, headers=AUTH).status_code == 400
        assert client.post('/app.js', headers=AUTH).status_code == 405
        assert client.delete('/world-jobs/example', headers=AUTH).status_code == 405
        assert len(calls) == before


def test_body_limits_and_ambiguous_credentials(gateway, monkeypatch):
    app, calls, _, _, _ = gateway
    assert MAX_UPLOAD_BYTES == 41 * 1024 * 1024
    # Exercise the same boundary without allocating repeated 41 MiB payloads.
    monkeypatch.setattr('scripts.serve_app_access.MAX_UPLOAD_BYTES', 1024)
    with TestClient(app, base_url=ORIGIN) as client:
        for route, limit in (('/jobs', 1024), ('/preview', 1024), ('/world-prefetch', MAX_JSON_BYTES)):
            before = len(calls)
            assert client.post(route, content=b'x' * (limit + 1), headers=AUTH).status_code == 413
            assert client.post(route, content=iter([b'x' * limit, b'x']), headers=AUTH).status_code == 413
            assert all(call.url.path == '/world-auth' for call in calls[before:])
            assert client.post(route, content=b'x' * limit, headers=AUTH).status_code == 200
        for length in ('invalid', '-1'):
            assert client.post('/jobs', content=b'{}', headers={**AUTH, 'content-length': length}).status_code == 400
        before = len(calls)
        assert client.get('/health', headers=[('authorization', AUTH['authorization']),
                                             ('authorization', 'Bearer wrong')]).status_code == 400
        for cookie in (SESSION_COOKIE + '=@@@', SESSION_COOKIE + '=abc; ' + SESSION_COOKIE + '=def'):
            assert client.get('/health', headers={'cookie': cookie}).status_code == 401
        assert len(calls) == before


def test_binary_ranges_encoding_close_and_generic_failures(gateway):
    app, calls, streams, binary, _ = gateway
    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as client:
        assert login(client).status_code == 200
        for route in ('/world-jobs/example/assets/world.glb', '/out/example/result.jpg'):
            response = client.get(route, headers={'accept-encoding': 'gzip'})
            assert response.content == binary
            assert response.headers['content-encoding'] == 'gzip'
            assert int(response.headers['content-length']) == len(gzip.compress(binary))
            response = client.get(route, headers={'range': 'bytes=0-99', 'accept-encoding': 'identity'})
            assert response.status_code == 206
            assert response.content == binary[:100]
            assert response.headers['content-range'] == f'bytes 0-99/{len(binary)}'
            assert calls[-1].headers['range'] == 'bytes=0-99'
        for route in ('/jobs/redirect/manifest', '/jobs/error/manifest', '/jobs/offline/manifest'):
            response = client.get(route)
            assert response.status_code == 502
            assert 'location' not in response.headers
            assert 'private' not in response.text
        assert client.get('/jobs/missing/manifest').status_code == 404
    assert all(stream.closed for stream in streams)


@pytest.mark.parametrize('origin', ['https://site.example/path', 'https://user:pw@site.example',
                                   'https://site.example?query=1', 'https://site.example#fragment',
                                   'file:///tmp', 'null', 'https://site.example:99999'])
def test_invalid_public_origins(origin):
    with pytest.raises(ValueError):
        create_app(public_origins=(origin,))


def test_origin_default_port_is_normalized():
    assert normalize_origin('https://SITE.example:443/') == 'https://site.example'


@pytest.mark.parametrize('gateway', [True], indirect=True)
def test_public_visitors_use_all_app_routes_without_credentials(gateway):
    app, calls, _, _, _ = gateway
    with TestClient(app, base_url=ORIGIN) as client:
        session = client.get('/app-session')
        assert session.status_code == 200
        assert session.json() == {'authenticated': True, 'access_mode': 'public'}
        assert TOKEN not in session.text and TOKEN not in session.headers.get('set-cookie', '')
        assert SESSION_COOKIE not in client.cookies
        for method, route in PRIVATE_ROUTES:
            response = client.request(method, route, headers={'origin': ORIGIN}, content=b'{}')
            assert response.status_code == 200, route
            assert calls[-1].headers['authorization'] == AUTH['authorization']
            assert 'cookie' not in calls[-1].headers
            assert TOKEN not in response.text
            assert not {'authorization', 'set-cookie', 'x-private'}.intersection(response.headers)
        # A cookie or bearer left over from the private deployment is irrelevant.
        assert client.get('/health', headers={'authorization': 'Bearer expired',
                                             'cookie': SESSION_COOKIE + '=expired'}).status_code == 200
        assert calls[-1].headers['authorization'] == AUTH['authorization']


@pytest.mark.parametrize('gateway', [True], indirect=True)
def test_public_mode_retains_origin_body_and_route_boundaries(gateway):
    app, calls, _, _, _ = gateway
    with TestClient(app, base_url=ORIGIN) as client:
        for headers in ({}, {'origin': 'https://evil.example'},
                        {'origin': ORIGIN, 'sec-fetch-site': 'cross-site'}):
            assert client.post('/jobs', headers=headers).status_code == 403
        assert calls == []
        assert client.post('/preview', content=b'', headers={
            'origin': ORIGIN, 'content-length': str(MAX_UPLOAD_BYTES + 1)}).status_code == 413
        assert client.get('/world-session').status_code == 403
        assert client.get('/.env').status_code == 404
        assert client.get('/openapi.json').status_code == 404
        assert client.get('/world-jobs-evil').status_code == 404


@pytest.mark.parametrize('gateway', [True], indirect=True)
def test_public_backend_failure_never_asks_visitor_for_a_code(gateway):
    app, _, _, _, state = gateway
    state['token'] = 'different-backend-code'
    with TestClient(app, base_url=ORIGIN) as client:
        for route in ('/app-session', '/health'):
            response = client.get(route)
            assert response.status_code == 502
            assert 'access code' not in response.text
            assert TOKEN not in response.text


@pytest.mark.parametrize('token', ['', 'bad\r\nvalue', 'x' * 1025])
def test_public_mode_requires_a_valid_server_side_credential(token):
    with pytest.raises(ValueError, match='WORLD_ACCESS_TOKEN'):
        create_app(public_access_token=token)
