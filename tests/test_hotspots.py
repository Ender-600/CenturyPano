from app.hotspots import (
    demo_hotspots,
    filter_by_confidence,
    merge_hotspots,
    validate_explanation,
    validate_hotspot,
    validate_hotspots,
    _detection_windows,
    _map_local_to_global,
)


def test_demo_hotspots_are_valid():
    items = validate_hotspots({"hotspots": demo_hotspots()})
    assert len(items) >= 2
    assert items[0]["id"] == "h0"
    assert len(items[0]["point"]) == 2
    assert items[0]["confidence"] >= 0.5


def test_qwen_coordinates_are_normalized():
    hotspot = validate_hotspot({
        "id": "h0",
        "label": "clock",
        "kind": "furniture",
        "point": [250, 400],
        "bbox": [200, 300, 300, 500],
        "confidence": 0.8,
    }, index=0)
    assert hotspot["point"] == [0.25, 0.4]
    assert hotspot["bbox"] == [0.2, 0.3, 0.3, 0.5]


def test_rejects_oversized_bbox():
    try:
        validate_hotspot({"id": "h0", "label": "whole scene", "kind": "other", "bbox": [0, 0, 0.9, 0.9]}, index=0)
    except ValueError:
        return
    raise AssertionError("expected oversized bbox to fail")


def test_explanation_fields():
    value = validate_explanation({
        "label": "awning",
        "distinctive": "A deep striped valance projects over the storefront.",
        "significance": "Canvas awnings advertised a shop while shading its display windows.",
        "present": "metal",
        "past": "canvas",
        "uncertainty": "color guessed",
    })
    assert value["label"] == "awning"
    assert value["significance"].startswith("Canvas")


def test_merge_deduplicates_nearby_points():
    candidates = [
        {"id": "h0", "label": "shopfront", "kind": "building", "point": [0.5, 0.4], "bbox": [0.4, 0.3, 0.6, 0.6], "confidence": 0.9},
        {"id": "h1", "label": "storefront", "kind": "building", "point": [0.51, 0.41], "bbox": [0.42, 0.32, 0.58, 0.58], "confidence": 0.7},
        {"id": "h2", "label": "streetcar", "kind": "vehicle", "point": [0.2, 0.7], "bbox": [0.1, 0.6, 0.3, 0.85], "confidence": 0.8},
    ]
    merged = merge_hotspots(candidates)
    assert len(merged) == 2
    assert merged[0]["label"] == "shopfront"


def test_confidence_filter():
    items = [
        {"id": "h0", "label": "a", "kind": "other", "point": [0.2, 0.2], "bbox": [0.1, 0.1, 0.3, 0.3], "confidence": 0.9},
        {"id": "h1", "label": "b", "kind": "other", "point": [0.5, 0.5], "bbox": [0.4, 0.4, 0.6, 0.6], "confidence": 0.2},
    ]
    kept = filter_by_confidence(items, minimum=0.55)
    assert len(kept) == 1
    assert kept[0]["id"] == "h0"


def test_local_to_global_mapping():
    point, bbox = _map_local_to_global([0.5, 0.5], [0.25, 0.25, 0.75, 0.75], (100, 50, 300, 250), (1000, 500))
    assert abs(point[0] - 0.2) < 1e-6
    assert abs(point[1] - 0.3) < 1e-6
    assert abs(bbox[0] - 0.15) < 1e-6


def test_detection_windows_overlap_on_wide_images():
    windows = _detection_windows(4000, 1000)
    assert len(windows) >= 2
    assert windows[0][0] == 0
    assert windows[-1][2] == 4000
