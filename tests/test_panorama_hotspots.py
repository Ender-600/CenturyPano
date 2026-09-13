"""Check actual image resampling, seam geometry, and bounded multi-view detection."""
import asyncio
import io

import numpy as np
from PIL import Image
import pytest

from app.worlds import panorama_hotspots as pano


def object_detection(**updates):
    return {'label': 'Stone entrance', 'kind': 'building', 'confidence': .9,
            'point': [500, 500], 'bbox': [400, 350, 600, 650], **updates}


def encoded_panorama():
    u, v = np.meshgrid((np.arange(2048) + .5) / 2048, (np.arange(1024) + .5) / 1024)
    pixels = np.stack((128 + 100 * np.sin(u * 2 * np.pi), v * 255,
                       128 + 100 * np.cos(u * 2 * np.pi)), axis=-1).astype(np.uint8)
    out = io.BytesIO()
    Image.fromarray(pixels).save(out, 'PNG')
    return out.getvalue()


@pytest.mark.parametrize('yaw,pitch,point,expected', [
    (0, 0, [.5, .5], [.5, .5]), (90, 0, [.5, .5], [.75, .5]),
    (180, 0, [.5, .5], [0, .5]), (270, 0, [.5, .5], [.25, .5]),
    (0, 30, [.5, .5], [.5, 1 / 3]), (0, 0, [1, .5], [.625, .5]),
    (0, 0, [.5, 0], [.5, .25]), (0, 0, [.5, 1], [.5, .75]),
])
def test_perspective_axes_agree_with_panorama_texture(yaw, pitch, point, expected):
    np.testing.assert_allclose(pano.view_to_panorama(point, yaw=yaw, pitch=pitch), expected, atol=1e-8)


@pytest.mark.parametrize('yaw,pitch', [(0, 0), (90, 0), (180, 0), (270, 0), (45, 30), (180, -70)])
def test_resampled_pixels_match_mapped_points_including_seam_and_tilt(yaw, pitch):
    rendered = pano.perspective_jpeg(encoded_panorama(), yaw=yaw, pitch=pitch, size=129)
    pixels = np.asarray(Image.open(io.BytesIO(rendered))).astype(float)
    for x, y in [(64, 64), (18, 22), (108, 94)]:
        u, v = pano.view_to_panorama([(x + .5) / 129, (y + .5) / 129], yaw=yaw, pitch=pitch)
        expected = [128 + 100 * np.sin(u * 2 * np.pi), v * 255, 128 + 100 * np.cos(u * 2 * np.pi)]
        np.testing.assert_allclose(pixels[y, x], expected, atol=4)


def test_bad_points_are_rejected_instead_of_replaced_by_box_centres():
    values = [object_detection(point=[900, 900]), object_detection(point=None),
              object_detection(confidence=None), object_detection(confidence=.3),
              object_detection(point=[50, 500], bbox=[0, 350, 200, 650]), None]
    with pytest.raises(ValueError, match='well-grounded'):
        pano.validate_view_hotspots({'hotspots': values}, 0)
    assert pano.validate_view_hotspots({'hotspots': []}, 0) == []
    with pytest.raises(ValueError):
        pano.validate_view_hotspots({'wrong_key': []}, 0)
    assert len(pano.validate_view_hotspots({'hotspots': values + [object_detection(id='model-object')]}, 0)) == 1


def test_wrapped_boxes_and_deduplication_preserve_seam_objects_and_distinct_features():
    item = pano.validate_view_hotspots({'hotspots': [object_detection()]}, 3)[0]
    assert item['bbox'][0] > item['bbox'][2]
    assert item['point'] == [0, .5]
    duplicate = {**item, 'id': 'h1', 'point': [.999, .5], 'confidence': .8}
    distinct = {**item, 'id': 'h2', 'point': [.5, .5], 'bbox': [.45, .4, .55, .6]}
    merged = pano.merge_panorama_hotspots({'0': {'items': [item, duplicate, distinct]}})
    assert {entry['id'] for entry in merged} == {'h18', 'h2'}
    assert pano._wrapped_iou([.98, .4, .02, .6], [.99, .4, .03, .6]) == pytest.approx(.6)


@pytest.mark.asyncio
async def test_six_perspectives_use_bounded_concurrency_and_retry_only_failed_views(monkeypatch):
    calls, active, peak = 0, 0, 0
    async def vlm(image, prompt, **kwargs):
        nonlocal calls, active, peak
        calls += 1
        this_call = calls
        active += 1
        peak = max(peak, active)
        assert Image.open(io.BytesIO(image)).size == (pano.VIEW_SIZE, pano.VIEW_SIZE)
        try:
            await asyncio.sleep(.01)
            if this_call == 2:
                raise RuntimeError('provider failed')
            return {'hotspots': [object_detection()]}, 10
        finally:
            active -= 1
    monkeypatch.setattr(pano, '_vlm_json', vlm)
    progress = []
    first = await pano.detect_panorama_hotspots(encoded_panorama(), on_progress=lambda views, failed: progress.append(len(views)))
    assert calls == 6 and 1 <= peak <= 3 and len(first['views']) == 5
    assert len(first['failed_views']) == 1 and len(first['items']) == 5
    second = await pano.detect_panorama_hotspots(encoded_panorama(), completed=first['views'])
    assert calls == 7 and len(second['items']) == 6 and second['failed_views'] == []
    assert second['tokens'] == 60 and progress[-1] == 5


@pytest.mark.asyncio
async def test_explanation_receives_the_detected_perspective_and_local_box(monkeypatch):
    item = pano.validate_view_hotspots({'hotspots': [object_detection()]}, 3)[0]
    image = encoded_panorama()
    async def explain(crop, local, **context):
        assert crop == pano.perspective_jpeg(image, **item['view'])
        assert local['bbox'] == [.4, .35, .6, .65]
        assert context['year'] == 1926
        return {'label': 'Stone entrance'}
    monkeypatch.setattr(pano, 'explain_hotspot', explain)
    assert await pano.explain_panorama_hotspot(image, item, year=1926) == {'label': 'Stone entrance'}


def test_flat_images_are_not_misinterpreted_as_full_panoramas():
    out = io.BytesIO()
    Image.new('RGB', (800, 600)).save(out, 'JPEG')
    with pytest.raises(ValueError, match='2:1'):
        pano.perspective_jpeg(out.getvalue(), yaw=0)
