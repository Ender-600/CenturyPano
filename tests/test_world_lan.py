"""LAN boundary, session isolation, and streaming proxy tests without real keys."""
import gzip

from fastapi.testclient import TestClient
import httpx
import pytest

from scripts.serve_world_lan import create_app, validate_settings


HOST = '192.168.10.5'
ORIGIN = f'http://{HOST}:8002'
BACKEND_TOKEN = 'backend-only-test-access-token'


class Chunks(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data
        self.closed = False

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
        if request.url.path == '/world-session':
            return httpx.Response(200, json={'access_token': BACKEND_TOKEN})
        if request.url.path.endswith('/redirect'):
            return httpx.Response(307, headers={'location': 'https://external.example/'})
        data = binary if request.url.path.endswith('.glb') else b'{"ok":true}'
        headers = {'content-type': 'model/gltf-binary' if data is binary else 'application/json',
                   'x-forwarded-for': 'secret-proxy-data', 'set-cookie': 'private=value',
                   'authorization': 'Bearer ' + BACKEND_TOKEN}
        if request.url.params.get('gzip'):
            data = gzip.compress(data)
            headers['content-encoding'] = 'gzip'
        headers['content-length'] = str(len(data))
        stream = Chunks(data)
        streams.append(stream)
        return httpx.Response(200, headers=headers, stream=stream)

    app = create_app(host=HOST, network='192.168.10.0/24', transport=httpx.MockTransport(backend))
    return app, calls, streams, binary


def connect(app, peer='192.168.10.8'):
    return TestClient(app, base_url=ORIGIN, client=(peer, 49152), follow_redirects=False)


@pytest.mark.parametrize('host,network,upstream', [
    ('0.0.0.0', '0.0.0.0/0', 'http://127.0.0.1:8001'),
    ('127.0.0.1', '127.0.0.0/8', 'http://127.0.0.1:8001'),
    ('192.168.10.5', '192.168.11.0/24', 'http://127.0.0.1:8001'),
    ('192.168.10.5', '192.0.0.0/8', 'http://127.0.0.1:8001'),
    ('192.168.10.5', '192.168.10.0/24', 'http://public.example'),
    ('192.168.10.5', '192.168.10.0/24', 'http://key@127.0.0.1:8001'),
    ('192.168.10.5', '192.168.10.0/24', 'http://127.0.0.1:8001/path'),
])
def test_invalid_listener_or_upstream_is_rejected(host, network, upstream):
    with pytest.raises(ValueError):
        validate_settings(host, network, 8002, upstream)


@pytest.mark.parametrize('peer,headers', [
    ('192.168.11.8', {}), ('127.0.0.1', {}), ('203.0.113.4', {}),
    ('192.168.10.8', {'host': 'attacker.example:8002'}),
    ('192.168.10.8', {'host': f'{HOST}:8001'}),
    ('192.168.10.8', {'origin': 'https://attacker.example'}),
    ('192.168.10.8', {'origin': 'null'}),
    ('192.168.10.8', {'sec-fetch-site': 'cross-site'}),
    ('192.168.10.8', {'sec-fetch-site': 'same-site'}),
    ('203.0.113.4', {'x-forwarded-for': '192.168.10.8'}),
])
def test_lan_boundary_checks_peer_host_and_browser_origin(gateway, peer, headers):
    app, calls, _, _ = gateway
    with connect(app, peer) as client:
        for path in ('/world/', '/world-session', '/world-config', '/world-jobs'):
            assert client.get(path, headers=headers).status_code == 403
    assert len(calls) == 1  # Only the trusted startup session request reached the backend.


def test_lan_bearer_replaces_backend_bearer_and_strips_credentials(gateway):
    app, calls, _, _ = gateway
    with connect(app) as client:
        session = client.get('/world-session', headers={'origin': ORIGIN, 'sec-fetch-site': 'same-origin'})
        token = session.json()['access_token']
        assert session.headers['cache-control'] == 'no-store'
        assert token != BACKEND_TOKEN and BACKEND_TOKEN not in session.text
        assert client.get('/world-plans/example').status_code == 401
        assert client.get('/world-plans/example', headers={'authorization': 'Bearer ' + BACKEND_TOKEN}).status_code == 401
        response = client.post('/world-plans?mode=test', json={'year': 1925}, headers={
            'authorization': 'Bearer ' + token, 'cookie': 'access=private', 'x-forwarded-for': 'public',
            'forwarded': 'host=public', 'proxy-authorization': 'Basic private', 'x-api-key': 'private'})
        assert response.status_code == 200
        upstream = calls[-1]
        assert upstream.headers['authorization'] == 'Bearer ' + BACKEND_TOKEN
        assert upstream.url == 'http://127.0.0.1:8001/world-plans?mode=test'
        assert upstream.content == b'{"year":1925}'
        for name in ('cookie', 'x-forwarded-for', 'forwarded', 'proxy-authorization', 'x-api-key'):
            assert name not in upstream.headers
        for name in ('authorization', 'set-cookie', 'x-forwarded-for'):
            assert name not in response.headers
        assert response.headers['cache-control'] == 'no-store'
    assert app.state.lan_token == app.state.backend_token == ''


def test_static_assets_do_not_receive_auth_and_binary_stream_keeps_encoding(gateway):
    app, calls, streams, binary = gateway
    with connect(app) as client:
        token = client.get('/world-session').json()['access_token']
        for path in ('/world/', '/world/app.js', '/world-vendor/three/build/three.module.js',
                     '/world-vendor/@sparkjsdev/spark/dist/spark.module.js', '/world-config'):
            response = client.get(path, headers={'authorization': 'Bearer ' + token})
            assert response.status_code == 200
            assert 'authorization' not in calls[-1].headers
        response = client.get('/world-jobs/example/assets/world.glb?gzip=1',
                              headers={'authorization': 'Bearer ' + token, 'range': 'bytes=0-'})
        assert response.content == binary
        assert response.headers['content-encoding'] == 'gzip'
        assert int(response.headers['content-length']) == len(gzip.compress(binary))
        assert calls[-1].headers['range'] == 'bytes=0-'
        assert all(stream.closed for stream in streams)


def test_disallowed_paths_and_redirects_cannot_escape_world_routes(gateway):
    app, calls, _, _ = gateway
    with connect(app) as client:
        assert client.get('/').headers['location'] == '/world/'
        for path in ('/.env', '/jobs', '/health', '/world-vendor/unrelated/file', '/world-jobs-evil'):
            assert client.get(path).status_code == 404
        for path in ('/world/%2e%2e/world-session', '/world/%252e%252e/world-session', '/world/%5csecret'):
            assert client.get(path).status_code == 400
        assert client.get('/world/redirect').status_code == 502
        assert client.post('/world-session').status_code == 405
        assert client.post('/world/config.js').status_code == 405
    assert len(calls) == 2
