"""Immutable, bounded user edits to a historical building plan.

This module never retrieves source URLs. User-provided geometry and citations
remain unverified regardless of claims made in a title or explanation.
"""
from __future__ import annotations

import copy
import re
import uuid
from urllib.parse import urlsplit

import numpy as np

from .geometry import GeometryError, _validate_buildings, render_depth

MAX_EDITS = 20
MAX_HISTORY = 200
MAX_SOURCES = 300
MAX_REASON = 1200
MAX_TITLE = 160
MAX_URL = 2048
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\Z")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BASE_FIELDS = {"building_id", "action", "reason", "source_url", "source_title"}


class PlanEditError(ValueError):
    """An edit could not be applied; the original plan remains untouched."""


def _text(value, name, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or _CONTROL.search(value):
        raise PlanEditError(f"{name} must be nonempty text of at most {limit} characters")
    return value.strip()


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise PlanEditError("building_id must contain 1–128 letters, digits, dots, underscores, colons, slashes or hyphens")
    return value


def _url(value):
    value = _text(value, "source_url", MAX_URL)
    if any(c.isspace() for c in value):
        raise PlanEditError("source_url must be an HTTPS URL without whitespace or credentials")
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or "\\" in value):
            raise ValueError
        # Forces malformed/non-numeric/out-of-range ports to be rejected as well.
        _ = parsed.port
    except ValueError:
        raise PlanEditError("source_url must be an HTTPS URL without whitespace or credentials") from None
    return value


def _buildings(value, name):
    if not isinstance(value, list) or len(value) > 80:
        raise PlanEditError(f"{name} must be a list containing at most 80 buildings")
    indexed = {}
    for building in value:
        if not isinstance(building, dict):
            raise PlanEditError(f"{name} contains an invalid building")
        identifier = _identifier(building.get("id"))
        if identifier in indexed:
            raise PlanEditError(f"{name} contains duplicate building ids")
        indexed[identifier] = building
    return indexed


def apply_edits(plan: dict, edits: list[dict]) -> dict:
    """Apply up to 20 sequential add/remove/replace/keep operations atomically.

    Every operation requires ``building_id``, ``action``, ``reason``,
    ``source_url`` (HTTPS) and ``source_title``. Add/replace also require an
    unclosed ``footprint`` of 3–32 [east_m, south_m] points and ``height_m``;
    ``label`` is optional. Keep restores the original modern footprint.

    Final geometry uses the renderer's ±150m frame, 1–150m heights and 80-building
    limits. Self intersections and a camera inside a building reject the entire
    edit batch. The original plan and its curated evidence are never modified.
    """
    if not isinstance(plan, dict):
        raise PlanEditError("plan must be an object")
    if not isinstance(edits, list) or not 1 <= len(edits) <= MAX_EDITS:
        raise PlanEditError("Provide between 1 and 20 edits")
    result = copy.deepcopy(plan)
    modern = _buildings(result.get("modern_buildings"), "modern_buildings")
    historical = _buildings(result.get("historical_buildings"), "historical_buildings")
    known = {**modern, **historical}
    if not isinstance(result.get("sources"), list) or not all(isinstance(s, dict) for s in result["sources"]):
        raise PlanEditError("plan.sources must be a list of source objects")
    existing_changes = result.get("changes", [])
    if not isinstance(existing_changes, list) or not all(isinstance(c, dict) for c in existing_changes):
        raise PlanEditError("plan.changes must be a list of change objects")
    changes = {}
    for change in existing_changes:
        identifier = _identifier(change.get("building_id"))
        if identifier in changes:
            raise PlanEditError("plan.changes contains duplicate building ids")
        changes[identifier] = change
    history = result.setdefault("edit_history", [])
    if not isinstance(history, list):
        raise PlanEditError("plan.edit_history must be a list")
    if len(history) + len(edits) > MAX_HISTORY:
        raise PlanEditError("A plan supports at most 200 cumulative edits; create a new plan")
    if len(result["sources"]) + len(edits) > MAX_SOURCES:
        raise PlanEditError("A plan supports at most 300 source records; create a new plan")
    warnings = result.setdefault("uncertainties", [])
    if not isinstance(warnings, list):
        raise PlanEditError("plan.uncertainties must be a list")

    for edit in edits:
        if not isinstance(edit, dict):
            raise PlanEditError("Each edit must be an object")
        action = edit.get("action")
        if action not in ("add", "remove", "replace", "keep"):
            raise PlanEditError("action must be add, remove, replace or keep")
        geometric = action in ("add", "replace")
        allowed = _BASE_FIELDS | ({"footprint", "height_m", "label"} if geometric else set())
        required = _BASE_FIELDS | ({"footprint", "height_m"} if geometric else set())
        if set(edit) - allowed or not required <= set(edit):
            raise PlanEditError("Edit has missing or unsupported fields for its action")
        identifier = _identifier(edit["building_id"])
        if action == "add" and identifier in known:
            raise PlanEditError("add requires a new building_id")
        if action != "add" and identifier not in known:
            raise PlanEditError("This action requires an existing building_id")
        if action == "keep" and identifier not in modern:
            raise PlanEditError("keep can only restore an original modern building")
        reason = _text(edit["reason"], "reason", MAX_REASON)
        title = _text(edit["source_title"], "source_title", MAX_TITLE)
        url = _url(edit["source_url"])
        source_id = "user-edit-" + uuid.uuid4().hex
        result["sources"].append({
            "id": source_id, "title": title, "url": url, "kind": "user_supplied_evidence",
            "evidence_basis": "user_supplied_unverified", "claim": reason,
            "retrieved": False, "building_id": identifier,
        })
        previous_change = copy.deepcopy(changes.get(identifier))
        if action == "remove":
            historical.pop(identifier, None)
        elif action == "keep":
            restored = copy.deepcopy(modern[identifier])
            restored["sources"] = list(restored.get("sources", [])) + [source_id]
            restored["history_status"] = "user_supplied_unverified"
            restored["evidence_basis"] = "user_supplied_unverified"
            historical[identifier] = restored
        else:
            # Do not copy dates/evidence from the superseded modern geometry.
            label = _text(edit.get("label", known.get(identifier, {}).get("label", identifier)), "label", MAX_TITLE)
            building = {
                "id": identifier, "label": label, "footprint": copy.deepcopy(edit["footprint"]),
                "height_m": copy.deepcopy(edit["height_m"]), "sources": [source_id],
                "history_status": "user_supplied_unverified", "evidence_basis": "user_supplied_unverified",
                "footprint_basis": "user_provided_geometry_unverified", "height_basis": "user_supplied_unverified",
            }
            try:
                # Validate every imported entity even if a later operation removes
                # it. A point above the maximum building height avoids enforcing
                # intermediate camera occupancy; the final plan checks that once.
                _validate_buildings([building], np.array([0.0, 151.0, 0.0]))
            except GeometryError as exc:
                raise PlanEditError(f"Edited plan geometry is invalid: {exc}") from None
            historical[identifier] = building
            known[identifier] = building
        change = {"building_id": identifier, "action": action, "reason": reason,
                  "evidence_ids": [source_id], "evidence_basis": "user_supplied_unverified",
                  "origin": "user_edit"}
        changes[identifier] = change
        history.append({**copy.deepcopy(change), "previous_change": previous_change})

    result["historical_buildings"] = list(historical.values())
    try:
        # Validation includes polygon topology, limits, duplicate ids and camera
        # collisions. Render only a tiny diagnostic here; the route builds output.
        render_depth(result["historical_buildings"], camera_position=result.get("camera_position", (0, 1.6, 0)),
                     heading_deg=result.get("heading_deg", 0), width=64, height=32)
    except GeometryError as exc:
        raise PlanEditError(f"Edited plan geometry is invalid: {exc}") from None
    result["changes"] = list(changes.values())
    warning = "User edits and supplied source links have not been independently verified; titles cannot establish historical accuracy."
    if warning not in warnings:
        warnings.append(warning)
    result["status"] = "needs_review"
    result["historical_geometry_verified"] = False
    return result
