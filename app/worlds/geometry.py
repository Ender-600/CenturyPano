"""Coarse geometry, radial equirectangular depth, and self-contained GLB export.

Geometry is supplied explicitly; this module does not infer historical buildings.
The PNG convention follows World Labs' official web-chisel-depth-png example:
https://github.com/worldlabsai/worldlabs-api-examples/tree/main/web-chisel-depth-png
PNG = round(255 * (1 - (log(distance)-log(z_min))/(log(z_max)-log(z_min))))
after clipping distance to [z_min, z_max]. Sky has distance z_max (black).
This is radial distance in metres, not perspective camera-Z depth.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import io
import json
import math
from numbers import Real
import struct

import numpy as np
from PIL import Image


MAX_BUILDINGS = 80
MAX_VERTICES = 32
MAX_COORDINATE_M = 150.0
_EPS = 1e-8
_PALETTE = ((164, 119, 85), (173, 143, 110), (142, 149, 151), (190, 160, 127))


class GeometryError(ValueError):
    """Invalid or unsupported coarse geometry; messages never echo raw input."""


@dataclass(frozen=True)
class _Building:
    id: str
    footprint: np.ndarray
    height_m: float
    label: str | None


def _number(value: object) -> bool:
    if not isinstance(value, Real) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _cross(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]


def _on_segment(a: np.ndarray, b: np.ndarray, p: np.ndarray) -> bool:
    return bool(
        abs(_cross(b - a, p - a)) <= _EPS
        and np.all(p >= np.minimum(a, b) - _EPS)
        and np.all(p <= np.maximum(a, b) + _EPS)
    )


def _segments_intersect(a: np.ndarray, b: np.ndarray, c: np.ndarray, d: np.ndarray) -> bool:
    ab_c, ab_d = float(_cross(b - a, c - a)), float(_cross(b - a, d - a))
    cd_a, cd_b = float(_cross(d - c, a - c)), float(_cross(d - c, b - c))
    if ab_c * ab_d < 0 and cd_a * cd_b < 0:
        return True
    return any((_on_segment(a, b, c), _on_segment(a, b, d),
                _on_segment(c, d, a), _on_segment(c, d, b)))


def _inside_polygon(x: np.ndarray, z: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """Even-odd containment, including boundary, for a simple concave polygon."""
    inside = np.zeros(np.broadcast_shapes(np.shape(x), np.shape(z)), dtype=bool)
    boundary = np.zeros_like(inside)
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0), strict=True):
        ex, ez = b - a
        cross = ex * (z - a[1]) - ez * (x - a[0])
        boundary |= ((np.abs(cross) <= _EPS)
                     & (x >= min(a[0], b[0]) - _EPS) & (x <= max(a[0], b[0]) + _EPS)
                     & (z >= min(a[1], b[1]) - _EPS) & (z <= max(a[1], b[1]) + _EPS))
        if abs(ez) > _EPS:
            inside ^= ((a[1] > z) != (b[1] > z)) & (x < ex * (z - a[1]) / ez + a[0])
    return inside | boundary


def _validate_buildings(buildings: list[dict], camera: np.ndarray) -> list[_Building]:
    if not isinstance(buildings, list) or len(buildings) > MAX_BUILDINGS:
        raise GeometryError("Buildings must be a list with at most 80 entries.")
    result = []
    ids: set[str] = set()
    for item in buildings:
        if not isinstance(item, dict):
            raise GeometryError("Each building must be an object.")
        identifier = item.get("id")
        if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 128:
            raise GeometryError("Each building needs a nonempty id of at most 128 characters.")
        if identifier in ids:
            raise GeometryError("Building ids must be unique.")
        ids.add(identifier)
        points = item.get("footprint")
        if not isinstance(points, list) or not 3 <= len(points) <= MAX_VERTICES:
            raise GeometryError("A footprint needs 3 to 32 unclosed vertices.")
        if any(not isinstance(p, (list, tuple)) or len(p) != 2
               or any(not _number(v) or abs(v) > MAX_COORDINATE_M for v in p) for p in points):
            raise GeometryError("Footprint coordinates must be finite east/south metres within ±150.")
        polygon = np.asarray(points, dtype=np.float64)
        count = len(polygon)
        for i in range(count):
            if np.any(np.linalg.norm(polygon[i + 1:] - polygon[i], axis=1) < 1e-4):
                raise GeometryError("Footprints must be unclosed and have distinct vertices.")
            before, after = polygon[i] - polygon[i - 1], polygon[(i + 1) % count] - polygon[i]
            if abs(_cross(before, after)) <= _EPS and np.dot(before, after) < 0:
                raise GeometryError("Footprints cannot contain overlapping or reversed edges.")
            for j in range(i + 1, count):
                if j == i + 1 or (i == 0 and j == count - 1):
                    continue
                if _segments_intersect(polygon[i], polygon[(i + 1) % count],
                                       polygon[j], polygon[(j + 1) % count]):
                    raise GeometryError("Footprints must be simple polygons without self-intersections.")
        signed_area = float(np.sum(_cross(polygon, np.roll(polygon, -1, axis=0))) / 2)
        if abs(signed_area) < 1e-4:
            raise GeometryError("Footprints must have nonzero area.")
        if signed_area < 0:
            polygon = polygon[::-1].copy()
        building_height = item.get("height_m")
        if not _number(building_height) or not 1 <= building_height <= 150:
            raise GeometryError("Building heights must be finite metres from 1 to 150.")
        label = item.get("label")
        if label is not None and (not isinstance(label, str) or len(label) > 256):
            raise GeometryError("A building label must be text of at most 256 characters.")
        if camera[1] <= building_height + _EPS and _inside_polygon(camera[0], camera[2], polygon):
            raise GeometryError("Camera is inside or on a building; choose an unobstructed camera position.")
        result.append(_Building(identifier, polygon, float(building_height), label))
    return result


def _building_color(identifier: str) -> tuple[int, int, int]:
    return _PALETTE[hashlib.sha256(identifier.encode()).digest()[0] % len(_PALETTE)]


def _radial_depth(buildings: list[_Building], camera: np.ndarray, heading_deg: float,
                  width: int, height: int, z_max: float) -> tuple[np.ndarray, np.ndarray]:
    # Pixel centres: no duplicated seam column or pole row. Heading 0 is north (-Z).
    theta = (np.arange(width) + 0.5) * (2 * np.pi / width) - np.pi + np.deg2rad(heading_deg)
    phi = (np.arange(height) + 0.5) * np.pi / height
    hx, hz = np.sin(theta), -np.cos(theta)
    horizontal, dy = np.sin(phi), np.cos(phi)
    slope = dy / horizontal
    depth = np.full((height, width), z_max, dtype=np.float64)
    preview = np.empty((height, width, 3), dtype=np.uint8)
    preview[:] = (174, 202, 220)

    # Infinite flat ground is truncated by the same radial far bound as all surfaces.
    down = np.flatnonzero(dy < -_EPS)
    ground_distance = -camera[1] / dy[down]
    down = down[ground_distance < z_max]
    depth[down] = (-camera[1] / dy[down])[:, None]
    preview[down] = (101, 106, 99)

    for building in buildings:
        polygon = building.footprint
        color = np.asarray(_building_color(building.id), dtype=np.float64)
        for a, b in zip(polygon, np.roll(polygon, -1, axis=0), strict=True):
            edge, relative = b - a, a - camera[[0, 2]]
            denominator = hx * edge[1] - hz * edge[0]
            q = np.full(width, np.inf)
            u = np.full(width, np.inf)
            usable = np.abs(denominator) > _EPS
            np.divide(_cross(relative, edge), denominator, out=q, where=usable)
            np.divide(relative[0] * hz - relative[1] * hx, denominator, out=u, where=usable)
            columns = np.flatnonzero((q > _EPS) & (q < z_max) & (u >= -_EPS) & (u <= 1 + _EPS))
            if columns.size == 0:
                continue
            distances = q[columns][None, :] / horizontal[:, None]
            hit_y = camera[1] + slope[:, None] * q[columns][None, :]
            nearer = ((hit_y >= -_EPS) & (hit_y <= building.height_m + _EPS)
                      & (distances < depth[:, columns]))
            depth[:, columns] = np.where(nearer, distances, depth[:, columns])
            # Stable directional shading helps a coarse geometry preview read as volume.
            normal = np.array([edge[1], -edge[0]]) / np.linalg.norm(edge)
            shade = 0.72 + 0.22 * max(0.0, float(np.dot(normal, [0.6, -0.8])))
            preview[:, columns] = np.where(nearer[:, :, None], (color * shade).astype(np.uint8),
                                          preview[:, columns])

        # Roof membership uses the original concave polygon, never its convex hull.
        roof_distance = np.full(height, np.inf)
        np.divide(building.height_m - camera[1], dy, out=roof_distance, where=np.abs(dy) > _EPS)
        rows = np.flatnonzero((roof_distance > _EPS) & (roof_distance < z_max))
        if rows.size == 0:
            continue
        q = roof_distance[rows] * horizontal[rows]
        x = camera[0] + q[:, None] * hx[None, :]
        z = camera[2] + q[:, None] * hz[None, :]
        candidates = ((roof_distance[rows, None] < depth[rows])
                      & (x >= polygon[:, 0].min()) & (x <= polygon[:, 0].max())
                      & (z >= polygon[:, 1].min()) & (z <= polygon[:, 1].max()))
        rr, cc = np.nonzero(candidates)
        if rr.size:
            inside = _inside_polygon(x[rr, cc], z[rr, cc], polygon)
            rr, cc = rows[rr[inside]], cc[inside]
            depth[rr, cc] = roof_distance[rr]
            preview[rr, cc] = np.minimum(color * 1.1, 255).astype(np.uint8)
    return depth, preview


def _triangulate(polygon: np.ndarray) -> list[tuple[int, int, int]]:
    """Ear clipping for validated CCW simple polygons, including concave roofs."""
    indices = list(range(len(polygon)))
    # Redundant straight-edge vertices do not change the roof boundary.
    changed = True
    while changed and len(indices) > 3:
        changed = False
        for k, b in enumerate(indices):
            a, c = indices[k - 1], indices[(k + 1) % len(indices)]
            if abs(_cross(polygon[b] - polygon[a], polygon[c] - polygon[b])) <= _EPS:
                indices.pop(k)
                changed = True
                break
    triangles = []
    while len(indices) > 3:
        for k, b in enumerate(indices):
            a, c = indices[k - 1], indices[(k + 1) % len(indices)]
            pa, pb, pc = polygon[[a, b, c]]
            if _cross(pb - pa, pc - pb) <= _EPS:
                continue
            others = polygon[[i for i in indices if i not in (a, b, c)]]
            contained = ((_cross(pb - pa, others - pa) >= -_EPS)
                         & (_cross(pc - pb, others - pb) >= -_EPS)
                         & (_cross(pa - pc, others - pc) >= -_EPS))
            if np.any(contained):
                continue
            triangles.append((a, b, c))
            indices.pop(k)
            break
        else:
            raise GeometryError("Footprint cannot be triangulated reliably; simplify its vertices.")
    triangles.append(tuple(indices))
    return triangles


def _mesh_glb(buildings: list[_Building], camera: np.ndarray, z_max: float) -> bytes:
    """glTF 2.0 with embedded positions/normals and solid-color PBR materials."""
    binary = bytearray()
    doc = {"asset": {"version": "2.0", "generator": "CenturyPano coarse geometry"},
           "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
           "materials": [], "buffers": [], "bufferViews": [], "accessors": []}

    def add_mesh(name: str, positions: list, color: tuple, extras: dict) -> None:
        vertices = np.asarray(positions, dtype="<f4").reshape(-1, 3)
        triangles = vertices.reshape(-1, 3, 3)
        normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        normals /= np.linalg.norm(normals, axis=1, keepdims=True)
        normals = np.repeat(normals, 3, axis=0).astype("<f4")
        accessors = []
        for array in (vertices, normals):
            offset = len(binary)
            data = array.tobytes()
            binary.extend(data)
            view = len(doc["bufferViews"])
            doc["bufferViews"].append({"buffer": 0, "byteOffset": offset,
                                       "byteLength": len(data), "target": 34962})
            accessor = {"bufferView": view, "componentType": 5126, "count": len(array), "type": "VEC3"}
            if array is vertices:
                accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
            accessors.append(len(doc["accessors"]))
            doc["accessors"].append(accessor)
        material = len(doc["materials"])
        doc["materials"].append({"pbrMetallicRoughness": {
            "baseColorFactor": [v / 255 for v in color] + [1.0], "metallicFactor": 0.0,
            "roughnessFactor": 1.0}, "doubleSided": False})
        mesh = len(doc["meshes"])
        doc["meshes"].append({"name": name, "primitives": [{
            "attributes": {"POSITION": accessors[0], "NORMAL": accessors[1]},
            "material": material, "mode": 4}]})
        doc["scenes"][0]["nodes"].append(len(doc["nodes"]))
        doc["nodes"].append({"name": name, "mesh": mesh, "extras": extras})

    for building in buildings:
        polygon, top = building.footprint, building.height_m
        positions = []
        for a, b in zip(polygon, np.roll(polygon, -1, axis=0), strict=True):
            a0, a1 = (a[0], 0, a[1]), (a[0], top, a[1])
            b0, b1 = (b[0], 0, b[1]), (b[0], top, b[1])
            positions.extend((a0, a1, b0, b0, a1, b1))
        for a, b, c in _triangulate(polygon):
            positions.extend((polygon[i, 0], top, polygon[i, 1]) for i in (a, c, b))
        add_mesh(building.id, positions, _building_color(building.id),
                 {"kind": "coarse_building", "building_id": building.id,
                  "height_m": top, "label": building.label})

    # Ground includes all potentially visible rays through the radial far bound.
    extent = max(MAX_COORDINATE_M, abs(camera[0]) + z_max, abs(camera[2]) + z_max)
    a, b, c, d = (-extent, 0, -extent), (extent, 0, -extent), (extent, 0, extent), (-extent, 0, extent)
    add_mesh("Ground", [a, c, b, a, d, c], (101, 106, 99), {"kind": "ground", "y_m": 0})
    doc["buffers"] = [{"byteLength": len(binary)}]
    raw_json = json.dumps(doc, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
    raw_json += b" " * (-len(raw_json) % 4)
    binary.extend(b"\x00" * (-len(binary) % 4))
    length = 12 + 8 + len(raw_json) + 8 + len(binary)
    return (struct.pack("<4sII", b"glTF", 2, length)
            + struct.pack("<I4s", len(raw_json), b"JSON") + raw_json
            + struct.pack("<I4s", len(binary), b"BIN\x00") + bytes(binary))


def _png(array: np.ndarray) -> bytes:
    output = io.BytesIO()
    Image.fromarray(array).save(output, format="PNG")
    return output.getvalue()


def render_depth(buildings: list[dict], *, camera_position=(0, 1.6, 0), heading_deg=0,
                 width=1024, height=512, z_min=0.1, z_max=150) -> dict:
    """Render supplied extruded footprints, flat roofs, and ground in metres.

    Frame: +X east, +Y up, +Z south; camera pitch/roll are level. Heading is
    clockwise from north. Image top is up, centre faces heading, and the seam
    faces the opposite direction. Distances outside [z_min, z_max] are clipped.
    Supports 0..80 simple, unclosed polygons, including concave footprints.
    Output contains depth_png, preview_png, mesh_glb bytes and JSON metadata.
    The preview is a geometry diagnostic, not a historically verified image.
    """
    if (not isinstance(width, int) or isinstance(width, bool)
            or not isinstance(height, int) or isinstance(height, bool)
            or not 32 <= height <= 1024 or width != 2 * height):
        raise GeometryError("Depth panorama must be 2:1, with height from 32 to 1024 pixels.")
    if (not _number(z_min) or not _number(z_max)
            or not 0 < z_min < z_max <= 1000):
        raise GeometryError("Depth bounds must satisfy 0 < z_min < z_max <= 1000 metres.")
    if not _number(heading_deg):
        raise GeometryError("Heading must be a finite number of degrees.")
    if (not isinstance(camera_position, (tuple, list)) or len(camera_position) != 3
            or any(not _number(v) for v in camera_position)
            or abs(camera_position[0]) > MAX_COORDINATE_M
            or abs(camera_position[2]) > MAX_COORDINATE_M
            or not 0.05 <= camera_position[1] <= 150):
        raise GeometryError("Camera must have finite east/up/south coordinates within ±150m and height 0.05–150m.")
    camera = np.asarray(camera_position, dtype=np.float64)
    checked = _validate_buildings(buildings, camera)
    heading_deg = float(heading_deg) % 360
    depth, preview = _radial_depth(checked, camera, heading_deg, width, height, float(z_max))
    normalized = ((np.log(np.clip(depth, z_min, z_max)) - math.log(z_min))
                  / (math.log(z_max) - math.log(z_min)))
    encoded = np.rint(255 * (1 - np.clip(normalized, 0, 1))).astype(np.uint8)
    metadata = {
        "width": width, "height": height, "z_min": float(z_min), "z_max": float(z_max),
        "depth_encoding": "log_radial_inverse_8bit", "depth_units": "metres",
        "depth_formula": "round(255*(1-clamp((ln(d)-ln(z_min))/(ln(z_max)-ln(z_min)),0,1)))",
        "near_value": 255, "far_and_sky_value": 0, "projection": "equirectangular",
        "coordinate_frame": "east_up_south", "ground_y_m": 0,
        "camera_position": camera.tolist(), "heading_deg": heading_deg,
        "camera_pitch_deg": 0, "camera_roll_deg": 0,
        "image_orientation": {"top": "up", "center": "heading", "right": "clockwise",
                              "seam": "heading + 180 degrees", "sampling": "pixel_centres"},
        "building_count": len(checked), "building_ids": [b.id for b in checked],
        "geometry_kind": "extruded_footprints_flat_roofs_and_ground",
        "preview_kind": "coarse_geometry_diagnostic", "historical_accuracy_verified": False,
    }
    return {"depth_png": _png(encoded), "preview_png": _png(preview),
            "mesh_glb": _mesh_glb(checked, camera, float(z_max)), "metadata": metadata}
