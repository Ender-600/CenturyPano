import io

import pytest
from PIL import Image

from scripts import probe_providers


@pytest.mark.asyncio
async def test_missing_openai_key_skips_without_creating_editor(tmp_path, monkeypatch):
    monkeypatch.setattr(probe_providers.settings, 'openai_api_key', '')

    def unexpected_editor(_):
        pytest.fail('A missing key must not start a model call')

    monkeypatch.setattr(probe_providers, 'get_editor', unexpected_editor)
    result = await probe_providers.probe_provider('openai', b'', 'test', tmp_path, None)
    assert result['status'] == 'skipped'
    assert result['generation_calls'] == 0


@pytest.mark.asyncio
async def test_invalid_provider_configuration_does_not_count_a_generation(tmp_path, monkeypatch):
    monkeypatch.setattr(probe_providers.settings, 'openai_api_key', 'test-key')
    monkeypatch.setattr(probe_providers.settings, 'openai_image_quality', 'invalid')
    result = await probe_providers.probe_provider('openai', b'', 'test', tmp_path, None)
    assert result['status'] == 'failed' and result['generation_calls'] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('override,expected', [(None, 180.0), (30.0, 30.0)])
async def test_openai_probe_records_configuration_and_timeout(tmp_path, monkeypatch, override, expected):
    monkeypatch.setattr(probe_providers.settings, 'openai_api_key', 'test-key')
    output = io.BytesIO()
    Image.new('RGB', (1024, 1024)).save(output, 'JPEG')

    class Editor:
        model = 'gpt-image-2.5-sunburst'
        quality = 'medium'
        default_timeout_s = 180.0

        async def edit(self, image, prompt, **kwargs):
            assert kwargs['timeout_s'] == expected
            return output.getvalue()

    monkeypatch.setattr(probe_providers, 'get_editor', lambda _: Editor())
    result = await probe_providers.probe_provider('openai', b'', 'test', tmp_path, override)
    assert result['status'] == 'passed' and result['generation_calls'] == 1
    assert result['model'] == Editor.model and result['quality'] == 'medium'
    assert (tmp_path / 'openai.jpg').read_bytes() == output.getvalue()
