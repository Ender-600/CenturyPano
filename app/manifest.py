"""Atomic manifests; no database and no partially visible JSON writes."""
import json
import re
import threading
from collections import defaultdict
from pathlib import Path
from typing import Callable

from .config import settings

_locks: dict[str, threading.RLock] = defaultdict(threading.RLock)
_ID = re.compile(r'^[a-zA-Z0-9_-]{1,80}$')


def job_dir(job_id: str) -> Path:
    if not _ID.fullmatch(job_id):
        raise ValueError('Invalid job id')
    return settings.out_dir / job_id


def read_manifest(job_id: str) -> dict:
    with _locks[job_id]:
        return json.loads((job_dir(job_id) / 'manifest.json').read_text(encoding='utf-8'))


def update_manifest(job_id: str, fn: Callable[[dict], object]) -> dict:
    with _locks[job_id]:
        directory = job_dir(job_id)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / 'manifest.json'
        current = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        fn(current)
        temporary = directory / 'manifest.json.tmp'
        temporary.write_text(
            json.dumps(current, ensure_ascii=False, allow_nan=False, indent=2),
            encoding='utf-8',
        )
        temporary.replace(path)
        return current


def create_manifest(job_id: str, value: dict) -> dict:
    return update_manifest(job_id, lambda m: m.update(value))
