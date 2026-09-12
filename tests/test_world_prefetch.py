"""Walking predictions use fake providers and never submit billable work."""
import asyncio
import copy
import json
import time

from fastapi.testclient import TestClient
import pytest

from app.config import settings
from app.main import app
from app.worlds import photo_history, router, streetview


AUTH = {'Authorization': 'Bearer test-world-access'}
PLAN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
LAT, LON = 40.4433, -79.9436


def payload(**updates):
    return {'plan_id': PLAN_ID, 'lat': LAT, 'lon': LON, 'location_accuracy_m': 8,
            'location_timestamp_ms': time.time() * 1000, 'heading_deg': 0,
            'speed_mps': 1.4, 'lookahead_m': 55, **updates}


@pytest.fixture
def client(monkeypatch):
    calls = {'metadata': [], 'download': [], 'start': [], 'cancel': [], 'selection': None}
    monkeypatch.setattr(settings, 'google_maps_api_key', 'fake-google-key')
    monkeypatch.setattr(settings, 'google_streetview_ai_authorized', True)
    monkeypatch.setattr(settings, 'openai_api_key', 'fake-image-key')
    current = {'plan_id': PLAN_ID, 'input_kind': 'streetview_panorama', 'source': 'google_streetview',
               'target_year': 1925, 'source_panorama': {'metadata': {'pano_id': 'current'}},
               'location': {'lat': LAT, 'lon': LON, 'location_source': 'device'}}
    router._atomic_json(router.plan_dir(PLAN_ID) / 'plan.json', current)
    class FakeGoogle:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def select_forward_panorama(self, lat, lon, **kwargs):
            calls['metadata'].append((lat, lon, kwargs))
            if isinstance(calls['selection'], Exception):
                raise calls['selection']
            return calls['selection'] or {'metadata': {'pano_id': 'next', 'lat': LAT + .0005, 'lon': LON,
                'date': '2026-01', 'heading': 10, 'tilt': 90, 'roll': 0, 'copyright': 'Fixture Google'},
                'path': ['current', 'middle', 'next'], 'distance_m': 55.6}
        async def fetch_panorama_by_id(self, pano_id, **kwargs):
            calls['download'].append((pano_id, kwargs))
            await asyncio.sleep(.01)
            return {'image_bytes': b'fixture-jpeg', 'metadata': {'pano_id': pano_id,
                'lat': kwargs['lat'], 'lon': kwargs['lon'], 'date': '2026-01',
                'heading': 10, 'tilt': 90, 'roll': 0, 'copyright': 'Fixture Google'}}
    class FakeManager:
        async def start_panorama(self, plan, *, speculative, expires_at=None):
            calls['start'].append((copy.deepcopy(plan), speculative, expires_at))
            return {'id': 'job-1', 'stage': 'queued', 'kind': 'panorama', 'plan_id': plan['plan_id']}
        async def cancel_panorama(self, job_id):
            calls['cancel'].append(job_id)
            return {'id': job_id, 'stage': 'cancelled'}
        async def aclose(self):
            pass
    async def history(lat, lon, year):
        return {'history_context': {'camera_location': {'lat': lat, 'lon': lon}, 'year': year},
                'sources': [], 'changes': [], 'uncertainties': []}
    monkeypatch.setattr(streetview, 'GoogleStreetViewClient', FakeGoogle)
    monkeypatch.setattr(photo_history, 'photo_history', history)
    with TestClient(app) as session:
        monkeypatch.setattr(router, '_manager', FakeManager())
        session.calls, session.current = calls, current
        yield session


def test_prediction_keeps_real_fix_separate_and_needs_no_worldlabs(client):
    assert settings.worldlab_api_key == ''
    response = client.post('/world-prefetch', json=payload(), headers=AUTH)
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    result = response.json()
    plan = result['plan']
    assert plan['target_year'] == 1925
    assert plan['location']['lat'] == LAT + .0005
    assert plan['location']['coordinate_provenance'] == 'predicted_streetview_link'
    assert plan['prediction']['origin']['lat'] == LAT
    assert plan['prediction']['origin']['coordinate_provenance'] == 'browser_geolocation'
    assert plan['camera_location']['lat'] == LAT + .0005
    assert plan['history_context']['camera_location'] == {'lat': LAT + .0005, 'lon': LON}
    assert result['job']['stage'] == 'queued'
    assert client.calls['download'] == [('next', {'lat': LAT + .0005, 'lon': LON})]
    assert client.calls['start'][0][1] is True
    assert 170 < client.calls['start'][0][2] - time.time() <= 180
    assert client.get(f'/world-plans/{PLAN_ID}', headers=AUTH).json() == client.current
    assert client.get(plan['assets']['source_panorama.jpg'], headers=AUTH).content == b'fixture-jpeg'
    assert client.get('/world-config').json()['prefetch']['available']


def test_same_target_and_year_reuses_frozen_plan_despite_gps_jitter(client):
    one = client.post('/world-prefetch', json=payload(), headers=AUTH).json()
    two = client.post('/world-prefetch', json=payload(lat=LAT + .00001), headers=AUTH).json()
    assert one['plan'] == two['plan']
    assert two['prediction']['origin']['lat'] != one['prediction']['origin']['lat']
    assert len(client.calls['download']) == 1
    updated = {**client.current, 'target_year': 1945}
    router._atomic_json(router.plan_dir(PLAN_ID) / 'plan.json', updated)
    three = client.post('/world-prefetch', json=payload(), headers=AUTH).json()
    assert three['plan']['plan_id'] != one['plan']['plan_id']
    assert three['plan']['target_year'] == 1945
    assert len(client.calls['download']) == 2


@pytest.mark.parametrize('updates', [{'location_accuracy_m': 36}, {'speed_mps': 0}, {'speed_mps': 4},
    {'lookahead_m': 151}, {'heading_deg': 360}, {'location_timestamp_ms': 0},
    {'location_timestamp_ms': (time.time() - 40) * 1000}, {'year': 1850}])
def test_unreliable_stale_or_overridden_predictions_never_call_provider(client, updates):
    assert client.post('/world-prefetch', json=payload(**updates), headers=AUTH).status_code == 422
    assert client.calls['metadata'] == client.calls['download'] == client.calls['start'] == []


@pytest.mark.parametrize('selection,reason', [({'status': 'skipped', 'reason': 'ambiguous_junction'}, 'ambiguous_junction'),
    (streetview.StreetViewError('missing coverage', code='no_coverage'), 'no_coverage')])
def test_uncertain_route_or_no_coverage_does_not_start_images(client, selection, reason):
    client.calls['selection'] = selection
    response = client.post('/world-prefetch', json=payload(), headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {'status': 'skipped', 'reason': reason}
    assert client.calls['download'] == client.calls['start'] == []


def test_prefetch_auth_configuration_and_cancel(client, monkeypatch):
    assert client.post('/world-prefetch', json=payload()).status_code == 401
    assert client.post('/world-jobs/job-1/cancel').status_code == 401
    result = client.post('/world-jobs/job-1/cancel', headers=AUTH)
    assert result.json() == {'id': 'job-1', 'stage': 'cancelled'}
    monkeypatch.setattr(settings, 'google_streetview_ai_authorized', False)
    assert client.post('/world-prefetch', json=payload(), headers=AUTH).status_code == 503
    assert not client.get('/world-config').json()['prefetch']['available']
    assert client.calls['metadata'] == []


def test_foreground_panorama_start_without_worldlabs(client):
    response = client.post('/world-jobs', json={'plan_id': PLAN_ID, 'kind': 'panorama'}, headers=AUTH)
    assert response.status_code == 200, response.text
    assert client.calls['start'] == [(client.current, False, None)]
    assert client.post('/world-jobs', json={'plan_id': PLAN_ID}, headers=AUTH).status_code == 503


@pytest.mark.asyncio
async def test_duplicate_inflight_fix_shares_metadata_download_and_submission(client):
    fix = router.PrefetchRequest(**payload())
    first, second = await asyncio.gather(router.prefetch_panorama(fix), router.prefetch_panorama(fix))
    assert json.loads(first.body) == json.loads(second.body)
    assert len(client.calls['metadata']) == len(client.calls['download']) == len(client.calls['start']) == 1


@pytest.mark.asyncio
async def test_different_inflight_fixes_share_target_download_without_foreground_lock(client):
    first = router.PrefetchRequest(**payload())
    second = router.PrefetchRequest(**payload(lat=LAT + .00001))
    # A busy foreground geometry/plan operation cannot block prediction setup.
    async with router._plan_lock:
        responses = await asyncio.wait_for(asyncio.gather(
            router.prefetch_panorama(first), router.prefetch_panorama(second)), timeout=1)
    assert json.loads(responses[0].body)['plan'] == json.loads(responses[1].body)['plan']
    assert len(client.calls['metadata']) == 2 and len(client.calls['download']) == 1


def test_changed_image_configuration_does_not_reuse_old_frozen_plan(client, monkeypatch):
    one = client.post('/world-prefetch', json=payload(), headers=AUTH).json()
    monkeypatch.setattr(settings, 'world_openai_image_model', 'changed-editor')
    two = client.post('/world-prefetch', json=payload(), headers=AUTH).json()
    assert two['plan']['plan_id'] != one['plan']['plan_id']
    assert two['plan']['panorama_editor']['model'] == 'changed-editor'
    assert len(client.calls['download']) == 2
