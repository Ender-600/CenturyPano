"""Read-only public sharing boundary and opaque asset streaming, using fake keys."""
import gzip

from fastapi.testclient import TestClient
import httpx
import pytest

from scripts.serve_world_viewer import VIEWER_MARKER, create_app, listed_assets, validate_settings


WORLD = 'a' * 32
PLAN = '12345678-1234-1234-1234-123456789012'
JOB_PATH = '/world-jobs/' + WORLD
PLAN_PATH = '/world-plans/' + PLAN
ASSET = JOB_PATH + '/assets/world.glb'
TOKEN = 'backend-test-secret-credential'
AUTH = {'authorization': 'Bearer ' + VIEWER_MARKER}


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
        if route == '/world-session':
            return httpx.Response(200, json={'access_token': TOKEN})
        if route == JOB_PATH:
            return httpx.Response(200, json={'job_id': WORLD, 'plan_id': PLAN, 'stage': 'ready', 'can_resume': True,
                                            'assets': [{'url': ASSET}], 'credits_after': 1000, 'prompt': 'private prompt'})
        if route == PLAN_PATH:
            return httpx.Response(200, json={'plan_id': PLAN, 'prompt': 'private prompt',
                                            'assets': {'modern.glb': PLAN_PATH + '/assets/modern.glb'}})
        if route == '/world-config':
            return httpx.Response(200, json={'configured': True, 'min_year': 1800, 'model': 'mini',
                                            'private_field': TOKEN, 'panorama_editor_configured': True})
        if route == '/world/redirect':
            return httpx.Response(307, headers={'location': 'https://private.example/'})
        if route == '/world/error':
            return httpx.Response(500, text=TOKEN)
        data = binary if route == ASSET else b'export const ok = true;'
        headers = {'content-type': 'model/gltf-binary' if route == ASSET else 'text/javascript',
                   'set-cookie': 'private=' + TOKEN, 'authorization': 'Bearer ' + TOKEN,
                   'x-private': TOKEN}
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

    return create_app(world=WORLD, transport=httpx.MockTransport(backend)), calls, streams, binary


@pytest.mark.parametrize('world,upstream', [
    ('../private', 'http://127.0.0.1:8001'), (WORLD, 'https://127.0.0.1:8001'),
    (WORLD, 'http://public.example'), (WORLD, 'http://user@127.0.0.1:8001'),
    (WORLD, 'http://127.0.0.1:8001/secret'), (WORLD, 'http://127.0.0.1:8001?secret=1'),
])
def test_invalid_settings(world, upstream):
    with pytest.raises(ValueError):
        validate_settings(world, 8003, upstream)


def test_session_and_config_never_publish_backend_credentials(gateway):
    app, calls, _, _ = gateway
    with TestClient(app) as client:
        session = client.get('/world-session')
        assert session.json()['access_token'] == VIEWER_MARKER
        assert TOKEN not in session.text
        assert session.headers['cache-control'] == 'no-store'
        config = client.get('/world-config')
        assert config.json()['configured'] is False
        assert config.json()['viewer_only'] is True
        assert config.json()['panorama_editor_configured'] is False
        assert 'private_field' not in config.json()
        assert TOKEN not in config.text
        assert 'gyroscope=(self)' in config.headers['permissions-policy']
        job = client.get(JOB_PATH, headers=AUTH).json()
        assert job['can_resume'] is False
        assert 'credits_after' not in job and 'prompt' not in job
        plan = client.get(PLAN_PATH, headers=AUTH).json()
        assert plan['plan_id'] == PLAN and 'prompt' not in plan
        probe = '/world-plans/00000000-0000-0000-0000-000000000000'
        assert client.get(probe).status_code == 401
        assert client.get(probe, headers=AUTH).status_code == 404
    assert len(calls) == 4
    assert calls[0].url.path == '/world-session'
    assert 'authorization' not in calls[0].headers
    assert calls[1].headers['authorization'] == 'Bearer ' + TOKEN
    assert calls[2].headers['authorization'] == 'Bearer ' + TOKEN
    assert 'authorization' not in calls[3].headers
    assert app.state.backend_token == ''


def test_all_mutations_and_unlisted_routes_are_blocked_without_upstream_calls(gateway):
    app, calls, _, _ = gateway
    with TestClient(app) as client:
        for method in ('POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'):
            for route in ('/world-jobs', JOB_PATH, JOB_PATH + '/resume', PLAN_PATH + '/edits', '/world/app.js'):
                assert client.request(method, route, headers=AUTH, content='private').status_code == 405
        for route in ('/.env', '/jobs', '/health', '/world-jobs', '/world-plans', '/world-vendor/other/file',
                      '/world-jobs/' + 'b' * 32, ASSET + '.secret', JOB_PATH + '/assets/record.json',
                      PLAN_PATH + '/assets/plan.json'):
            assert client.get(route, headers=AUTH).status_code == 404
        assert client.get(JOB_PATH).status_code == 401
        assert client.get(JOB_PATH, headers={'authorization': 'Bearer ' + TOKEN}).status_code == 401
        for route in ('/world/%2e%2e/world-session', '/world/%252e%252e/world-session', '/world/%5cprivate'):
            assert client.get(route, headers=AUTH).status_code == 400
    assert len(calls) == 4


def test_static_has_no_auth_and_upstream_errors_are_suppressed(gateway):
    app, calls, streams, _ = gateway
    with TestClient(app, follow_redirects=False) as client:
        assert client.get('/').headers['location'] == f'/world/?viewer=1&world={WORLD}'
        for route in ('/world/', '/world/app.js', '/world-vendor/three/build/three.module.js',
                      '/world-vendor/@sparkjsdev/spark/dist/spark.module.js'):
            response = client.get(route + '?private=1', headers={**AUTH, 'cookie': 'private', 'x-api-key': 'private'})
            assert response.status_code == 200
            assert not calls[-1].url.query
            for header in ('authorization', 'cookie', 'x-api-key'):
                assert header not in calls[-1].headers
            for header in ('authorization', 'set-cookie', 'x-private'):
                assert header not in response.headers
        for route in ('/world/redirect', '/world/error'):
            response = client.get(route)
            assert response.status_code == 502
            assert TOKEN not in response.text
            assert 'location' not in response.headers
    assert all(stream.closed for stream in streams)


def test_asset_stream_keeps_encoding_ranges_and_closes(gateway):
    app, calls, streams, binary = gateway
    with TestClient(app) as client:
        response = client.get(ASSET, headers={**AUTH, 'accept-encoding': 'gzip'})
        assert response.content == binary
        assert response.headers['content-encoding'] == 'gzip'
        assert int(response.headers['content-length']) == len(gzip.compress(binary))
        assert calls[-1].headers['authorization'] == 'Bearer ' + TOKEN
        response = client.get(ASSET, headers={**AUTH, 'range': 'bytes=0-99', 'accept-encoding': 'identity'})
        assert response.status_code == 206
        assert response.content == binary[:100]
        assert response.headers['content-range'] == f'bytes 0-99/{len(binary)}'
    assert all(stream.closed for stream in streams)


@pytest.mark.parametrize('url', ['https://external.example/asset', JOB_PATH + '/assets/../record.json',
                                JOB_PATH + '/assets/file?key=secret', JOB_PATH + '/assets/%2e%2e',
                                '/world-jobs/' + 'b' * 32 + '/assets/asset.glb'])
def test_asset_allowlist_rejects_urls_outside_the_selected_world(url):
    with pytest.raises(ValueError):
        listed_assets({'assets': [{'url': url}]}, {'assets': {}}, JOB_PATH, PLAN_PATH)
