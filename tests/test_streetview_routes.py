"""Photo plans use live fixes and actual capture points; tests never fetch Google."""
import io
import time

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.config import settings
from app.main import app
from app.worlds import photo_history, streetview


AUTH = {'Authorization': 'Bearer test-world-access'}
PHONE = {'lat': 40.4433, 'lon': -79.9436, 'year': 1925,
         'source': 'google_streetview', 'location_source': 'device', 'location_accuracy_m': 9}


def fresh(**updates):
    return {**PHONE, 'location_timestamp_ms': time.time() * 1000, **updates}


def jpg():
    out = io.BytesIO()
    Image.new('RGB', (1024, 512), '#becabc').save(out, 'JPEG')
    return out.getvalue()


@pytest.fixture
def client(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(settings, 'in_dir', tmp_path / 'in')
    monkeypatch.setattr(settings, 'out_dir', tmp_path / 'out')
    monkeypatch.setattr(settings, 'google_maps_api_key', 'fake-map-key')
    monkeypatch.setattr(settings, 'google_streetview_ai_authorized', True)
    class FakeGoogle:
        def __init__(self, key, *, ai_authorized):
            assert key == 'fake-map-key' and ai_authorized is True
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def fetch_panorama(self, lat, lon, *, radius_m):
            calls.append((lat, lon, radius_m))
            return {'image_bytes': jpg(), 'metadata': {'pano_id': 'fake-pano',
                    'lat': lat + .00003, 'lon': lon, 'heading': 70, 'tilt': 90, 'roll': 0,
                    'date': '2024-01', 'distance_m': 3.34, 'image_width': 1024, 'image_height': 512,
                    'copyright': 'Fixture copyright', 'panorama_format': 'equirectangular_360x180'}}
    monkeypatch.setattr(streetview, 'GoogleStreetViewClient', FakeGoogle)
    async def fake_history(lat, lon, year):
        return {'history_context': {'camera_location': {'lat': lat, 'lon': lon}, 'reference_date': f'{year}-07-01'},
                'sources': [], 'changes': [], 'uncertainties': ['Fixture context, not historical evidence']}
    monkeypatch.setattr(photo_history, 'photo_history', fake_history)
    with TestClient(app) as session:
        session.map_calls = calls
        yield session


def test_photo_plan_is_rgb_not_geometry_and_tracks_two_locations(client):
    response = client.post('/world-plans', headers=AUTH, json=fresh())
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan['input_kind'] == 'streetview_panorama'
    assert plan['modern_buildings'] == plan['historical_buildings'] == []
    assert list(plan['assets']) == ['source_panorama.jpg'] and 'geometry' not in plan
    assert plan['location']['lat'] == PHONE['lat']
    assert plan['camera_location']['lat'] == PHONE['lat'] + .00003
    assert plan['history_context']['camera_location']['lat'] == plan['camera_location']['lat']
    assert plan['location']['coordinate_provenance'] == 'browser_geolocation'
    assert plan['source_panorama']['metadata']['copyright'] == 'Fixture copyright'
    assert 'fake-map-key' not in response.text
    url = plan['assets']['source_panorama.jpg']
    assert client.get(url).status_code == 401
    assert client.get(url, headers=AUTH).content == jpg()
    assert client.get(url, headers=AUTH).headers['content-type'] == 'image/jpeg'
    assert client.post(f"/world-plans/{plan['plan_id']}/edits", headers=AUTH,
                       json={'edits': [{'action': 'add'}]}).status_code == 422


def test_fresh_fix_same_point_reuses_rgb_plan_but_expired_fix_is_rejected(client):
    one = client.post('/world-plans', headers=AUTH, json=fresh()).json()
    two = client.post('/world-plans', headers=AUTH, json=fresh(location_accuracy_m=12)).json()
    assert one['plan_id'] == two['plan_id'] and len(client.map_calls) == 1
    response = client.post('/world-plans', headers=AUTH,
                           json=fresh(location_timestamp_ms=(time.time()-180)*1000))
    assert response.status_code == 422 and len(client.map_calls) == 1


@pytest.mark.parametrize('change', [{'location_timestamp_ms': None}, {'location_accuracy_m': None},
                                   {'location_timestamp_ms': 0}, {'source': 'osm'}, {'source': 'cmu_snapshot'}])
def test_device_without_fix_or_with_geometry_source_is_blocked(client, change):
    assert client.post('/world-plans', headers=AUTH, json=fresh(**change)).status_code == 422
    assert not client.map_calls


def test_explicit_test_point_needs_no_device_fix(client):
    result = client.post('/world-plans', headers=AUTH,
                         json={**PHONE, 'location_source': 'test', 'location_accuracy_m': None})
    assert result.status_code == 200, result.text
    assert result.json()['location']['coordinate_provenance'] == 'explicit_test_point'


@pytest.mark.parametrize('field,value', [('google_maps_api_key', ''), ('google_streetview_ai_authorized', False)])
def test_missing_google_connection_never_falls_back(client, monkeypatch, field, value):
    monkeypatch.setattr(settings, field, value)
    response = client.post('/world-plans', headers=AUTH, json=fresh())
    assert response.status_code == 503 and response.json()['detail']
    assert not client.map_calls


def test_config_names_test_point_and_defaults_to_device_photography(client):
    config = client.get('/world-config').json()
    assert config['default_location_source'] == 'device' and config['default_source'] == 'google_streetview'
    assert 'default_location' not in config and 'test_location' in config
    assert config['streetview']['available']


@pytest.mark.asyncio
async def test_history_rules_use_capture_scope_and_are_conditional(monkeypatch):
    monkeypatch.setattr(settings, 'provider', 'demo')
    inside = await photo_history.photo_history(40.4433, -79.9436, 1925)
    gates = next(rule for rule in inside['changes'] if rule['name'] == 'Gates and Hillman Centers')
    assert gates['action'] == 'remove_if_visible' and gates['visibility'] == 'not_verified_in_image'
    doherty = next(rule for rule in inside['changes'] if rule['name'] == 'Doherty Hall')
    assert doherty['action'] == 'unknown'
    outside = await photo_history.photo_history(34, 135, 1925)
    assert outside['sources'] == outside['changes'] == []
    assert 'Carnegie' not in outside['history_context']['place_name']
