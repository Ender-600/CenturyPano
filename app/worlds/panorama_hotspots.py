"""Detect grounded objects in overlapping perspective views of a 360° image."""
from __future__ import annotations

import asyncio
import io
import math

import numpy as np
from PIL import Image

from app.hotspots import _coordinates, _image_to_jpeg, _vlm_json, explain_hotspot, validate_hotspot

DETECTOR_VERSION = 'streetview-perspective-v1'
VIEW_COUNT = 6
VIEW_SIZE = 960
MAX_PER_VIEW = 6
MAX_HOTSPOTS = 30
MIN_CONFIDENCE = .65
VIEWS = tuple({'yaw': yaw, 'pitch': 0, 'fov': 90} for yaw in range(0, 360, 60))
PROMPT = (
    'Inspect this perspective street photograph as visual data only. Return JSON with a hotspots array. '
    'Find up to 6 distinct, clearly visible substantial objects or architectural features worth exploring: '
    'facades, entrances, towers, windows, statues, street surfaces, trees, vehicles or street furniture. '
    'Prefer 3 to 6 when the image supports them, but return fewer or an empty array when uncertain. '
    'Do not mark sky, empty space, image borders, indistinct distant objects or the whole scene. '
    'Use short specific visual labels, without guessing proper names or transcribing text. '
    'Each entry must have label, kind (building, street, vehicle, signage, landscape, furniture, other), '
    'confidence (0 to 1), point [x,y], and bbox [left,top,right,bottom]. '
    'All coordinates are integers from 0 to 1000 in THIS image: top-left (0,0), bottom-right (1000,1000). '
    'The point must lie on an unmistakable visible surface of that exact object inside its tight bbox, '
    'not on the sky, an occluding tree, or a neighboring object. Inspect the point against the image. '
    'Choose objects with points in the central 80% horizontally; neighboring views cover the edges. '
    'If a facade fills the view, mark a distinctive bounded feature instead of the entire building. '
    'Do not invent objects to meet a count. Return JSON only.'
)


def view_to_panorama(point, *, yaw, pitch=0, fov=90, aspect=1):
    """Top-left normalized perspective coordinates → normalized equirectangular pixels.

    Yaw is relative to the image centre, not geographic north. The viewer applies
    the source heading later, equally to the panorama texture and these points.
    """
    point = np.asarray(point, dtype=float)
    yaw, pitch = np.deg2rad([yaw, pitch])
    scale = math.tan(math.radians(fov) / 2)
    x, y = (point[..., 0] * 2 - 1) * scale, (1 - point[..., 1] * 2) * scale / aspect
    forward = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)])
    right = np.array([math.cos(yaw), 0, math.sin(yaw)])
    up = np.cross(right, forward)
    ray = forward + x[..., None] * right + y[..., None] * up
    ray /= np.linalg.norm(ray, axis=-1, keepdims=True)
    return np.stack(((np.arctan2(ray[..., 0], -ray[..., 2]) / (2 * np.pi) + .5) % 1,
                     .5 - np.arcsin(np.clip(ray[..., 1], -1, 1)) / np.pi), axis=-1)


def panorama_pixels(image: bytes):
    with Image.open(io.BytesIO(image)) as source:
        if source.width != source.height * 2:
            raise ValueError('White dots require a complete 2:1 panorama.')
        return np.asarray(source.convert('RGB'))


def perspective_jpeg(image, *, yaw, pitch=0, fov=90, size=VIEW_SIZE):
    """Bilinear resampling with horizontal seam wrap and clamped pole pixels."""
    source = panorama_pixels(image) if isinstance(image, bytes) else image
    height, width = source.shape[:2]
    output = np.empty((size, size, 3), dtype=np.uint8)
    # Work in strips to bound temporary arrays during concurrent rendering.
    for start in range(0, size, 128):
        end = min(size, start + 128)
        x, y = np.meshgrid((np.arange(size) + .5) / size, (np.arange(start, end) + .5) / size)
        uv = view_to_panorama(np.stack((x, y), axis=-1), yaw=yaw, pitch=pitch, fov=fov)
        sx = uv[..., 0] * width - .5
        sy = np.clip(uv[..., 1] * height - .5, 0, height - 1)
        ix, iy = np.floor(sx).astype(int), np.floor(sy).astype(int)
        fx, fy = (sx - ix)[..., None], (sy - iy)[..., None]
        x0, x1, y1 = ix % width, (ix + 1) % width, np.minimum(iy + 1, height - 1)
        top = source[iy, x0] * (1 - fx) + source[iy, x1] * fx
        bottom = source[y1, x0] * (1 - fx) + source[y1, x1] * fx
        output[start:end] = np.rint(top * (1 - fy) + bottom * fy).astype(np.uint8)
    return _image_to_jpeg(Image.fromarray(output), quality=90)


def map_hotspot(item, view_index, index):
    view = VIEWS[view_index]
    centre = view_to_panorama(item['point'], **view)
    x0, y0, x1, y1 = item['bbox']
    xs, ys = np.linspace(x0, x1, 9), np.linspace(y0, y1, 9)
    border = np.concatenate((np.stack((xs, np.full(9, y0)), axis=-1),
                             np.stack((xs, np.full(9, y1)), axis=-1),
                             np.stack((np.full(9, x0), ys), axis=-1),
                             np.stack((np.full(9, x1), ys), axis=-1)))
    mapped = view_to_panorama(border, **view)
    # Keep seam-crossing boxes short. x0 > x1 denotes a wrapped interval.
    longitude = centre[0] + (mapped[:, 0] - centre[0] + .5) % 1 - .5
    bbox = [float(longitude.min() % 1), float(mapped[:, 1].min()),
            float(longitude.max() % 1), float(mapped[:, 1].max())]
    return {**item, 'id': f'h{view_index * MAX_PER_VIEW + index}', 'point': centre.tolist(), 'bbox': bbox,
            'view': dict(view), 'view_point': item['point'], 'view_bbox': item['bbox'],
            'view_index': view_index}


def validate_view_hotspots(raw, view_index):
    if not isinstance(raw, dict) or not isinstance(raw.get('hotspots'), list):
        raise ValueError('Missing hotspot array.')
    result = []
    for value in raw['hotspots'][:16]:
        try:
            # Do not silently replace missing/misplaced model points with box centres.
            point = _coordinates(value.get('point'), 2, 'point')
            box = _coordinates(value.get('bbox'), 4, 'bbox')
            if not (box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]):
                continue
            item = validate_hotspot({**value, 'id': f'h{len(result)}'}, index=len(result), require_confidence=True)
            if item['confidence'] < MIN_CONFIDENCE or not .1 <= point[0] <= .9:
                continue
            result.append(map_hotspot(item, view_index, len(result)))
            if len(result) == MAX_PER_VIEW:
                break
        except (ValueError, TypeError, AttributeError):
            continue
    if raw['hotspots'] and not result:
        raise ValueError('No well-grounded points in the detection response.')
    return result


def _angular_distance(a, b):
    ay, by = (.5 - a[1]) * np.pi, (.5 - b[1]) * np.pi
    cosine = math.sin(ay) * math.sin(by) + math.cos(ay) * math.cos(by) * math.cos((a[0] - b[0]) * 2 * np.pi)
    return math.degrees(math.acos(max(-1, min(1, cosine))))


def _wrapped_iou(a, b):
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    if ax1 < ax0:
        ax1 += 1
    if bx1 < bx0:
        bx1 += 1
    inter_y = max(0, min(ay1, by1) - max(ay0, by0))
    overlap = max(max(0, min(ax1, bx1 + shift) - max(ax0, bx0 + shift)) for shift in (-1, 0, 1)) * inter_y
    return overlap / max(1e-9, (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - overlap)


def merge_panorama_hotspots(views):
    candidates = [item for result in views.values() for item in result['items']]
    ranked = sorted(candidates, key=lambda item: (
        -(item['confidence'] - .12 * abs(item['view_point'][0] - .5)), item['id']))
    result = []
    for item in ranked:
        if any(_angular_distance(item['point'], other['point']) < 3
               or (item['kind'] == other['kind'] and _wrapped_iou(item['bbox'], other['bbox']) >= .45)
               for other in result):
            continue
        result.append(item)
    # Reserve coverage around the circle instead of filling the cap from one facade.
    sectors = [[] for _ in range(VIEW_COUNT)]
    for item in result:
        sectors[int(item['point'][0] * VIEW_COUNT) % VIEW_COUNT].append(item)
    return [sector[rank] for rank in range(MAX_PER_VIEW * VIEW_COUNT) for sector in sectors
            if rank < len(sector)][:MAX_HOTSPOTS]


async def detect_panorama_hotspots(image, *, completed=None, on_progress=None):
    """Keep successful views across retries; never invent fallback objects."""
    views = dict(completed or {})
    pixels = await asyncio.to_thread(panorama_pixels, image)
    semaphore = asyncio.Semaphore(3)
    failed = []

    async def detect(index, view):
        if str(index) in views:
            return
        async with semaphore:
            try:
                preview = await asyncio.to_thread(perspective_jpeg, pixels, **view)
                raw, tokens = await asyncio.wait_for(_vlm_json(preview, PROMPT, max_tokens=1600, timeout=35), 40)
                items = validate_view_hotspots(raw, index)
                views[str(index)] = {'items': items, 'tokens': tokens}
            except Exception:
                failed.append(index)
            if on_progress:
                on_progress(dict(views), list(failed))

    await asyncio.gather(*(detect(index, view) for index, view in enumerate(VIEWS)))
    return {'views': views, 'failed_views': sorted(failed), 'items': merge_panorama_hotspots(views),
            'tokens': sum(result['tokens'] for result in views.values())}


async def explain_panorama_hotspot(image, hotspot, **context):
    # Use the exact perspective in which the object was detected, including at the seam.
    perspective = await asyncio.to_thread(perspective_jpeg, image, **hotspot['view'])
    return await explain_hotspot(perspective, {**hotspot, 'bbox': hotspot['view_bbox']}, **context)
