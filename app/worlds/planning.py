"""Bounded OSM massing plans; curated dates can remove, never invent, geometry.

Coordinates are meters east/up/south from the requested GPS. Every retained
modern footprint is explicitly unverified as historical geometry. Text-model
context is auxiliary and never drives building selection or geometry edits.
"""
from __future__ import annotations

import asyncio
import copy
import json
import math
import re
import time
from pathlib import Path

import httpx

from app.temporal import resolve_year

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
MAX_BUILDINGS = 80
MAX_VERTICES = 32
MAX_COORDINATE_M = 150
MAX_RESPONSE_BYTES = 2_000_000
EARTH_RADIUS = 6_371_008.8
DATA = Path(__file__).with_name("data")
_CACHE: dict[str, tuple[float, dict]] = {}
_QUERY_LOCK = asyncio.Lock()
_LAST_QUERY = 0.0


class PlanningError(ValueError):
    """Fixed, user-readable failures without response bodies or credentials."""


def _number(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PlanningError(f"{name} must be a finite number")
    if not math.isfinite(value) or not low <= value <= high:
        raise PlanningError(f"{name} is outside the supported range")
    return float(value)


def _bbox(lat, lon, radius):
    dlat = math.degrees(radius / EARTH_RADIUS)
    dlon = dlat / math.cos(math.radians(lat))
    if lon - dlon < -180 or lon + dlon > 180:
        raise PlanningError("A block crossing the antimeridian is unsupported")
    return [lat - dlat, lon - dlon, lat + dlat, lon + dlon]


def _project(lat, lon, origin_lat, origin_lon):
    return [math.radians(lon - origin_lon) * EARTH_RADIUS * math.cos(math.radians(origin_lat)),
            -math.radians(lat - origin_lat) * EARTH_RADIUS]


def _unproject(x, z, lat, lon):
    return {"lat": lat - math.degrees(z / EARTH_RADIUS),
            "lon": lon + math.degrees(x / (EARTH_RADIUS * math.cos(math.radians(lat))))}


def _distance(point, start, end):
    dx, dz = end[0] - start[0], end[1] - start[1]
    denominator = dx * dx + dz * dz
    t = min(1.0, max(0.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) /
                         denominator)) if denominator else 0.0
    return math.hypot(point[0] - start[0] - t * dx, point[1] - start[1] - t * dz)


def _area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2


def _inside(point, ring):
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if _distance(point, a, b) < 0.01:
            return True
        if (a[1] > point[1]) != (b[1] > point[1]):
            cross_x = (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
            if point[0] < cross_x:
                inside = not inside
    return inside


def _simple(ring):
    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    edges = list(zip(ring, ring[1:] + ring[:1]))
    for i, (a, b) in enumerate(edges):
        for j, (c, d) in enumerate(edges):
            if j <= i + 1 or (i == 0 and j == len(edges) - 1):
                continue
            if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
                return False
            if min(_distance(a, c, d), _distance(b, c, d), _distance(c, a, b), _distance(d, a, b)) < 1e-7:
                return False
    return True


def _simplify(ring):
    """Remove only near-collinear vertices, with measured <=3m deviation.

    Returning None deliberately omits complex shapes instead of inventing a box.
    """
    original = ring[:]
    while len(ring) > MAX_VERTICES:
        options = sorted((_distance(p, ring[i - 1], ring[(i + 1) % len(ring)]), i)
                         for i, p in enumerate(ring))
        accepted = False
        for distance, index in options:
            if distance > 3:
                break
            candidate = ring[:index] + ring[index + 1:]
            edges = list(zip(candidate, candidate[1:] + candidate[:1]))
            error = max(min(_distance(p, a, b) for a, b in edges) for p in original)
            if error <= 3 and abs(_area(candidate) - _area(original)) <= .03 * _area(original) and _simple(candidate):
                ring = candidate
                accepted = True
                break
        if not accepted:
            return None
    return ring


def _height(tags):
    value = str(tags.get("height", ""))
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(m|ft)?", value)
    if match:
        height = float(match[1]) * (.3048 if match[2] == "ft" else 1)
        if 1 <= height <= 150:
            return height, "osm_height_community_unverified"
    try:
        levels = float(tags.get("building:levels", ""))
        if 1 <= levels <= 50:
            return levels * 3, "estimated_from_osm_levels_at_3m"
    except (TypeError, ValueError):
        pass
    return 12.0, "assumed_12m_no_height_evidence"


async def _fetch_osm(bounds):
    global _LAST_QUERY
    bbox = ",".join(f"{value:.7f}" for value in bounds)
    query = f'[out:json][timeout:20];(way["building"]({bbox});relation["building"]({bbox}););out body geom;'
    cached = _CACHE.get(query)
    if cached and time.monotonic() - cached[0] < 3600:
        return copy.deepcopy(cached[1])
    async with _QUERY_LOCK:
        cached = _CACHE.get(query)
        if cached and time.monotonic() - cached[0] < 3600:
            return copy.deepcopy(cached[1])
        if time.monotonic() - _LAST_QUERY < 5:
            raise PlanningError("Map lookup is busy; retry in a few seconds")
        _LAST_QUERY = time.monotonic()
        async with httpx.AsyncClient(timeout=25, follow_redirects=False, trust_env=False,
                                     headers={"User-Agent": "CenturyPanoHackCMU/0.1 (building-plan preview)"}) as client:
            for endpoint in OVERPASS_ENDPOINTS:
                try:
                    async with asyncio.timeout(25), client.stream("POST", endpoint, data={"data": query}) as response:
                        if response.status_code in (429, 406):
                            _LAST_QUERY = time.monotonic() + 25  # Enforce a 30-second pause, including other callers.
                            raise PlanningError("Public map service is rate limited; retry after 30 seconds")
                        response.raise_for_status()
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise PlanningError("Map response exceeds the block size limit")
                    payload = json.loads(body)
                    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list) or payload.get("remark"):
                        raise PlanningError("Map service returned an incomplete building query")
                    payload["retrieval_endpoint"] = endpoint
                    if len(_CACHE) >= 32:
                        _CACHE.pop(next(iter(_CACHE)))
                    _CACHE[query] = (time.monotonic(), copy.deepcopy(payload))
                    return payload
                except (TimeoutError, httpx.HTTPError, ValueError) as exc:
                    if isinstance(exc, PlanningError):
                        raise
        raise PlanningError("Public map lookup is unavailable; choose the documented CMU snapshot or retry")


def _snapshot(bounds):
    path = DATA / "cmu_osm_snapshot.json"
    if not path.is_file():
        raise PlanningError("The CMU map snapshot is unavailable")
    payload = json.loads(path.read_text())
    south, west, north, east = payload["query_bounds"]
    if not (south <= bounds[0] <= bounds[2] <= north and west <= bounds[1] <= bounds[3] <= east):
        raise PlanningError("The requested block is outside the CMU snapshot coverage")
    return payload


def _buildings(payload, lat, lon, radius, uncertainties):
    buildings = []
    elements = payload["elements"]
    if len(elements) > 1000:
        raise PlanningError("Map response contains too many elements")
    for element in elements:
        if not isinstance(element, dict):
            continue
        tags = element.get("tags", {})
        if not isinstance(tags, dict) or not tags.get("building") or tags["building"] == "no":
            continue
        ident = f"{element.get('type')}/{element.get('id')}"
        if element.get("type") != "way":
            uncertainties.append(f"{ident}: multipolygon/holes are unsupported and omitted, not filled in.")
            continue
        if not isinstance(element.get("id"), int) or element["id"] <= 0:
            continue
        geometry = element.get("geometry", [])
        if not isinstance(geometry, list) or not 4 <= len(geometry) <= 1000:
            uncertainties.append(f"{ident}: missing or oversized footprint omitted.")
            continue
        try:
            ring = [_project(_number(p["lat"], -85, 85, "Map latitude"),
                             _number(p["lon"], -180, 180, "Map longitude"), lat, lon) for p in geometry]
        except (KeyError, TypeError, PlanningError):
            uncertainties.append(f"{ident}: invalid coordinates omitted.")
            continue
        if math.dist(ring[0], ring[-1]) > .1:
            uncertainties.append(f"{ident}: open footprint omitted.")
            continue
        ring.pop()
        # Entire real outline is retained; no clipping into invented walls.
        if not _inside([0, 0], ring) and all(_distance([0, 0], a, b) > radius
                                           for a, b in zip(ring, ring[1:] + ring[:1])):
            continue
        if any(abs(value) > MAX_COORDINATE_M for point in ring for value in point) or not 1 <= _area(ring) <= 150_000:
            uncertainties.append(f"{ident}: complete footprint exceeds ±150m rendering bounds and was omitted; it was not clipped into invented walls.")
            continue
        if not _simple(ring):
            uncertainties.append(f"{ident}: self-intersecting footprint omitted.")
            continue
        original_count = len(ring)
        ring = _simplify(ring)
        if ring is None:
            uncertainties.append(f"{ident}: cannot simplify faithfully to 32 vertices; footprint omitted.")
            continue
        if original_count > MAX_VERTICES:
            uncertainties.append(f"{ident}: OSM outline simplified within 3m deviation and 3% area change.")
        height, height_basis = _height(tags)
        building = {"id": ident, "footprint": [[round(v, 3) for v in p] for p in ring],
                    "height_m": round(height, 2), "label": str(tags.get("name") or f"OSM building {element['id']}")[:160],
                    "sources": [f"osm-{ident}"], "height_basis": height_basis,
                    "footprint_basis": "simplified_osm_max_3m_deviation" if original_count > MAX_VERTICES else "osm_outline",
                    "history_status": "modern_geometry_unverified_for_target_year"}
        start_date = str(tags.get("start_date", ""))
        if re.fullmatch(r"\d{4}(?:-\d{2}(?:-\d{2})?)?", start_date):
            building["osm_start_year"] = int(start_date[:4])
            building["osm_date_basis"] = "community_tag_not_archival_verification"
        buildings.append(building)
    buildings.sort(key=lambda b: (min(math.hypot(*p) for p in b["footprint"]), b["id"]))
    if len(buildings) > MAX_BUILDINGS:
        uncertainties.append("Only the nearest 80 intersecting building footprints are included.")
    return buildings[:MAX_BUILDINGS]


def _camera_obstacles(payload, lat, lon):
    """Use full outlines even when omitted from the bounded rendering plan."""
    rings = []
    for element in payload["elements"]:
        if not isinstance(element, dict) or not isinstance(element.get("tags"), dict) or not element["tags"].get("building"):
            continue
        geometries = [element.get("geometry", [])]
        if element.get("type") == "relation":
            # Conservatively avoid closed outer areas; do not claim courtyards are clear.
            geometries += [m.get("geometry", []) for m in element.get("members", [])
                           if isinstance(m, dict) and m.get("role") == "outer"]
        for geometry in geometries:
            if not isinstance(geometry, list) or not 4 <= len(geometry) <= 1000:
                continue
            try:
                ring = [_project(_number(p["lat"], -85, 85, "Map latitude"),
                                 _number(p["lon"], -180, 180, "Map longitude"), lat, lon) for p in geometry]
            except (KeyError, TypeError, PlanningError):
                continue
            if math.dist(ring[0], ring[-1]) < .1 and all(abs(v) <= 500 for p in ring for v in p):
                rings.append(ring[:-1])
    return rings


def _camera(rings, lat, lon, radius, uncertainties):
    def clear(x, z):
        return all(not _inside([x, z], ring) and
                   min(_distance([x, z], a, c) for a, c in
                       zip(ring, ring[1:] + ring[:1])) >= 2
                   for ring in rings)
    candidates = [(0, 0)]
    for distance in range(2, int(radius) + 1, 2):
        candidates.extend((distance * math.sin(math.radians(angle)), distance * math.cos(math.radians(angle)))
                          for angle in range(0, 360, 15))
    for x, z in candidates:
        if clear(x, z):
            if x or z:
                uncertainties.append("Requested camera intersects/is within 2m of a mapped building; shifted to the nearest sampled clear point. Terrain, access and walkability remain unverified.")
            return [round(x, 3), 1.6, round(z, 3)], _unproject(x, z, lat, lon)
    raise PlanningError("No camera point clear of mapped buildings was found in this block")


def _apply_curated_dates(buildings, lat, lon, year, uncertainties):
    records = json.loads((DATA / "cmu_history.json").read_text())
    scope = records["scope"]
    in_scope = scope["south"] <= lat <= scope["north"] and scope["west"] <= lon <= scope["east"]
    aliases = {re.sub(r"[^a-z0-9]", "", alias.lower()): record for record in records["buildings"]
               for alias in record["aliases"]} if in_scope else {}
    changes, historical, used_sources = [], [], set()
    for building in buildings:
        record = aliases.get(re.sub(r"[^a-z0-9]", "", building["label"].lower()))
        evidence = record["evidence_ids"] if record else []
        action = "unknown"
        reason = "No bound archival date or target-year footprint. Retained only as an unverified modern massing placeholder."
        if record:
            building["sources"].extend(evidence)
            used_sources.update(evidence)
            dates = record["completion_years"]
            building["completion_years"] = dates
            if record.get("mixed_phases"):
                reason = "Documented construction phases span multiple years; modern footprint does not identify each phase. No whole-building deletion is justified."
            elif year < min(dates):
                action = "remove"
                building["start_year"] = min(dates)
                building["date_basis"] = "completion_date_not_construction_start"
                reason = f"Official CMU completion/opening evidence postdates {year}. Remove the completed modern building; earlier structures and construction-stage geometry remain unknown."
                uncertainties.append(f"{building['label']}: removed modern massing does not prove vacant land, grass, parking, or the absence of a predecessor in {year}.")
            elif year > max(dates):
                action = "keep"
                reason = "Documented completion predates the reference year; retained modern outline and height still require historical-shape verification."
            else:
                reason = "Reference year overlaps a completion/opening year; exact date and construction geometry require review."
        changes.append({"building_id": building["id"], "action": action, "reason": reason, "evidence_ids": evidence})
        if action != "remove":
            historical.append(copy.deepcopy(building))
    return historical, changes, [s for s in records["sources"] if s["id"] in used_sources]


async def prepare_plan(lat: float, lon: float, year: int, radius_m=100, *, source="osm") -> dict:
    """Prepare reviewable historical massing, making no image/world API calls.

    ``cmu_snapshot`` explicitly uses the dated public OSM example. Live lookup
    never silently substitutes fabricated or example geometry for another place.
    """
    lat = _number(lat, -85, 85, "Latitude")
    lon = _number(lon, -180, 180, "Longitude")
    radius = _number(radius_m, 50, 150, "Radius")
    year = resolve_year(year)
    bounds = _bbox(lat, lon, radius)
    if source not in {"osm", "cmu_snapshot"}:
        raise PlanningError("Map source must be osm or cmu_snapshot")
    payload = await _fetch_osm(bounds) if source == "osm" else _snapshot(bounds)
    uncertainties = [
        "OSM supplies present-day community mapping, not a historical survey; coverage may be incomplete.",
        "Building heights are community tags, level-based estimates, or explicitly assumed 12m; roofs, terrain and elevation are not reconstructed.",
        "Retained modern footprints are unverified for the target year. Removed footprints leave unknown historical land use, not proven empty land.",
    ]
    if source == "cmu_snapshot":
        uncertainties.append("Using a dated CMU OSM snapshot, not a live map query.")
    buildings = _buildings(payload, lat, lon, radius, uncertainties)
    if not buildings:
        raise PlanningError("No usable building footprints were returned for this block")
    camera, camera_location = _camera(_camera_obstacles(payload, lat, lon), lat, lon, radius, uncertainties)
    historical, changes, sources = _apply_curated_dates(buildings, lat, lon, year, uncertainties)
    sources = [{"id": f"osm-{b['id']}", "title": f"OpenStreetMap: {b['label']}",
                "url": f"https://www.openstreetmap.org/{b['id']}", "kind": "modern_building_footprint",
                "evidence_basis": "community_mapped_modern_geometry"} for b in buildings] + sources
    # Existing text history is auxiliary. It cannot mutate the selected geometries.
    from app.constraints import build_constraints
    from app.scene import DEFAULT_SCENE_SPEC
    # The shared photo helper accepts coordinates under its geolocation mode.
    # These coordinates were explicitly selected for planning, not read from a device.
    context = await build_constraints({"name": "Pittsburgh" if 40.3 < lat < 40.6 and -80.1 < lon < -79.8 else "Supplied location",
                                       "lat": lat, "lon": lon, "source": "geolocation", "prompt_safe": True,
                                       "coordinate_provenance": "user_selected_coordinates"},
                                      year, DEFAULT_SCENE_SPEC)
    history_context = context.to_dict()["historical_context"]
    history_context["geometry_authority"] = "none_text_context_only"
    history_context["curated_evidence_ids"] = [s["id"] for s in sources if s["kind"] != "modern_building_footprint"]
    history_context["reference_date"] = f"{year}-07-01"
    if isinstance(history_context.get("location"), dict):
        history_context["location"]["source"] = "user_selected_coordinates"
    return {"location": {"lat": lat, "lon": lon, "radius_m": radius,
                          "coordinate_provenance": "user_selected_coordinates"}, "target_year": year,
            "modern_buildings": buildings, "historical_buildings": historical, "changes": changes,
            "sources": sources, "uncertainties": uncertainties, "history_context": history_context,
            "camera_position": camera, "camera_location": camera_location, "heading_deg": 0,
            "coordinate_frame": "east_up_south_meters", "geometry_source": source,
            "geometry_timestamp": payload.get("osm3s", {}).get("timestamp_osm_base"),
            "attribution": "© OpenStreetMap contributors; ODbL https://www.openstreetmap.org/copyright",
            "status": "needs_review", "historical_geometry_verified": False}
