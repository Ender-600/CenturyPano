"""Keep every test away from real persisted generation jobs and credentials."""
import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def isolated_world_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'world_dir', tmp_path / 'worlds')
    monkeypatch.setattr(settings, 'worldlab_api_key', '')
    monkeypatch.setattr(settings, 'world_access_token', 'test-world-access')
