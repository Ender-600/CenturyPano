import io
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.config import settings
from app.main import app
from app.manifest import read_manifest, update_manifest
from app.temporal import DEFAULT_YEAR, MAX_YEAR, MIN_YEAR, decade_for_year, manifest_year, resolve_year


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
    for suffix in ['preview', 'result', 'tiles/0', 'tiles/0?raw=1']:
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


@pytest.mark.parametrize('year', [1800, 1944, 1945, 1946, 1950, MAX_YEAR])
def test_exact_year_is_authoritative_and_not_rounded(client, monkeypatch, year):
    async def uploaded(job_id):
        main._tasks.pop(job_id, None)
    monkeypatch.setattr(main, '_run', uploaded)
    response = client.post('/jobs', files={'image': ('pano.jpg', panorama(), 'image/jpeg')},
                           data={'target_year': str(year), 'decade': 'ignored legacy value'})
    assert response.status_code == 201, response.text
    manifest = client.get(f"/jobs/{response.json()['job_id']}/manifest").json()
    assert manifest['target_year'] == manifest['anchor_year'] == year
    assert manifest['decade'] == decade_for_year(year)


@pytest.mark.parametrize('value', ['1799', str(MAX_YEAR + 1), '1945.0', '1945.5', '1.945e3', '1940s', 'true', '-1945'])
def test_exact_year_rejects_invalid_values(client, value):
    response = client.post('/jobs', files={'image': ('pano.jpg', panorama(), 'image/jpeg')},
                           data={'target_year': value})
    assert response.status_code == 422


def test_health_and_legacy_manifest_years(client):
    health = client.get('/health').json()
    assert (health['min_year'], health['max_year'], health['default_year']) == (MIN_YEAR, MAX_YEAR, DEFAULT_YEAR)
    assert 'weather_enabled' in health
    assert health['weather_ids'] == ['clear', 'rain', 'snow']
    assert resolve_year('1920s') == 1925
    assert resolve_year('1945') == 1945
    assert manifest_year({'target_year': 1945, 'anchor_year': 1955, 'decade': '1970s'}) == 1945
    assert manifest_year({'anchor_year': 1950, 'decade': '1950s'}) == 1950
    assert manifest_year({'decade': '1920s'}) == 1925
    for invalid in (True, 1945.0, None, '1945.0'):
        with pytest.raises(ValueError):
            resolve_year(invalid)
    update_manifest('old-replay', lambda m: m.update(job_id='old-replay', mode='replay', status='done', decade='1920s'))
    update_manifest('mapped-replay', lambda m: m.update(
        job_id='mapped-replay', mode='replay', status='done', target_year=1945,
        place={'name': 'Pittsburgh', 'admin1': 'Pennsylvania', 'cc': 'US', 'lat': 40.44, 'lon': -79.99, 'source': 'exif'},
    ))
    update_manifest('city-replay', lambda m: m.update(
        job_id='city-replay', mode='replay', status='done', target_year=1925,
        place={'name': 'Shanghai', 'cc': 'CN', 'source': 'manual', 'prompt_safe': True},
    ))
    entries = {entry['job_id']: entry for entry in client.get('/replays').json()['replays']}
    assert entries['old-replay']['target_year'] == 1925
    assert (entries['mapped-replay']['lat'], entries['mapped-replay']['lon']) == pytest.approx((40.44, -79.99))
    assert 'lat' in entries['city-replay'] and 'lon' in entries['city-replay']
    assert entries['city-replay']['lat'] == pytest.approx(31.22, abs=0.5)


def test_atomic_manifest_concurrent_updates(client):
    update_manifest('atomic-test', lambda m: m.update(count=0))
    def increment(_):
        update_manifest('atomic-test', lambda m: m.update(count=m['count']+1))
    with ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(increment, range(80)))
    assert read_manifest('atomic-test')['count'] == 80


def test_create_job_accepts_weather_enabled(client, monkeypatch):
    monkeypatch.setattr(settings, 'weather_enabled', False)

    async def noop(_job_id):
        return None

    monkeypatch.setattr(main, '_run', noop)
    response = client.post(
        '/jobs',
        files={'image': ('pano.jpg', panorama(), 'image/jpeg')},
        data={'target_year': '1925', 'weather_enabled': 'true', 'weathers': 'clear,rain'},
    )
    assert response.status_code == 201
    job_id = response.json()['job_id']
    manifest = read_manifest(job_id)
    assert manifest['weather']['enabled'] is True
    assert manifest['weather']['ids'] == ['clear', 'rain']
    assert manifest['weather']['active'] == 'clear'

    bad = client.post(
        '/jobs',
        files={'image': ('pano.jpg', panorama(), 'image/jpeg')},
        data={'target_year': '1925', 'weather_enabled': 'true', 'weathers': 'fog'},
    )
    assert bad.status_code == 422
