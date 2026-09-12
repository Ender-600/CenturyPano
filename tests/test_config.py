"""Exercise dotenv precedence in a fresh process, without real credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


@pytest.mark.parametrize('source', ['process', 'explicit_env_file'])
def test_world_launch_configuration_takes_precedence_over_repository_dotenv(tmp_path, source):
    package = tmp_path / 'app'
    package.mkdir()
    (package / '__init__.py').touch()
    for name in ('config.py', 'temporal.py'):
        (package / name).write_text((Path(__file__).resolve().parents[1] / 'app' / name).read_text())
    (tmp_path / '.env').write_text(
        'GOOGLE_MAPS_API_KEY=stale.invalid.key\nWORLDLAB_API_KEY=stale-world-key\n'
        'GOOGLE_STREETVIEW_AI_AUTHORIZED=false\nWORLD_DIR=stale-data\n')
    expected = {'GOOGLE_MAPS_API_KEY': 'selected-maps-key', 'WORLDLAB_API_KEY': 'selected-world-key',
                'GOOGLE_STREETVIEW_AI_AUTHORIZED': 'true'}
    environment = {k: v for k, v in os.environ.items() if k not in (*expected, 'WORLD_DIR')}
    setup = ''
    if source == 'process':
        environment.update(expected)
    else:
        (tmp_path / 'selected.env').write_text(''.join(f'{k}={v}\n' for k, v in expected.items()))
        setup = "from dotenv import load_dotenv; load_dotenv('selected.env'); "
    # serve_worlds --data-dir is set before app.config is imported.
    code = setup + (
        "import os,json; os.environ['WORLD_DIR']='selected-data'; "
        "from app.config import settings; print(json.dumps([settings.google_maps_api_key, "
        "settings.worldlab_api_key, settings.google_streetview_ai_authorized, str(settings.world_dir)]))")
    result = subprocess.run([sys.executable, '-c', code], cwd=tmp_path, env=environment,
                            check=True, capture_output=True, text=True)
    assert json.loads(result.stdout) == ['selected-maps-key', 'selected-world-key', True,
                                       str(tmp_path / 'selected-data')]
