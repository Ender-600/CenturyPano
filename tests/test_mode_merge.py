"""Regression coverage for the shared services after combining panorama modes."""
import asyncio
import base64
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import constraints, main, pipeline, scene
from app.config import Settings, settings
from app.editors.openai import OpenAIImageEditor
from app.manifest import read_manifest
from app.worlds.photo_history import photo_history


def picture():
    output = io.BytesIO()
    Image.new('RGB', (128, 64), (80, 110, 140)).save(output, 'JPEG')
    return output.getvalue()


def test_photo_and_world_defaults_are_independent(monkeypatch):
    for name in ('OPENAI_IMAGE_MODEL', 'WORLD_OPENAI_IMAGE_MODEL', 'STRUCTURE_LOCK'):
        monkeypatch.delenv(name, raising=False)
    defaults = Settings()
    assert defaults.openai_image_model == 'gpt-image-1.5'
    assert defaults.world_openai_image_model == 'gpt-image-2.5-sunburst'
    assert defaults.structure_lock is False
    monkeypatch.setenv('OPENAI_IMAGE_MODEL', 'photo-custom-model')
    assert Settings().world_openai_image_model == 'gpt-image-2.5-sunburst'
    monkeypatch.setenv('WORLD_OPENAI_IMAGE_MODEL', 'panorama-custom-model')
    assert Settings().world_openai_image_model == 'panorama-custom-model'


def test_upload_uses_1926_by_default_and_preserves_explicit_legacy_era(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'in_dir', tmp_path / 'in')
    monkeypatch.setattr(settings, 'out_dir', tmp_path / 'out')
    monkeypatch.setattr(settings, 'provider', 'demo')

    async def idle(_):
        pass

    monkeypatch.setattr(main, '_run', idle)
    with TestClient(main.app) as client:
        assert client.get('/health').json()['default_year'] == 1926
        assert client.get('/world-config').json()['default_year'] == 1926
        for fields, expected in (({}, 1926), ({'decade': '1920s'}, 1925), ({'target_year': '1946'}, 1946)):
            response = client.post('/jobs', files={'image': ('panorama.jpg', picture(), 'image/jpeg')}, data=fields)
            assert response.status_code == 201
            assert read_manifest(response.json()['job_id'])['target_year'] == expected
    assert not main._tasks and not main._baselines and not pipeline._hotspot_tasks


def test_request_and_reuse_caches_separate_structure_policy(monkeypatch):
    manifest = {'target_year': 1926, 'source': {'is_360': False}}
    monkeypatch.setattr(settings, 'structure_lock', True)
    locked_request = pipeline._request_key(b'photo', manifest, 'demo')
    locked_reuse = pipeline._reuse_key(b'photo', 1926, 'demo', {})
    monkeypatch.setattr(settings, 'structure_lock', False)
    assert pipeline._request_key(b'photo', manifest, 'demo') != locked_request
    assert pipeline._reuse_key(b'photo', 1926, 'demo', {}) != locked_reuse


def test_world_history_allows_structural_reconstruction_even_with_optional_photo_lock(monkeypatch):
    monkeypatch.setattr(settings, 'provider', 'demo')
    monkeypatch.setattr(settings, 'structure_lock', True)
    result = asyncio.run(photo_history(40.4433, -79.9436, 1926))
    assert result['history_context']['structure_lock'] is False
    assert any(rule['action'] == 'remove_if_visible' for rule in result['changes'])


def test_unlocked_default_reaches_photo_history_and_generic_prompt(monkeypatch):
    monkeypatch.setattr(settings, 'structure_lock', False)
    result = asyncio.run(constraints.build_constraints({}, 1926, scene.DEFAULT_SCENE_SPEC, provider='demo'))
    assert result.historical_context['structure_lock'] is False
    assert 'historically justified' in result.prompt_global
    assert 'pixel_lock' not in constraints.generic_decade_prompt(1926)
    locked = asyncio.run(constraints.build_constraints({}, 1926, scene.DEFAULT_SCENE_SPEC,
                                                       provider='demo', structure_lock=True))
    assert locked.historical_context['structure_lock'] is True


@pytest.mark.parametrize('function', ['_request_scene_openai', '_request_scene_openai_api'])
def test_openai_compatible_scene_paths_use_imported_http_client(monkeypatch, function):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={
            'choices': [{'message': {'content': json.dumps(scene.DEFAULT_SCENE_SPEC)}}],
            'usage': {'total_tokens': 7},
        })

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original_client(
        transport=httpx.MockTransport(respond), **kwargs))
    result, tokens = asyncio.run(getattr(scene, function)(picture()))
    assert result['summary'] == scene.DEFAULT_SCENE_SPEC['summary'] and tokens == 7
    assert len(requests) == 1


@pytest.mark.parametrize('structure_lock', [False, True])
def test_photo_openai_legacy_model_keeps_compatible_dimensions_and_optional_lock(structure_lock):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(picture()).decode()}]})

    editor = OpenAIImageEditor(api_key='test', model='gpt-image-1.5', transport=httpx.MockTransport(respond))
    result = asyncio.run(editor.edit(picture(), 'Historical reconstruction', structure_lock=structure_lock))
    body = requests[0].content.decode(errors='replace')
    assert '1024x1024' in body
    assert ('Do not add, remove, resize or replace any building' in body) is structure_lock
    assert ('may reshape, remove or replace buildings' in body) is not structure_lock
    assert Image.open(io.BytesIO(result)).size == (128, 64)


@pytest.mark.parametrize('structure_lock', [False, True])
def test_indoor_history_respects_optional_structure_lock(monkeypatch, structure_lock):
    monkeypatch.setattr(settings, 'structure_lock', structure_lock)
    interior = {**scene.DEFAULT_SCENE_SPEC, 'is_outdoor': False,
                'summary': 'An interior with walls, door openings and furniture.'}
    result = asyncio.run(constraints.build_constraints({}, 1926, interior, provider='demo'))
    assert result.historical_context['environment'] == 'indoor'
    assert result.historical_context['structure_lock'] is structure_lock
    rules = result.prompt_global.split('SPATIAL_AND_TEMPORAL_RULES: ', 1)[1]
    assert 'camera position, viewing direction, projection and complete input frame fixed' in rules
    assert 'This is an interior.' in rules
    if structure_lock:
        assert 'Keep the room geometry, furniture footprints and openings fixed.' in rules
        assert 'do not restage the room as a street' in rules
        assert 'Allow historically justified changes to room geometry' not in rules
    else:
        assert 'Allow historically justified changes to room geometry, walls, openings, layout and furniture footprints' in rules
        assert 'Keep the room geometry, furniture footprints and openings fixed.' not in rules
        assert 'Keep the scene indoors; do not convert it to a street or an outdoor scene' in rules
        assert 'do not invent unsupported exterior views through openings' in rules
