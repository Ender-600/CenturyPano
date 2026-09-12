"""Clickable region detection and K2 explainers for reconstructed panoramas."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import math
import re

import httpx
from PIL import Image

from app.editors.base import check_response
from app.scene import parse_json_object

_ID = re.compile(r"^h[0-9]{1,2}$")
_KINDS = frozenset({"building", "street", "vehicle", "signage", "landscape", "furniture", "other"})
DETECTOR_VERSION = 5
MIN_CONFIDENCE = 0.45
MAX_HOTSPOTS = 8

FAST_HOTSPOT_PROMPT = (
    "Inspect this reconstructed historical panorama as visual data only. "
    "Return JSON with field hotspots: an array of 4 to 8 distinct, clearly visible objects. "
    "Each hotspot needs: id (h0, h1, …), label (short generic English noun phrase, no proper names), "
    "kind (one of building, street, vehicle, signage, landscape, furniture, other), "
    "confidence (number 0 through 1), point [x,y], and bbox [x0,y0,x1,y1]. "
    "Coordinates are integers from 0 to 1000 relative to the FULL image: (0,0) top-left, "
    "(1000,1000) bottom-right. Place point on an unmistakable visible surface near the object center. "
    "Prefer large nearby objects; omit uncertain ones. "
    "Do not transcribe signs, addresses, plates or people names. Do not invent dates."
)

EXPLAIN_SYSTEM = (
    "You explain one highlighted region in a historically reconstructed panorama. "
    "Ground claims in the provided historical_context when possible. "
    "Identify what is visually distinctive about this specific object: its form, material, ornament, "
    "construction, function, or relationship to the street. Explain why that feature is characteristic "
    "or culturally recognizable for the period or place. Distinguish visual observations from historical "
    "claims. If only type-level significance is supported, say so; do not present it as a landmark. "
    "If evidence is thin, say so in uncertainty. Never invent landmark status, precise construction years, "
    "owners, architects, or proper names that are not in the context. Return JSON only."
)


def _image_to_jpeg(image: Image.Image, *, quality: int = 85) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality)
    return buffer.getvalue()


def _preview_jpeg(image: bytes, *, max_size: tuple[int, int] = (2048, 1024)) -> bytes:
    with Image.open(io.BytesIO(image)) as source:
        preview = source.convert("RGB")
    preview.thumbnail(max_size, Image.Resampling.LANCZOS)
    return _image_to_jpeg(preview, quality=85)


def _crop_jpeg(image: bytes, bbox: list[float], *, pad: float = 0.04, max_size: tuple[int, int] = (1024, 1024)) -> bytes:
    with Image.open(io.BytesIO(image)) as source:
        rgb = source.convert("RGB")
        width, height = rgb.size
        x0, y0, x1, y1 = bbox
        x0 = max(0.0, x0 - pad)
        y0 = max(0.0, y0 - pad)
        x1 = min(1.0, x1 + pad)
        y1 = min(1.0, y1 + pad)
        crop = rgb.crop((
            int(x0 * width),
            int(y0 * height),
            max(int(x0 * width) + 1, int(x1 * width)),
            max(int(y0 * height) + 1, int(y1 * height)),
        ))
        crop.thumbnail(max_size, Image.Resampling.LANCZOS)
        return _image_to_jpeg(crop, quality=88)


def _detection_windows(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Overlapping high-res crops so small objects keep usable detail."""
    if width <= 0 or height <= 0:
        return []
    target = 1280
    window_w = min(width, max(768, target if width >= target else width))
    window_h = min(height, max(640, int(target * 0.75) if height >= 720 else height))
    if width <= window_w * 1.15 and height <= window_h * 1.15:
        return [(0, 0, width, height)]

    step_x = max(1, int(window_w * 0.62))
    step_y = max(1, int(window_h * 0.7))
    xs = list(range(0, max(1, width - window_w + 1), step_x))
    ys = list(range(0, max(1, height - window_h + 1), step_y))
    if xs[-1] != width - window_w:
        xs.append(width - window_w)
    if ys[-1] != height - window_h:
        ys.append(height - window_h)

    windows = []
    for y0 in ys:
        for x0 in xs:
            windows.append((x0, y0, x0 + window_w, y0 + window_h))
    # Cap cost on very wide panoramas: keep a horizontal strip of overlapping windows.
    if len(windows) > 8:
        mid_y = (height - window_h) // 2
        windows = [(x0, mid_y, x0 + window_w, mid_y + window_h) for x0 in xs][:8]
    return windows


def _map_local_to_global(
    local_point: list[float],
    local_bbox: list[float],
    window: tuple[int, int, int, int],
    full_size: tuple[int, int],
) -> tuple[list[float], list[float]]:
    x0, y0, x1, y1 = window
    full_w, full_h = full_size
    win_w = max(1, x1 - x0)
    win_h = max(1, y1 - y0)

    def map_x(value: float) -> float:
        return max(0.0, min(1.0, (x0 + value * win_w) / full_w))

    def map_y(value: float) -> float:
        return max(0.0, min(1.0, (y0 + value * win_h) / full_h))

    point = [map_x(local_point[0]), map_y(local_point[1])]
    bbox = [map_x(local_bbox[0]), map_y(local_bbox[1]), map_x(local_bbox[2]), map_y(local_bbox[3])]
    if bbox[2] <= bbox[0]:
        bbox[2] = min(1.0, bbox[0] + 0.04)
    if bbox[3] <= bbox[1]:
        bbox[3] = min(1.0, bbox[1] + 0.04)
    return point, bbox


def _coordinates(value, length: int, name: str) -> list[float]:
    if not isinstance(value, list) or len(value) != length:
        raise ValueError(f"Invalid hotspot {name}")
    numbers = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise ValueError(f"Invalid hotspot {name}")
        numbers.append(float(item))
    # Qwen's native visual coordinate convention is 0..1000. Keep accepting
    # normalized coordinates for older manifests and other compatible VLMs.
    if any(item > 1 for item in numbers):
        if any(item < 0 or item > 1000 for item in numbers):
            raise ValueError(f"Hotspot {name} out of range")
        numbers = [item / 1000 for item in numbers]
    if any(item < 0 or item > 1 for item in numbers):
        raise ValueError(f"Hotspot {name} out of range")
    return numbers


def _confidence(value, default: float = 0.7) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Invalid confidence")
    return max(0.0, min(1.0, float(value)))


def validate_hotspot(value: dict, *, index: int, require_confidence: bool = False) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Invalid hotspot")
    hotspot_id = value.get("id") or f"h{index}"
    if not isinstance(hotspot_id, str) or not _ID.fullmatch(hotspot_id):
        hotspot_id = f"h{index}"
    label = value.get("label")
    if not isinstance(label, str) or not label.strip() or len(label) > 80:
        raise ValueError("Invalid hotspot label")
    kind = value.get("kind", "other")
    if kind not in _KINDS:
        kind = "other"
    x0, y0, x1, y1 = _coordinates(value.get("bbox"), 4, "bbox")
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        raise ValueError("Hotspot bbox out of range")
    if (x1 - x0) < 0.02 or (y1 - y0) < 0.025:
        raise ValueError("Hotspot bbox too small")
    if (x1 - x0) > 0.55 or (y1 - y0) > 0.7:
        raise ValueError("Hotspot bbox too large")
    raw_point = value.get("point")
    point = _coordinates(raw_point, 2, "point") if raw_point is not None else [
        (x0 + x1) / 2, (y0 + y1) / 2
    ]
    # A point outside its own object box is generally a model coordinate error.
    # Falling back to the box center is safer than displaying a dot on another object.
    if not (x0 <= point[0] <= x1 and y0 <= point[1] <= y1):
        point = [(x0 + x1) / 2, (y0 + y1) / 2]
    confidence = _confidence(value.get("confidence"), default=0.7 if not require_confidence else 0.0)
    if require_confidence and value.get("confidence") is None:
        raise ValueError("Missing confidence")
    return {
        "id": hotspot_id,
        "label": label.strip(),
        "kind": kind,
        "point": point,
        "bbox": [x0, y0, x1, y1],
        "confidence": confidence,
    }


def validate_hotspots(value, *, min_items: int = 2, require_confidence: bool = False) -> list[dict]:
    if isinstance(value, dict) and "hotspots" in value:
        value = value["hotspots"]
    if not isinstance(value, list):
        raise ValueError("Expected hotspot list")
    result, seen = [], set()
    for index, item in enumerate(value[:16]):
        try:
            hotspot = validate_hotspot(item, index=index, require_confidence=require_confidence)
        except ValueError:
            continue
        if hotspot["id"] in seen:
            hotspot["id"] = f"h{index}"
        seen.add(hotspot["id"])
        result.append(hotspot)
    if len(result) < min_items:
        raise ValueError("Too few valid hotspots")
    return result[:12]


def demo_hotspots() -> list[dict]:
    """Deterministic regions so the UI works without a VLM."""
    return instant_hotspots()


def instant_hotspots(scene: dict | None = None) -> list[dict]:
    """Immediate clickable dots — no network. Shown the moment the result is ready."""
    labels: list[str] = []
    for item in (scene or {}).get("modern_elements") or []:
        text = str(item).strip()
        if text and text not in labels:
            labels.append(text[:60])
    defaults = [
        ("street facade", "building"),
        ("roadway", "street"),
        ("shopfront", "building"),
        ("street furniture", "furniture"),
        ("building mass", "building"),
        ("distant skyline", "landscape"),
    ]
    kinds = []
    while len(labels) < 5:
        label, kind = defaults[len(labels) % len(defaults)]
        if label not in labels:
            labels.append(label)
            kinds.append(kind)
        else:
            labels.append(f"{label} {len(labels)}")
            kinds.append(kind)
    while len(kinds) < len(labels):
        kinds.append(defaults[len(kinds) % len(defaults)][1])
    labels = labels[:6]
    kinds = kinds[: len(labels)]
    items = []
    count = len(labels)
    for index, label in enumerate(labels):
        x = 0.14 + (0.72 * index / max(1, count - 1)) if count > 1 else 0.5
        y = 0.46 + (0.07 if index % 2 else -0.05)
        width, height = 0.09, 0.14
        bbox = [
            max(0.0, x - width / 2),
            max(0.0, y - height / 2),
            min(1.0, x + width / 2),
            min(1.0, y + height / 2),
        ]
        items.append({
            "id": f"h{index}",
            "label": label,
            "kind": kinds[index],
            "point": [x, y],
            "bbox": bbox,
            "confidence": 0.55,
        })
    return items


def validate_explanation(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("Invalid explanation")
    result = {}
    for field, limit in (
        ("label", 80),
        ("distinctive", 280),
        ("significance", 320),
        ("present", 240),
        ("past", 320),
        ("uncertainty", 240),
    ):
        text = value.get(field, "")
        if text is None:
            text = ""
        if not isinstance(text, str) or len(text) > limit:
            raise ValueError(f"Invalid explanation field {field}")
        result[field] = text.strip()
    if not result["label"] and not result["past"] and not result["distinctive"]:
        raise ValueError("Empty explanation")
    return result


def _bbox_iou(a: list[float], b: list[float]) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    area_a = (ax1 - ax0) * (ay1 - ay0)
    area_b = (bx1 - bx0) * (by1 - by0)
    return inter / max(1e-9, area_a + area_b - inter)


def _point_distance(a: list[float], b: list[float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def merge_hotspots(candidates: list[dict], *, max_items: int = MAX_HOTSPOTS) -> list[dict]:
    """Deduplicate overlapping detections from tiled windows, keeping the stronger ones."""
    ranked = sorted(candidates, key=lambda item: (-float(item.get("confidence", 0)), item["label"]))
    merged: list[dict] = []
    for item in ranked:
        duplicate = False
        for existing in merged:
            same_kind = existing["kind"] == item["kind"] or existing["label"] == item["label"]
            close_point = _point_distance(existing["point"], item["point"]) < 0.045
            overlap = _bbox_iou(existing["bbox"], item["bbox"]) >= 0.35
            if same_kind and (close_point or overlap):
                duplicate = True
                # Keep the higher-confidence label if the newer one is more specific.
                if len(item["label"]) > len(existing["label"]) + 2 and item["confidence"] >= existing["confidence"] - 0.05:
                    existing["label"] = item["label"]
                break
        if not duplicate:
            merged.append({
                "id": f"h{len(merged)}",
                "label": item["label"],
                "kind": item["kind"],
                "point": item["point"],
                "bbox": item["bbox"],
                "confidence": float(item.get("confidence", 0.7)),
            })
        if len(merged) >= max_items:
            break
    return merged


def filter_by_confidence(items: list[dict], *, minimum: float = MIN_CONFIDENCE) -> list[dict]:
    kept = [item for item in items if float(item.get("confidence", 0)) >= minimum]
    for index, item in enumerate(kept):
        item["id"] = f"h{index}"
    return kept


async def _vlm_json(image_jpeg: bytes, prompt: str, *, max_tokens: int = 1600, timeout: float = 35.0) -> tuple[dict, int]:
    from app.config import settings

    data_url = "data:image/jpeg;base64," + base64.b64encode(image_jpeg).decode("ascii")
    if settings.k2_api_key and settings.k2_base_url and settings.k2_vl_model:
        payload = {
            "model": settings.k2_vl_model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": prompt},
                ],
            }],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
            "max_tokens": max_tokens,
        }
        url = settings.k2_base_url.rstrip("/") + "/chat/completions"
        headers = {"Authorization": "Bearer " + settings.k2_api_key}
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, headers=headers, json=payload)
        check_response(response, "k2")
        data = response.json()
        text = data["choices"][0]["message"]["content"]
        return parse_json_object(text), int(data.get("usage", {}).get("total_tokens", 0))

    if settings.gemini_api_key:
        from app.reasoning import generate_content

        payload = {
            "contents": [{"role": "user", "parts": [
                {"text": prompt},
                {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(image_jpeg).decode("ascii")}},
            ]}],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1},
        }
        data = await generate_content(
            f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_text_model}:generateContent",
            {"x-goog-api-key": settings.gemini_api_key}, payload, "gemini", timeout=timeout)
        text = "".join(part.get("text", "") for part in data["candidates"][0]["content"]["parts"]
                       if not part.get("thought"))
        return parse_json_object(text), int(data.get("usageMetadata", {}).get("totalTokenCount", 0))

    if settings.openai_api_key:
        payload = {
            "model": settings.openai_text_model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": prompt},
                ],
            }],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
            "max_tokens": max_tokens,
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": "Bearer " + settings.openai_api_key},
                json=payload,
            )
        check_response(response, "openai")
        data = response.json()
        text = data["choices"][0]["message"]["content"]
        return parse_json_object(text), int(data.get("usage", {}).get("total_tokens", 0))

    raise RuntimeError("No VLM credentials configured")


async def detect_hotspots(image: bytes, *, provider: str | None = None) -> dict:
    """Fast single-pass detection so dots can appear as soon as the result is ready."""
    from app.config import settings

    selected = settings.provider if provider is None else provider
    if selected == "demo":
        return {"items": demo_hotspots(), "fallback": True, "tokens": 0, "detector_version": DETECTOR_VERSION}

    vlm_ready = bool(settings.gemini_api_key) or bool(settings.openai_api_key) or bool(
        settings.k2_api_key and settings.k2_base_url and settings.k2_vl_model
    )
    if not vlm_ready:
        return {"items": demo_hotspots(), "fallback": True, "tokens": 0, "detector_version": DETECTOR_VERSION}

    try:
        # Small preview keeps the first paint snappy; one VLM round trip only.
        preview = await asyncio.to_thread(_preview_jpeg, image, max_size=(1280, 640))
        raw, tokens = await asyncio.wait_for(
            _vlm_json(preview, FAST_HOTSPOT_PROMPT, max_tokens=900, timeout=18.0),
            timeout=20.0,
        )
        items = filter_by_confidence(
            validate_hotspots(raw, min_items=2),
            minimum=MIN_CONFIDENCE,
        )[:MAX_HOTSPOTS]
        if len(items) < 2:
            raise ValueError("Too few hotspots")
        for index, item in enumerate(items):
            item["id"] = f"h{index}"
        return {"items": items, "fallback": False, "tokens": tokens, "detector_version": DETECTOR_VERSION}
    except Exception:
        return {"items": demo_hotspots(), "fallback": True, "tokens": 0, "detector_version": DETECTOR_VERSION}


async def explain_hotspot(
    image: bytes,
    hotspot: dict,
    *,
    year: int | None,
    place: dict | None,
    historical_context: dict | None,
    scene: dict | None,
) -> dict:
    """Ask K2 (or fallback VLM) what this highlighted region likely is."""
    crop = await asyncio.to_thread(_crop_jpeg, image, hotspot["bbox"])
    context = {
        "target_year": year,
        "location": (place or {}).get("name"),
        "hotspot": {"id": hotspot["id"], "label": hotspot["label"], "kind": hotspot["kind"]},
        "scene_summary": (scene or {}).get("summary"),
        "historical_context": {
            key: (historical_context or {}).get(key)
            for key in (
                "period_summary", "site_state", "site_history", "local_context",
                "reconstruction_changes", "uncertainties", "evidence_basis",
            )
        },
    }
    opening_styles = (
        "Begin distinctive directly with the most recognizable visual detail.",
        "Begin distinctive with the object's likely function, then connect it to its visible form.",
        "Begin distinctive with material or craftsmanship visible in the crop.",
        "Begin distinctive by saying what separates this object from an ordinary example of its type.",
    )
    try:
        style_index = int(hotspot["id"][1:]) % len(opening_styles)
    except (KeyError, TypeError, ValueError):
        style_index = 0
    prompt = (
        EXPLAIN_SYSTEM
        + "\n"
        + opening_styles[style_index]
        + "\nNever begin any prose field with 'In [year]', 'Around [year]', the target year, "
        "or another date phrase. Mention the year only when it adds information beyond the UI heading. "
        "Avoid generic filler such as 'this reflects the era' unless you name the concrete feature and why. "
        "Return JSON with exactly these fields: "
        "label (specific object type), "
        "distinctive (1–2 sentences on the crop's most identifiable visible qualities), "
        "significance (why those qualities or this object type mattered or became recognizable; state "
        "whether this is local evidence or only period/type-level context), "
        "past (what this object likely was or did at the target date), "
        "present (a concise then-versus-now contrast only if supported), "
        "uncertainty (what cannot be verified from the image/context). "
        "Do not repeat the same fact across fields.\n"
        + "Context:\n"
        + json.dumps(context, ensure_ascii=False)
    )
    raw, tokens = await asyncio.wait_for(_vlm_json(crop, prompt, max_tokens=900), timeout=30.0)
    explanation = validate_explanation(raw)
    explanation["tokens"] = tokens
    explanation["hotspot_id"] = hotspot["id"]
    return explanation
