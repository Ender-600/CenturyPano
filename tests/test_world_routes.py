"""Private route integration; real geometry, fake map and billed service."""
import copy
import json

from fastapi.testclient import TestClient
import pytest

from app.config import settings
from app.main import app
from app.worlds import planning, router


BUILDING = {'id': 'way/1', 'label': 'Later building',
            'footprint': [[5, -5], [10, -5], [10, 5], [5, 5]], 'height_m': 12}
PLAN = {'target_year': 1925, 'modern_buildings': [BUILDING], 'historical_buildings': [],
        'camera_position': [0, 1.6, 0], 'heading_deg': 0, 'sources': [], 'uncertainties': [],
        'changes': [{'building_id': 'way/1', 'action': 'remove', 'reason': 'Later building', 'evidence_ids': []}]}
PAYLOAD = {'lat': 40.4433, 'lon': -79.9436, 'year': 1925, 'source': 'cmu_snapshot', 'location_source': 'test'}
AUTH = {'Authorization': 'Bearer test-world-access'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'in_dir', tmp_path / 'in')
    monkeypatch.setattr(settings, 'out_dir', tmp_path / 'out')
    async def prepare(*args, **kwargs):
        return copy.deepcopy(PLAN)
    monkeypatch.setattr(planning, 'prepare_plan', prepare)
    with TestClient(app) as session:
        yield session


def test_access_code_is_local_only_and_never_api_key(client, monkeypatch):
    monkeypatch.setattr(settings, 'worldlab_api_key', 'private-provider-key')
    assert client.get('/world-session').json() == {'access_token': 'test-world-access'}
    for headers in [{'host': 'public.example'}, {'origin': 'https://evil.example'}, {'sec-fetch-site': 'cross-site'}]:
        assert client.get('/world-session', headers=headers).status_code == 403
    for route in ['/world-config', '/world-session', '/world-jobs/invalid']:
        response = client.get(route)
        assert response.headers['cache-control'] == 'no-store'
        assert 'private-provider-key' not in response.text
    assert client.post('/world-plans', json=PAYLOAD).status_code == 401
    assert client.get('/world-plans/not-a-plan').status_code == 401


def test_frozen_plan_cache_and_private_assets(client):
    result = client.post('/world-plans', json=PAYLOAD, headers=AUTH)
    assert result.status_code == 200, result.text
    plan = result.json()
    assert plan['target_year'] == 1925 and len(plan['historical_buildings']) == 0
    again = client.post('/world-plans', json=PAYLOAD, headers=AUTH).json()
    assert again['plan_id'] == plan['plan_id']
    modern = client.get(plan['assets']['modern.glb'], headers=AUTH)
    historic = client.get(plan['assets']['historical.glb'], headers=AUTH)
    assert modern.content[:4] == historic.content[:4] == b'glTF'
    assert modern.content != historic.content
    assert client.get(plan['assets']['depth.png']).status_code == 401
    assert client.get(f"/world-plans/{plan['plan_id']}/assets/plan.json", headers=AUTH).status_code == 404
    assert client.get(f"/world-plans/{plan['plan_id']}", headers=AUTH).json() == plan


def test_edit_creates_new_geometry_without_mutating_original(client):
    plan = client.post('/world-plans', json=PAYLOAD, headers=AUTH).json()
    edit = {'action': 'keep', 'building_id': 'way/1', 'reason': 'Unverified reviewer override',
            'source_title': 'User reference', 'source_url': 'https://example.com/evidence'}
    response = client.post(f"/world-plans/{plan['plan_id']}/edits", json={'edits': [edit]}, headers=AUTH)
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated['plan_id'] != plan['plan_id'] and updated['parent_plan_id'] == plan['plan_id']
    assert len(updated['historical_buildings']) == 1
    assert updated['sources'][-1]['evidence_basis'] == 'user_supplied_unverified'
    assert not updated['historical_geometry_verified']
    assert client.get(f"/world-plans/{plan['plan_id']}", headers=AUTH).json() == plan
    assert client.get(updated['assets']['depth.png'], headers=AUTH).content != client.get(plan['assets']['depth.png'], headers=AUTH).content
    edit['source_url'] = 'file:///etc/passwd'
    assert client.post(f"/world-plans/{plan['plan_id']}/edits", json={'edits': [edit]}, headers=AUTH).status_code == 422


@pytest.mark.parametrize('change', [{'year': True}, {'year': 1925.1}, {'lat': 90}, {'radius_m': 500},
                                   {'source': 'google'}, {'source': 'example'}, {'heading_deg': 360}])
def test_plan_input_bounds(client, change):
    assert client.post('/world-plans', json={**PAYLOAD, **change}, headers=AUTH).status_code == 422


def test_body_limit_before_parsing_and_invalid_job_ids(client):
    assert client.post('/world-plans', content=b'x' * (256 * 1024 + 1), headers=AUTH).status_code == 413
    assert client.get('/world-jobs/invalid', headers=AUTH).status_code == 404
    assert client.get('/world-jobs/invalid/assets/world.json', headers=AUTH).status_code == 404
    assert client.get('/world-plans/invalid', headers=AUTH).status_code == 404


def test_generation_loads_frozen_server_plan_and_blocks_without_key(client, monkeypatch):
    plan = client.post('/world-plans', json=PAYLOAD, headers=AUTH).json()
    assert client.post('/world-jobs', json={'plan_id': plan['plan_id']}, headers=AUTH).status_code == 503
    class FakeManager:
        async def start(self, given, model):
            assert given == plan and model == 'marble-1.0-draft'
            return {'id': 'fake-job', 'stage': 'queued'}
        async def aclose(self):
            pass
    monkeypatch.setattr(settings, 'worldlab_api_key', 'fake-key')
    monkeypatch.setattr(router, '_manager', FakeManager())
    assert client.post('/world-jobs', json={'plan_id': plan['plan_id']}, headers=AUTH).json()['stage'] == 'queued'
    response = client.post('/world-jobs', json={'plan_id': plan['plan_id'], 'prompt': 'override'}, headers=AUTH)
    assert response.status_code == 422
    assert 'fake-key' not in json.dumps(plan)
