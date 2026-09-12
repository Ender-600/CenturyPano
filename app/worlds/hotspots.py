"""Cached white dots and explanations for saved historical Street View images."""
from __future__ import annotations

import asyncio
from hashlib import sha256
import json

from fastapi import HTTPException

from app.hotspots import DETECTOR_VERSION, detect_hotspots, explain_hotspot, instant_hotspots
from app.worlds.jobs import _write_json


def _revision(items):
    return sha256(json.dumps(items, sort_keys=True).encode()).hexdigest()


class WorldHotspots:
    def __init__(self, manager):
        self.manager = manager
        self.detections = {}
        self.explanations = {}

    async def aclose(self):
        tasks = [*self.detections.values(), *self.explanations.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.detections.clear()
        self.explanations.clear()

    def _image(self, job_id):
        try:
            job = self.manager.get(job_id)
        except ValueError:
            job = None
        if job is None:
            raise HTTPException(404, 'World job not found.')
        if job.get('input_kind') != 'streetview_panorama':
            raise HTTPException(409, 'White dots require a historical Street View panorama.')
        asset = next((item for item in job['assets'] if item['kind'] == 'historical_pano'), None)
        path = self.manager.artifact_path(job_id, asset['filename']) if asset else None
        if path is None:
            raise HTTPException(409, 'Wait for the historical panorama to finish first.')
        return path, asset['sha256']

    def get(self, job_id, *, refine=False):
        path, image_hash = self._image(job_id)
        cache_path = path.parent / 'hotspots.json'
        try:
            data = json.loads(cache_path.read_text())
        except (OSError, ValueError):
            data = {}
        if data.get('image_sha256') != image_hash or data.get('detector_version') != DETECTOR_VERSION:
            # These are regions to explore, not identified objects, until detection finishes.
            items = instant_hotspots()
            for index, item in enumerate(items):
                item.update(label=f'Scene detail {index + 1}', kind='other')
            data = {'items': items, 'fallback': True, 'provisional': True, 'tokens': 0,
                    'revision': _revision(items), 'image_sha256': image_hash, 'detector_version': DETECTOR_VERSION}
            _write_json(cache_path, data)
        if refine and data['provisional'] and job_id not in self.detections:
            if len(self.detections) >= 6:
                raise HTTPException(429, 'Too many panoramas are being inspected. Try again shortly.')

            async def run():
                try:
                    image = await asyncio.to_thread(path.read_bytes)
                    result = await detect_hotspots(image, provider='openai')
                    # Preserve neutral labels if the shared detector could not identify objects.
                    if not result.get('fallback'):
                        data.update(items=result['items'], fallback=False)
                    data.update(provisional=False, tokens=result.get('tokens', 0), revision=_revision(data['items']))
                    _write_json(cache_path, data)
                except Exception:
                    data['provisional'] = False
                    _write_json(cache_path, data)
                finally:
                    self.detections.pop(job_id, None)

            self.detections[job_id] = asyncio.create_task(run())
        return data

    async def explain(self, job_id, hotspot_id, revision):
        data = self.get(job_id)
        if data['revision'] != revision:
            raise HTTPException(409, 'The highlighted regions have updated. Tap a white dot again.')
        hotspot = next((item for item in data['items'] if item['id'] == hotspot_id), None)
        if hotspot is None:
            raise HTTPException(404, 'That highlighted region was not found.')
        path, image_hash = self._image(job_id)
        # Use the frozen generation plan, so a changed year/location cannot relabel this image.
        plan = json.loads((path.parent / 'plan.json').read_text())
        context = plan.get('history_context') or {}
        key = sha256(json.dumps([image_hash, hotspot, plan['target_year'], context], sort_keys=True).encode()).hexdigest()
        cache = path.parent / f'explanation-{key}.json'
        if cache.is_file():
            return json.loads(cache.read_text())
        if key not in self.explanations:
            if len(self.explanations) >= 6:
                raise HTTPException(429, 'Too many explanations are running. Try again shortly.')

            async def run():
                try:
                    image = await asyncio.to_thread(path.read_bytes)
                    result = await explain_hotspot(image, hotspot, year=plan['target_year'],
                                                   place={'name': context.get('place_name', 'Street View capture location')},
                                                   historical_context=context, scene=None)
                    _write_json(cache, result)
                    return result
                finally:
                    self.explanations.pop(key, None)

            self.explanations[key] = asyncio.create_task(run())
        try:
            return await asyncio.shield(self.explanations[key])
        except Exception:
            raise HTTPException(502, 'The explanation service did not respond. Please try again.') from None
