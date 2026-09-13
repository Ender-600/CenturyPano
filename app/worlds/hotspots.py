"""Cached white dots and explanations for saved historical Street View images."""
from __future__ import annotations

import asyncio
from hashlib import sha256
import json

from fastapi import HTTPException

from app.worlds.jobs import _write_json
from app.worlds.panorama_hotspots import (
    DETECTOR_VERSION, VIEW_COUNT, detect_panorama_hotspots, explain_panorama_hotspot, merge_panorama_hotspots,
)


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
        if not isinstance(data, dict) or data.get('image_sha256') != image_hash or data.get('detector_version') != DETECTOR_VERSION:
            previous = self.detections.pop(job_id, None)
            if previous:
                previous.cancel()
            data = {'items': [], 'fallback': False, 'provisional': False, 'status': 'pending',
                    'retryable': True, 'tokens': 0, 'views': {}, 'failed_views': [],
                    'progress': {'completed': 0, 'total': VIEW_COUNT},
                    'revision': _revision([]), 'image_sha256': image_hash, 'detector_version': DETECTOR_VERSION}
            _write_json(cache_path, data)
        if data['provisional'] and job_id not in self.detections:
            # A restart must not leave the browser polling a dead worker forever.
            data.update(provisional=False, retryable=True, status='partial' if data['items'] else 'error')
            _write_json(cache_path, data)
        if refine and data.get('retryable') and job_id not in self.detections:
            if len(self.detections) >= 2:
                raise HTTPException(429, 'Too many panoramas are being inspected. Try again shortly.')
            if len(data['views']) == VIEW_COUNT and not data['items']:
                data['views'] = {}  # Explicit retry after a valid but empty detection.
            data.update(provisional=True, status='detecting', retryable=False)
            _write_json(cache_path, data)

            def publish(views, failed, *, finished=False):
                items = merge_panorama_hotspots(views)
                for item in items:
                    item['revision'] = _revision([{key: value for key, value in item.items() if key != 'revision'}])
                missing = len(views) < VIEW_COUNT
                status = ('partial' if items else 'error') if missing else ('ready' if items else 'empty')
                data.update(views=views, failed_views=failed, items=items, revision=_revision(items),
                            tokens=sum(result['tokens'] for result in views.values()),
                            progress={'completed': len(views), 'total': VIEW_COUNT},
                            provisional=not finished, status=status if finished else 'detecting',
                            retryable=finished and (missing or not items))
                _write_json(cache_path, data)

            async def run():
                try:
                    image = await asyncio.to_thread(path.read_bytes)
                    result = await detect_panorama_hotspots(image, completed=data['views'], on_progress=publish)
                    publish(result['views'], result['failed_views'], finished=True)
                except Exception:
                    publish(data['views'], [index for index in range(VIEW_COUNT) if str(index) not in data['views']], finished=True)
                finally:
                    if self.detections.get(job_id) is asyncio.current_task():
                        self.detections.pop(job_id, None)

            self.detections[job_id] = asyncio.create_task(run())
        return {key: value for key, value in data.items() if key != 'views'}

    async def explain(self, job_id, hotspot_id, revision):
        data = self.get(job_id)
        hotspot = next((item for item in data['items'] if item['id'] == hotspot_id), None)
        if hotspot is None:
            raise HTTPException(404, 'That highlighted region was not found.')
        if revision not in (data['revision'], hotspot.get('revision')):
            raise HTTPException(409, 'The highlighted regions have updated. Tap a white dot again.')
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
                    result = await explain_panorama_hotspot(image, hotspot, year=plan['target_year'],
                                                           place={'name': context.get('place_name', 'Street View capture location')},
                                                           historical_context=context, scene=None)
                    _write_json(cache, result)
                    return result
                finally:
                    self.explanations.pop(key, None)

            self.explanations[key] = asyncio.create_task(run())
            self.explanations[key].add_done_callback(lambda task: None if task.cancelled() else task.exception())
        try:
            return await asyncio.shield(self.explanations[key])
        except Exception:
            raise HTTPException(502, 'The explanation service did not respond. Please try again.') from None
