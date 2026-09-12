"""Offline entity editing; no source URLs or model APIs are contacted."""
import copy

import pytest

from app.worlds.edits import PlanEditError, apply_edits


def building(identifier, x=10, *, label="Current building"):
    return {"id": identifier, "label": label,
            "footprint": [[x, 10], [x + 4, 10], [x + 4, 14], [x, 14]],
            "height_m": 12, "sources": ["osm-1", "cmu-1"], "completion_years": [2009],
            "history_status": "modern_geometry_unverified_for_target_year"}


@pytest.fixture
def plan():
    return {
        "location": {"lat": 40.4433, "lon": -79.9436, "radius_m": 100}, "target_year": 1925,
        "camera_position": [0, 1.6, 0], "heading_deg": 0,
        "modern_buildings": [building("way/1"), building("way/2", 20)],
        "historical_buildings": [building("way/2", 20)],
        "sources": [{"id": "osm-1", "evidence_basis": "community_mapped_modern_geometry"},
                    {"id": "cmu-1", "evidence_basis": "primary_source_completion_date", "claim": "Completed 2009"}],
        "changes": [{"building_id": "way/1", "action": "remove", "reason": "Completed after 1925",
                     "evidence_ids": ["cmu-1"]},
                    {"building_id": "way/2", "action": "unknown", "reason": "No historical footprint",
                     "evidence_ids": []}],
        "uncertainties": ["Original uncertainty"], "status": "needs_review",
        "history_context": {"evidence_basis": "fallback"},
    }


def edit(identifier, action, **extra):
    return {"building_id": identifier, "action": action,
            "reason": "User-supplied interpretation of an archive drawing.",
            "source_title": "User-provided archive reference", "source_url": "https://example.org/archive/1925",
            **extra}


def shape(x=30):
    return {"footprint": [[x, 10], [x + 5, 10], [x + 5, 15], [x, 15]], "height_m": 6}


def test_add_replace_remove_and_restore_are_atomic_and_preserve_original_claims(plan):
    before = copy.deepcopy(plan)
    operations = [edit("historic-workshop", "add", label="Earlier workshop", **shape()),
                  edit("way/1", "replace", label="Earlier predecessor", **shape(40)),
                  edit("way/2", "remove"), edit("way/2", "keep")]
    result = apply_edits(plan, operations)
    assert plan == before
    assert result is not plan and result["modern_buildings"] == before["modern_buildings"]
    assert result["sources"][:2] == before["sources"]
    selected = {b["id"]: b for b in result["historical_buildings"]}
    assert set(selected) == {"historic-workshop", "way/1", "way/2"}
    assert selected["way/1"]["footprint"] == shape(40)["footprint"]
    assert selected["way/2"]["footprint"] == before["modern_buildings"][1]["footprint"]
    assert "completion_years" not in selected["way/1"]
    assert selected["historic-workshop"]["label"] == "Earlier workshop"
    assert all(b["evidence_basis"] == "user_supplied_unverified" for b in selected.values())
    assert len(result["edit_history"]) == 4
    replacement = next(h for h in result["edit_history"] if h["building_id"] == "way/1")
    assert replacement["previous_change"] == before["changes"][0]
    assert result["target_year"] == 1925 and result["historical_geometry_verified"] is False
    # Output and edit input do not share writable polygon lists with one another.
    result["historical_buildings"][0]["footprint"][0][0] = 99
    assert plan == before and operations[0]["footprint"] == shape()["footprint"]


def test_official_claim_in_user_title_is_never_promoted_to_verified(plan):
    result = apply_edits(plan, [edit("old", "add", source_title="OFFICIAL VERIFIED CMU ARCHIVE", **shape())])
    source = result["sources"][-1]
    assert source["evidence_basis"] == "user_supplied_unverified"
    assert source["retrieved"] is False
    assert result["historical_geometry_verified"] is False


def test_remove_then_keep_undo_uses_original_modern_geometry(plan):
    result = apply_edits(plan, [edit("way/2", "replace", **shape(60))])
    result = apply_edits(result, [edit("way/2", "remove"), edit("way/2", "keep")])
    restored = next(b for b in result["historical_buildings"] if b["id"] == "way/2")
    assert restored["footprint"] == plan["modern_buildings"][1]["footprint"]
    assert len(result["edit_history"]) == 3


@pytest.mark.parametrize("operation", [edit("missing", "remove"), edit("missing", "replace", **shape()),
                                      edit("way/1", "add", **shape())])
def test_entity_identity_rules(plan, operation):
    before = copy.deepcopy(plan)
    with pytest.raises(PlanEditError):
        apply_edits(plan, [operation])
    assert plan == before


def test_added_building_has_no_modern_footprint_to_restore(plan):
    with pytest.raises(PlanEditError, match="original modern"):
        apply_edits(plan, [edit("old", "add", **shape()), edit("old", "keep")])


@pytest.mark.parametrize("operation", [
    edit("old", "add", **{**shape(), "height_m": 0}),
    edit("old", "add", **{**shape(), "height_m": 151}),
    edit("old", "add", **{**shape(), "height_m": True}),
    edit("old", "add", **{**shape(), "height_m": float("nan")}),
    edit("old", "add", footprint=[[10, 10], [20, 20], [10, 20], [20, 10]], height_m=8),
    edit("old", "add", footprint=[[151, 10], [155, 10], [155, 14], [151, 14]], height_m=8),
    edit("old", "add", footprint=[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]], height_m=8),
    edit("old", "add", footprint=[[0, 0]] * 33, height_m=8),
    edit("old", "add", footprint=[[-5, -5], [5, -5], [5, 5], [-5, 5]], height_m=8),
])
def test_renderer_rejects_bad_geometry_and_camera_collision_without_partial_changes(plan, operation):
    before = copy.deepcopy(plan)
    with pytest.raises(PlanEditError, match="geometry"):
        apply_edits(plan, [edit("way/1", "keep"), operation])
    assert plan == before


@pytest.mark.parametrize("url", ["http://example.org", "javascript:alert(1)", "https://a:b@example.org",
                                "https:///missing", "https://example.org:bad", "https://example.org/has space",
                                "https://example.org/\nnext", "https://example.org\\bad", "x" * 2049])
def test_only_bounded_https_reference_urls_are_accepted(plan, url):
    with pytest.raises(PlanEditError):
        apply_edits(plan, [edit("way/1", "keep", source_url=url)])


@pytest.mark.parametrize("extra", [{"source_title": ""}, {"source_title": "x" * 161},
                                  {"reason": "x" * 1201}, {"reason": "bad\x00text"},
                                  {"verified": True}, {"building_id": "bad\nidentifier"},
                                  {"action": "execute"}])
def test_fields_are_strict_and_bounded(plan, extra):
    with pytest.raises(PlanEditError):
        apply_edits(plan, [{**edit("way/1", "keep"), **extra}])


def test_missing_geometry_and_geometry_on_keep_are_rejected(plan):
    with pytest.raises(PlanEditError, match="fields"):
        apply_edits(plan, [edit("old", "add")])
    with pytest.raises(PlanEditError, match="fields"):
        apply_edits(plan, [edit("way/1", "keep", **shape())])


@pytest.mark.parametrize("operations", [[], [edit("way/1", "keep")] * 21, {}, [None]])
def test_operation_limit_and_shape(plan, operations):
    with pytest.raises(PlanEditError):
        apply_edits(plan, operations)


def test_building_count_cannot_exceed_renderer_limit(plan):
    plan["historical_buildings"] = [building(f"old/{i}") for i in range(80)]
    with pytest.raises(PlanEditError, match="at most 80"):
        apply_edits(plan, [edit("extra", "add", **shape())])


def test_empty_historical_geometry_is_allowed_after_removal(plan):
    result = apply_edits(plan, [edit("way/2", "remove")])
    assert result["historical_buildings"] == []
    assert result["changes"][1]["action"] == "remove"


@pytest.mark.parametrize("geometry", [{**shape(), "height_m": 151},
                                      {"footprint": [[0, 0]] * 33, "height_m": 8}])
def test_invalid_import_cannot_bypass_validation_by_being_removed_later(plan, geometry):
    before = copy.deepcopy(plan)
    with pytest.raises(PlanEditError, match="geometry"):
        apply_edits(plan, [edit("old", "add", **geometry), edit("old", "remove")])
    assert plan == before


def test_camera_validation_is_for_final_geometry_not_intermediate_occupancy(plan):
    # Schema-valid temporary geometry can be removed in the same atomic batch.
    temporary = {"footprint": [[-5, -5], [5, -5], [5, 5], [-5, 5]], "height_m": 8}
    result = apply_edits(plan, [edit("old", "add", **temporary), edit("old", "remove")])
    assert {b["id"] for b in result["historical_buildings"]} == {"way/2"}


def test_cumulative_edit_quota_is_bounded(plan):
    plan["edit_history"] = [{"building_id": "way/1", "action": "keep"}] * 199
    accepted = apply_edits(plan, [edit("way/1", "keep")])
    assert len(accepted["edit_history"]) == 200
    with pytest.raises(PlanEditError, match="200 cumulative edits"):
        apply_edits(accepted, [edit("way/1", "keep")])


def test_source_record_quota_is_bounded(plan):
    plan["sources"] = [{"id": f"source-{i}"} for i in range(300)]
    with pytest.raises(PlanEditError, match="300 source records"):
        apply_edits(plan, [edit("way/1", "keep")])
