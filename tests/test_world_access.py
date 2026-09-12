"""Authenticated tunnel gateway boundaries without workers or real credentials."""
import gzip

from fastapi.testclient import TestClient
import httpx
import pytest

from scripts.serve_world_access import MAX_BODY_BYTES, create_app, validate_settings


TOKEN = 'test-only-existing-backend-code'
AUTH = {'authorization': 'Bearer ' + TOKEN}


class Chunks(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data, self.closed = data, False

    async def __aiter__(self):
        for offset in range(0, len(self.data), 1024):
            yield self.data[offset:offset + 1024]

    async def aclose(self):
        self.closed = True


@pytest.fixture
def gateway():
    calls, streams = [], []
    binary = b'glTF' + bytes(range(256)) * 1000

    async def backend(request):
        calls.append(request)
        route = request.url.path
        if route.startswith(('/world-plans', '/world-jobs', '/world-prefetch')):
            if request.headers.get('authorization') != AUTH['authorization']:
                return httpx.Response(401, headers={'content-type': 'application/json'},
                                      stream=Chunks(b'{"detail":"Connect with an access code."}'))
        if route == '/world/redirect':
            return httpx.Response(307, headers={'location': 'https://external.example/'})
        if route == '/world/error':
            return httpx.Response(500, text='private-backend-error')
        if route == '/world/offline':
            raise httpx.ConnectError('private connection detail', request=request)
        if route == '/world-plans/missing':
            return httpx.Response(404, headers={'content-type': 'application/json'},
                                  stream=Chunks(b'{"detail":"Plan not found."}'))
        data = binary if route.endswith('.glb') else b'{"ok":true,"prefetch":{"available":true}}'
        headers = {'content-type': 'model/gltf-binary' if data is binary else 'application/json',
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

    return create_app(transport=httpx.MockTransport(backend)), calls, streams, binary


@pytest.mark.parametrize('port,upstream', [
    (0, 'http://127.0.0.1:8001'), (65536, 'http://127.0.0.1:8001'),
    (8004, 'https://127.0.0.1:8001'), (8004, 'http://public.example'),
    (8004, 'http://user@127.0.0.1:8001'), (8004, 'http://127.0.0.1:8001/path'),
    (8004, 'http://127.0.0.1:8001?secret=1'), (8004, 'http://127.0.0.1:8001#secret'),
    (8004, 'http://127.0.0.1:8004'), (8004, 'http://127.0.0.1:65536'),
])
def test_invalid_settings(port, upstream):
    with pytest.raises(ValueError):
        validate_settings(port, upstream)


def test_lifecycle_never_fetches_a_session_and_session_is_always_blocked(gateway):
    app, calls, _, _ = gateway
    with TestClient(app) as client:
        assert calls == []
        for method in ('GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'):
            response = client.request(method, '/world-session', headers=AUTH)
            assert response.status_code == 403
            assert response.headers['cache-control'] == 'no-store'
            assert TOKEN not in response.text
        assert calls == []
    assert app.state.client.is_closed


def test_protected_apis_forward_exact_auth_and_body_to_backend(gateway):
    app, calls, _, _ = gateway
    with TestClient(app) as client:
        for route in ('/world-plans', '/world-jobs', '/world-prefetch'):
            assert client.post(route, json={}).status_code == 401
            assert client.post(route, json={}, headers={'authorization': 'Bearer wrong'}).status_code == 401
            response = client.post(route + '?mode=test', json={'year': 1925}, headers={
                **AUTH, 'cookie': 'private=cookie', 'x-api-key': 'private',
                'x-forwarded-for': 'private', 'forwarded': 'host=private', 'proxy-authorization': 'private'})
            assert response.status_code == 200
            upstream = calls[-1]
            assert upstream.url == 'http://127.0.0.1:8001' + route + '?mode=test'
            assert upstream.content == b'{"year":1925}'
            assert upstream.headers['authorization'] == AUTH['authorization']
            for header in ('cookie', 'x-api-key', 'x-forwarded-for', 'forwarded', 'proxy-authorization'):
                assert header not in upstream.headers
            for header in ('set-cookie', 'authorization', 'x-private'):
                assert header not in response.headers
        assert client.patch('/world-plans/example', json={}, headers=AUTH).status_code == 200
        assert client.post('/world-jobs/example/cancel', json={}, headers=AUTH).status_code == 200
        assert client.get('/world-plans/missing', headers=AUTH).status_code == 404


def test_static_and_config_strip_auth_keep_latest_content_and_sensor_headers(gateway):
    app, calls, _, _ = gateway
    with TestClient(app) as client:
        for route in ('/world/', '/world/app.js', '/world/prefetch.js', '/world-config',
                      '/world-vendor/three/build/three.module.js',
                      '/world-vendor/@sparkjsdev/spark/dist/spark.module.js'):
            response = client.get(route + '?v=current', headers=AUTH)
            assert response.status_code == 200
            assert 'authorization' not in calls[-1].headers
            assert 'cookie' not in calls[-1].headers
            assert calls[-1].url.query == b'v=current'
            assert response.headers['cache-control'] == 'no-store'
            assert response.headers['referrer-policy'] == 'no-referrer'
            assert response.headers['x-content-type-options'] == 'nosniff'
            assert 'geolocation=(self)' in response.headers['permissions-policy']
            assert 'gyroscope=(self)' in response.headers['permissions-policy']
        assert client.get('/world-config').json()['prefetch']['available'] is True


def test_unrelated_routes_mutations_and_traversal_never_reach_backend(gateway):
    app, calls, _, _ = gateway
    with TestClient(app, follow_redirects=False) as client:
        for route in ('/', '/world'):
            assert client.get(route).headers['location'] == '/world/'
        for route in ('/.env', '/jobs', '/preview', '/health', '/docs', '/openapi.json',
                      '/world-vendor/unrelated/file', '/world-jobs-evil', '/world-prefetch-evil'):
            for method in ('GET', 'POST', 'PATCH'):
                assert client.request(method, route, headers=AUTH).status_code == 404
        for route in ('/world/%2e%2e/world-session', '/world/%252e%252e/world-session',
                      '/world/%5csecret', '/world/foo//bar', '/world/%00secret'):
            assert client.get(route, headers=AUTH).status_code == 400
        for route in ('/world/app.js', '/world-config'):
            assert client.post(route, headers=AUTH).status_code == 405
        for method in ('PUT', 'DELETE', 'OPTIONS', 'TRACE'):
            assert client.request(method, '/world-jobs/example', headers=AUTH).status_code == 405
    assert calls == []


def test_request_limit_including_chunked_bodies_and_duplicate_auth(gateway):
    app, calls, _, _ = gateway
    with TestClient(app) as client:
        response = client.post('/world-prefetch', content=b'x' * (MAX_BODY_BYTES + 1), headers=AUTH)
        assert response.status_code == 413
        response = client.post('/world-prefetch', content=iter([b'x' * MAX_BODY_BYTES, b'x']), headers=AUTH)
        assert response.status_code == 413
        response = client.post('/world-prefetch', content=b'{}', headers={**AUTH, 'content-length': 'invalid'})
        assert response.status_code == 400
        response = client.get('/world-jobs/example', headers=[('authorization', AUTH['authorization']),
                                                            ('authorization', 'Bearer wrong')])
        assert response.status_code == 400
        assert calls == []
        assert client.post('/world-prefetch', content=b'x' * MAX_BODY_BYTES, headers=AUTH).status_code == 200


def test_binary_ranges_encoding_and_stream_close(gateway):
    app, calls, streams, binary = gateway
    route = '/world-jobs/example/assets/world.glb'
    with TestClient(app) as client:
        response = client.get(route, headers={**AUTH, 'accept-encoding': 'gzip'})
        assert response.content == binary
        assert response.headers['content-encoding'] == 'gzip'
        assert int(response.headers['content-length']) == len(gzip.compress(binary))
        response = client.get(route, headers={**AUTH, 'range': 'bytes=0-99', 'accept-encoding': 'identity'})
        assert response.status_code == 206
        assert response.content == binary[:100]
        assert response.headers['content-range'] == f'bytes 0-99/{len(binary)}'
        assert calls[-1].headers['range'] == 'bytes=0-99'
    assert all(stream.closed for stream in streams)


def test_redirects_and_backend_failures_are_generic(gateway):
    app, calls, streams, _ = gateway
    with TestClient(app, follow_redirects=False) as client:
        for route in ('/world/redirect', '/world/error', '/world/offline'):
            response = client.get(route)
            assert response.status_code == 502
            assert 'location' not in response.headers
            assert 'private' not in response.text
            assert response.headers['cache-control'] == 'no-store'
    assert len(calls) == 3
    assert all(stream.closed for stream in streams)
