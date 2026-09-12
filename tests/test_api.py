import io
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import settings
from app.main import app
from app.manifest import read_manifest, update_manifest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'in_dir', tmp_path / 'in')
    monkeypatch.setattr(settings, 'out_dir', tmp_path / 'out')
    monkeypatch.setattr(settings, 'provider', 'demo')
    monkeypatch.setattr(settings, 'provider_fallback', 'demo')
    with TestClient(app) as session:
        yield session


def panorama():
    image = Image.new('RGB', (1600, 400), '#829aab')
    stream = io.BytesIO()
    image.save(stream, 'JPEG')
    return stream.getvalue()


def wait_done(client, job_id, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f'/jobs/{job_id}/manifest')
        assert response.headers['cache-control'] == 'no-store'
        m = response.json()
        if m['status'] != 'running':
            return m
        time.sleep(.15)
    pytest.fail('Pipeline timed out')


def test_upload_replay_and_private_original(client):
    data = panorama()
    response = client.post('/jobs', files={'image': ('pano.jpg', data, 'image/jpeg')}, data={'decade': '1920s'})
    assert response.status_code == 201
    job_id = response.json()['job_id']
    m = wait_done(client, job_id)
    assert m['status'] == 'done', m
    assert m['demo'] is True
    assert all(m['metrics'][k] is not None for k in ['started_at', 'anchor_done_at', 'first_tile_at', 'finished_at'])
    for suffix in ['preview', 'result', 'tiles/0', 'tiles/0?raw=1', 'audio']:
        asset = client.get(f'/jobs/{job_id}/{suffix}')
        assert asset.status_code == 200, suffix
    assert client.get('/' + m['source']['path']).status_code == 404
    assert client.get(f'/out/{job_id}/manifest.json').status_code == 404
    second = client.post('/jobs', files={'image': ('pano.jpg', data, 'image/jpeg')}).json()['job_id']
    cached = wait_done(client, second)
    assert cached['mode'] == 'replay'
    assert cached['metrics'] == m['metrics']
    assert any(r['job_id'] == second for r in client.get('/replays').json()['replays'])


def test_invalid_uploads_and_fields(client):
    assert client.post('/jobs', files={'image': ('bad.jpg', b'not an image', 'image/jpeg')}).status_code == 415
    assert client.post('/jobs', files={'image': ('bad.svg', b'<svg/>', 'image/svg+xml')}).status_code == 415
    for fields in [{'decade': '1800s'}, {'heading': '1.2'}, {'lat': '40'}, {'lat': 'nan', 'lon': '0'}]:
        assert client.post('/jobs', files={'image': ('ok.jpg', panorama(), 'image/jpeg')}, data=fields).status_code == 422
    assert client.post('/jobs', content=b'x', headers={'content-length': str(45*1024*1024)}).status_code == 413
    assert client.get('/jobs/not-a-job/manifest').status_code == 404
    assert client.post('/location/resolve', json={'lat': 91, 'lon': 0}).status_code == 422


def test_server_preview_strips_metadata(client):
    response = client.post('/preview', files={'image': ('pano.jpg', panorama(), 'image/jpeg')})
    assert response.status_code == 200
    image = Image.open(io.BytesIO(response.content))
    assert image.size == (1600, 400)
    assert not image.getexif()


def test_atomic_manifest_concurrent_updates(client):
    update_manifest('atomic-test', lambda m: m.update(count=0))
    def increment(_):
        update_manifest('atomic-test', lambda m: m.update(count=m['count']+1))
    with ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(increment, range(80)))
    assert read_manifest('atomic-test')['count'] == 80
