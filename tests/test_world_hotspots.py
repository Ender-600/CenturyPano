"""White dots use saved panoramas only; model calls are always replaced by fakes."""
import asyncio
from hashlib import sha256
import io
import json

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.config import settings
from app.main import app
from app.worlds import hotspots, router
from app.worlds.jobs import WorldJobManager

JOB = 'a' * 32
AUTH = {'Authorization': 'Bearer test-world-access'}
PREFIX = f'/world-jobs/{JOB}'
ITEMS = [{'id': 'h0', 'label': 'Stone facade', 'kind': 'building', 'point': [.5, .4],
          'bbox': [.45, .35, .55, .45]}]


def saved_panorama(root):
    directory = root / JOB
    directory.mkdir(parents=True, exist_ok=True)
    out = io.BytesIO()
    Image.new('RGB', (1024, 512), '#bcab89').save(out, 'JPEG')
    image = out.getvalue()
    (directory / 'historical_panorama.jpg').write_bytes(image)
    record = {'id': JOB, 'plan_id': 'b' * 36, 'stage': 'ready', 'kind': 'panorama',
              'input_kind': 'streetview_panorama', 'year': 1926,
              'assets': [{'kind': 'historical_pano', 'filename': 'historical_panorama.jpg',
                          'relative_path': 'historical_panorama.jpg', 'sha256': sha256(image).hexdigest()}]}
    (directory / 'record.json').write_text(json.dumps(record))
    (directory / 'plan.json').write_text(json.dumps({'target_year': 1926,
        'history_context': {'place_name': 'Saved capture point', 'site_history': 'Recorded context'}}))
    return directory, image


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'in_dir', tmp_path / 'in')
    monkeypatch.setattr(settings, 'out_dir', tmp_path / 'out')
    calls = {'detect': [], 'explain': []}

    async def detect(image, *, provider):
        calls['detect'].append((image, provider))
        return {'items': ITEMS, 'fallback': False, 'tokens': 12}

    async def explain(image, item, **context):
        calls['explain'].append((image, item, context))
        return {'hotspot_id': item['id'], 'label': 'Stone facade', 'past': 'A period facade.',
                'uncertainty': 'Building identity is unverified.'}

    monkeypatch.setattr(hotspots, 'detect_hotspots', detect)
    monkeypatch.setattr(hotspots, 'explain_hotspot', explain)
    with TestClient(app) as session:
        session.directory, session.image = saved_panorama(settings.world_dir / 'jobs')
        session.calls = calls
        yield session


def refined(client):
    response = client.post(PREFIX + '/hotspots', headers=AUTH)
    assert response.status_code == 200, response.text
    assert response.json()['provisional'] is True

    async def finish():
        await asyncio.gather(*router._hotspots.detections.values())
    client.portal.call(finish)
    return client.get(PREFIX + '/hotspots', headers=AUTH).json()


def test_authenticated_dots_refine_once_and_explanations_use_frozen_context(client):
    for method, path, payload in [('get', '/hotspots', None), ('post', '/hotspots', {}),
                                  ('post', '/explain', {'hotspot_id': 'h0', 'revision': 'f' * 64})]:
        kwargs = {'json': payload} if payload is not None else {}
        assert getattr(client, method)(PREFIX + path, **kwargs).status_code == 401
    data = refined(client)
    assert data['items'] == ITEMS and not data['provisional'] and not data['fallback']
    assert client.calls['detect'] == [(client.image, 'openai')]
    assert client.post(PREFIX + '/hotspots', headers=AUTH).json() == data
    body = {'hotspot_id': 'h0', 'revision': data['revision']}
    one = client.post(PREFIX + '/explain', headers=AUTH, json=body)
    two = client.post(PREFIX + '/explain', headers=AUTH, json=body)
    assert one.status_code == two.status_code == 200 and one.json() == two.json()
    assert len(client.calls['explain']) == len(client.calls['detect']) == 1
    image, item, context = client.calls['explain'][0]
    assert image == client.image and item == ITEMS[0]
    assert context['year'] == 1926 and context['place']['name'] == 'Saved capture point'
    assert context['historical_context']['site_history'] == 'Recorded context'
    assert client.get(PREFIX + '/assets/hotspots.json', headers=AUTH).status_code == 404


def test_invalid_or_missing_regions_never_call_the_model(client):
    data = refined(client)
    for payload, status in [({'hotspot_id': 'h0', 'revision': 'f' * 64}, 409),
                            ({'hotspot_id': 'h99', 'revision': data['revision']}, 404),
                            ({'hotspot_id': '../x', 'revision': data['revision']}, 422),
                            ({'hotspot_id': 'h0', 'revision': data['revision'], 'year': 2026}, 422)]:
        assert client.post(PREFIX + '/explain', headers=AUTH, json=payload).status_code == status
    assert not client.calls['explain']
    assert client.get('/world-jobs/invalid/hotspots', headers=AUTH).status_code == 404
    (client.directory / 'historical_panorama.jpg').unlink()
    assert client.post(PREFIX + '/hotspots', headers=AUTH).status_code == 409


def test_fallback_regions_stay_neutral_and_cached_results_survive_service_restart(client, monkeypatch):
    async def unavailable(*args, **kwargs):
        return {'fallback': True, 'items': ITEMS}
    monkeypatch.setattr(hotspots, 'detect_hotspots', unavailable)
    data = refined(client)
    assert data['fallback'] and not data['provisional']
    assert all(item['label'].startswith('Scene detail ') for item in data['items'])
    restored = hotspots.WorldHotspots(router.manager())
    assert restored.get(JOB) == data


def test_explanation_failure_is_retryable_and_never_exposes_provider_errors(client, monkeypatch):
    data = refined(client)
    original = hotspots.explain_hotspot
    async def unavailable(*args, **kwargs):
        raise RuntimeError('private provider detail')
    monkeypatch.setattr(hotspots, 'explain_hotspot', unavailable)
    body = {'hotspot_id': 'h0', 'revision': data['revision']}
    result = client.post(PREFIX + '/explain', headers=AUTH, json=body)
    assert result.status_code == 502 and 'private provider' not in result.text
    monkeypatch.setattr(hotspots, 'explain_hotspot', original)
    assert client.post(PREFIX + '/explain', headers=AUTH, json=body).status_code == 200


@pytest.mark.asyncio
async def test_duplicate_requests_share_work_and_shutdown_cancels_pending_detection(tmp_path, monkeypatch):
    saved_panorama(tmp_path)
    manager = WorldJobManager(tmp_path, '')
    service = hotspots.WorldHotspots(manager)
    release = asyncio.Event()
    calls = []
    async def explain(*args, **kwargs):
        calls.append('explain')
        await release.wait()
        return {'label': 'detail'}
    async def detect(*args, **kwargs):
        calls.append('detect')
        await asyncio.Event().wait()
    monkeypatch.setattr(hotspots, 'explain_hotspot', explain)
    monkeypatch.setattr(hotspots, 'detect_hotspots', detect)
    data = service.get(JOB, refine=True)
    service.get(JOB, refine=True)
    one = asyncio.create_task(service.explain(JOB, 'h0', data['revision']))
    two = asyncio.create_task(service.explain(JOB, 'h0', data['revision']))
    for _ in range(100):
        if 'explain' in calls:
            break
        await asyncio.sleep(.001)
    release.set()
    assert await one == await two == {'label': 'detail'}
    pending = list(service.detections.values())
    await service.aclose()
    await manager.aclose()
    assert calls.count('explain') == calls.count('detect') == 1
    assert all(task.cancelled() for task in pending)
    assert not service.explanations and not service.detections
