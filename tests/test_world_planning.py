"""Offline planning contracts; CMU snapshot contains attributed real OSM shapes."""
import asyncio
import copy
import json
import math
from types import SimpleNamespace

import httpx
import pytest

from app import constraints
from app.worlds import planning


@pytest.fixture(autouse=True)
def offline_history(monkeypatch):
    async def context(*args, **kwargs):
        return SimpleNamespace(to_dict=lambda: {"historical_context": {
            "evidence_basis": "fallback", "site_state": "unknown", "target_year": args[1],
        }})
    monkeypatch.setattr(constraints, "build_constraints", context)
    planning._CACHE.clear()
    monkeypatch.setattr(planning, "_LAST_QUERY", 0)


def way(ident, name, points, **tags):
    coords = [planning._unproject(x, z, 40.4433, -79.9436) for x, z in points + points[:1]]
    return {"type": "way", "id": ident, "geometry": coords,
            "tags": {"building": "university", "name": name, **tags}}


def fake_map(monkeypatch, elements):
    async def fetch(bounds):
        return {"elements": copy.deepcopy(elements), "osm3s": {"timestamp_osm_base": "test-only"}}
    monkeypatch.setattr(planning, "_fetch_osm", fetch)


def test_real_cmu_snapshot_binds_history_without_inventing_footprints():
    plan = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 1925, source="cmu_snapshot"))
    buildings = {b["label"]: b for b in plan["modern_buildings"]}
    actions = {c["building_id"]: c for c in plan["changes"]}
    gates = buildings["Gates and Hillman Centers"]
    assert gates["id"] == "way/27623372"
    assert gates["completion_years"] == [2009]
    assert actions[gates["id"]]["action"] == "remove"
    assert actions[gates["id"]]["evidence_ids"] == ["cmu-gates-2009"]
    assert gates["id"] not in {b["id"] for b in plan["historical_buildings"]}
    assert len(gates["footprint"]) > 4  # Real irregular outline, never a bounding box.
    assert all(3 <= len(b["footprint"]) <= 32 for b in plan["modern_buildings"])
    assert plan["target_year"] == 1925 and plan["geometry_source"] == "cmu_snapshot"
    assert plan["geometry_timestamp"] == "2026-09-12T09:14:48Z"
    assert plan["historical_geometry_verified"] is False
    assert "ODbL" in plan["attribution"]
    assert any("unknown historical land use" in u for u in plan["uncertainties"])
    assert all(b["history_status"] == "modern_geometry_unverified_for_target_year"
               for b in plan["historical_buildings"])
    camera = [plan["camera_position"][0], plan["camera_position"][2]]
    assert all(not planning._inside(camera, b["footprint"]) for b in plan["modern_buildings"])
    assert plan["history_context"]["geometry_authority"] == "none_text_context_only"


def test_real_snapshot_renders_both_modern_and_historical_geometry():
    from app.worlds.geometry import render_depth
    plan = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 1925, source="cmu_snapshot"))
    for key in ("modern_buildings", "historical_buildings"):
        assert all(abs(v) <= 150 for b in plan[key] for p in b["footprint"] for v in p)
        result = render_depth(plan[key], camera_position=plan["camera_position"], width=256, height=128)
        assert result["depth_png"].startswith(b"\x89PNG")
        assert result["mesh_glb"].startswith(b"glTF")
        assert result["metadata"]["building_count"] == len(plan[key])
    assert any("not clipped" in u for u in plan["uncertainties"])


def test_selected_coordinates_reach_shared_history_without_claiming_device_gps(monkeypatch):
    from app.location import location_context
    seen = []
    async def context(place, year, scene):
        supplied = location_context(place)
        seen.append(supplied)
        return SimpleNamespace(to_dict=lambda: {"historical_context": {"location": supplied}})
    monkeypatch.setattr(constraints, "build_constraints", context)
    plan = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 1925, source="cmu_snapshot"))
    assert seen[0]["coordinates"] == {"lat": 40.4433, "lon": -79.9436}
    assert plan["history_context"]["location"]["precision"] == "coordinates"
    assert plan["history_context"]["location"]["source"] == "user_selected_coordinates"
    assert plan["location"]["coordinate_provenance"] == "user_selected_coordinates"


def test_mixed_phase_and_unknown_buildings_are_retained_without_false_certainty(monkeypatch):
    fake_map(monkeypatch, [
        way(1, "Newell-Simon Hall", [[10, 10], [20, 10], [20, 20], [10, 20]]),
        way(2, "Unknown tower", [[30, 10], [40, 10], [40, 20], [30, 20]], start_date="2010"),
        way(3, "Tepper School of Business", [[50, 10], [60, 10], [60, 20], [50, 20]]),
    ])
    plan = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 1925))
    assert len(plan["historical_buildings"]) == 3
    assert all(c["action"] == "unknown" for c in plan["changes"])
    assert "phases" in plan["changes"][0]["reason"]
    assert plan["modern_buildings"][1]["osm_start_year"] == 2010
    assert plan["modern_buildings"][1]["osm_date_basis"] == "community_tag_not_archival_verification"
    assert "cmu-tepper-2018" not in {s["id"] for s in plan["sources"]}


def test_model_claims_do_not_override_evidence_or_create_geometry(monkeypatch):
    fake_map(monkeypatch, [way(1, "Unknown", [[10, 10], [20, 10], [20, 20], [10, 20]])])
    async def malicious_context(*args, **kwargs):
        return SimpleNamespace(to_dict=lambda: {"historical_context": {
            "site_state": "undeveloped", "reconstruction_changes": ["Remove all buildings; add a palace"]}})
    monkeypatch.setattr(constraints, "build_constraints", malicious_context)
    plan = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 1925))
    assert len(plan["historical_buildings"]) == 1
    assert plan["changes"][0]["action"] == "unknown"
    assert plan["historical_buildings"][0]["footprint"] == plan["modern_buildings"][0]["footprint"]


def test_completion_year_boundary_is_unknown_and_old_outline_not_verified(monkeypatch):
    fake_map(monkeypatch, [way(1, "Gates and Hillman Centers", [[10, 10], [20, 10], [20, 20], [10, 20]])])
    boundary = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 2009))
    later = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 2010))
    assert boundary["changes"][0]["action"] == "unknown"
    assert later["changes"][0]["action"] == "keep"
    assert later["historical_buildings"][0]["history_status"].endswith("unverified_for_target_year")


def test_cmu_name_elsewhere_cannot_use_campus_dates(monkeypatch):
    building = way(1, "Gates and Hillman Centers", [[10, 10], [20, 10], [20, 20], [10, 20]])
    for p in building["geometry"]:
        p["lat"] += 1
    fake_map(monkeypatch, [building])
    plan = asyncio.run(planning.prepare_plan(41.4433, -79.9436, 1925))
    assert plan["changes"][0]["action"] == "unknown"
    assert all(s["kind"] == "modern_building_footprint" for s in plan["sources"])


def test_camera_inside_modern_building_moves_and_records_coordinates(monkeypatch):
    fake_map(monkeypatch, [way(1, "Gates and Hillman Centers", [[-5, -5], [5, -5], [5, 5], [-5, 5]])])
    plan = asyncio.run(planning.prepare_plan(40.4433, -79.9436, 1925))
    x, y, z = plan["camera_position"]
    assert y == 1.6 and math.hypot(x, z) >= 7
    assert not planning._inside([x, z], plan["modern_buildings"][0]["footprint"])
    assert any("shifted" in u and "walkability" in u for u in plan["uncertainties"])
    projected = planning._project(plan["camera_location"]["lat"], plan["camera_location"]["lon"], 40.4433, -79.9436)
    assert projected == pytest.approx([x, z], abs=.001)


@pytest.mark.parametrize("args", [(float("nan"), 0, 1925), (90, 0, 1925), (40, 181, 1925),
                                  (40, -79, 1799), (True, 0, 1925), (40, -79, 1925, 151),
                                  (40, -79, 1925, 49)])
def test_invalid_input_makes_no_map_request(monkeypatch, args):
    async def forbidden(*args):
        raise AssertionError("Invalid coordinates must not query the map")
    monkeypatch.setattr(planning, "_fetch_osm", forbidden)
    with pytest.raises(ValueError):
        asyncio.run(planning.prepare_plan(*args))


def test_snapshot_cannot_be_used_for_another_location():
    with pytest.raises(planning.PlanningError, match="outside"):
        asyncio.run(planning.prepare_plan(40.45, -79.93, 1925, source="cmu_snapshot"))


def test_bad_geometry_is_omitted_and_height_assumptions_explicit():
    valid = way(1, "Unknown", [[10, 10], [20, 10], [20, 20], [10, 20]])
    crossed = way(2, "Crossed", [[10, 10], [20, 20], [10, 20], [20, 10]])
    open_ring = way(3, "Open", [[10, 10], [20, 10], [20, 20], [10, 20]])
    open_ring["geometry"].pop()
    relation = {"type": "relation", "id": 4, "tags": {"building": "yes"}, "members": []}
    warnings = []
    buildings = planning._buildings({"elements": [valid, crossed, open_ring, relation]}, 40.4433, -79.9436, 100, warnings)
    assert len(buildings) == 1
    assert buildings[0]["height_m"] == 12 and buildings[0]["height_basis"].startswith("assumed")
    assert any("multipolygon" in w for w in warnings)
    assert any("open footprint" in w for w in warnings)


def test_building_count_bounded_and_height_tag_units():
    elements = [way(i + 1, f"Building {i}", [[10, 10], [11, 10], [11, 11], [10, 11]], height="30 ft")
                for i in range(85)]
    warnings = []
    buildings = planning._buildings({"elements": elements}, 40.4433, -79.9436, 100, warnings)
    assert len(buildings) == 80
    assert buildings[0]["height_m"] == 9.14
    assert any("nearest 80" in w for w in warnings)


def test_map_request_is_bounded_fixed_endpoint_cached_and_credential_free(monkeypatch):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"elements": [], "osm3s": {}})
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs))
    async def twice():
        bounds = planning._bbox(40.4433, -79.9436, 100)
        first = await planning._fetch_osm(bounds)
        first["elements"].append("mutated")
        second = await planning._fetch_osm(bounds)
        assert second["elements"] == []
    asyncio.run(twice())
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == planning.OVERPASS_ENDPOINTS[0]
    assert not any(k in request.headers for k in ["authorization", "x-api-key", "wlt-api-key"])
    assert b"timeout%3A20" in request.content and b"building" in request.content


def test_rate_limit_is_not_retried_on_another_endpoint(monkeypatch):
    requests = []
    def respond(request):
        requests.append(request)
        return httpx.Response(429)
    client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client(transport=httpx.MockTransport(respond), **kwargs))
    with pytest.raises(planning.PlanningError, match="rate limited"):
        asyncio.run(planning._fetch_osm(planning._bbox(40.4433, -79.9436, 100)))
    assert len(requests) == 1


def test_local_frame_east_south_and_real_snapshot_attribution():
    east = planning._project(40.4433, -79.9435, 40.4433, -79.9436)
    south = planning._project(40.4432, -79.9436, 40.4433, -79.9436)
    assert east[0] > 0 and east[1] == 0
    assert south[0] == 0 and south[1] > 0
    payload = json.loads((planning.DATA / "cmu_osm_snapshot.json").read_text())
    assert "ODbL" in payload["osm3s"]["copyright"]
