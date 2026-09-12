import io
import json
import math
import struct

import numpy as np
from PIL import Image
import pytest

from app.worlds.geometry import GeometryError, render_depth


WIDTH, HEIGHT = 128, 64


def box(identifier="north", *, x0=-8, x1=8, z0=-20, z1=-10, height=12):
    return {"id": identifier, "footprint": [[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
            "height_m": height}


def render(buildings, **kwargs):
    return render_depth(buildings, width=WIDTH, height=HEIGHT, **kwargs)


def pixels(result, key="depth_png"):
    with Image.open(io.BytesIO(result[key])) as image:
        image.load()
        return np.asarray(image)


def distance(result):
    m = result["metadata"]
    return np.exp(math.log(m["z_min"]) + (1 - pixels(result) / 255)
                  * math.log(m["z_max"] / m["z_min"]))


def pixel_ray(row, col, heading=0):
    azimuth = ((col + 0.5) / WIDTH - 0.5) * 2 * math.pi + math.radians(heading)
    elevation = (0.5 - (row + 0.5) / HEIGHT) * math.pi
    return np.array([math.sin(azimuth) * math.cos(elevation), math.sin(elevation),
                     -math.cos(azimuth) * math.cos(elevation)])


def test_wall_depth_is_radial_distance_in_metres_not_camera_z():
    result = render([box()], camera_position=(0, 2, 0))
    for row, col in [(31, 63), (27, 53), (27, 74)]:
        ray = pixel_ray(row, col)
        expected = -10 / ray[2]
        assert distance(result)[row, col] == pytest.approx(expected, rel=0.015)
    # Oblique rays must travel farther than the ten-metre perpendicular wall distance.
    assert distance(result)[27, 53] > 11
    assert result["metadata"]["coordinate_frame"] == "east_up_south"
    assert result["metadata"]["historical_accuracy_verified"] is False
    json.dumps(result["metadata"], allow_nan=False)


def test_camera_translation_changes_actual_wall_range():
    scene = [box()]
    origin = render(scene, camera_position=(0, 2, 0))
    forward = render(scene, camera_position=(0, 2, -4))
    assert distance(origin)[31, 63] == pytest.approx(10, rel=0.015)
    assert distance(forward)[31, 63] == pytest.approx(6, rel=0.015)


def test_removing_building_reveals_farther_geometry_and_changes_mesh():
    near = box("demolished")
    far = box("retained", z0=-35, z1=-25, height=20)
    before = render([near, far])
    after = render([far])
    assert distance(before)[31, 63] == pytest.approx(10, rel=0.015)
    assert distance(after)[31, 63] == pytest.approx(25, rel=0.015)
    assert after["metadata"]["building_ids"] == ["retained"]
    assert before["depth_png"] != after["depth_png"]
    assert before["mesh_glb"] != after["mesh_glb"]
    assert b"demolished" not in after["mesh_glb"]


def concave_building():
    # U-shaped footprint: a four-metre-wide courtyard opens toward the camera.
    return {"id": "courtyard", "height_m": 10,
            "footprint": [[-6, -5], [-2, -5], [-2, -12], [2, -12],
                          [2, -5], [6, -5], [6, -15], [-6, -15]]}


def test_concave_courtyard_opening_is_not_filled_by_convex_hull():
    result = render([concave_building()], camera_position=(0, 2, 0))
    # The centre ray enters the opening and only hits its twelve-metre back wall.
    assert distance(result)[31, 63] == pytest.approx(12, rel=0.015)
    # A ray toward the left wing still meets the five-metre front wall.
    row, col = 31, 49
    assert distance(result)[row, col] == pytest.approx(-5 / pixel_ray(row, col)[2], rel=0.015)


def test_concave_roof_and_camera_above_building():
    building = concave_building()
    courtyard = render([building], camera_position=(0, 20, -8))
    above_wing = render([building], camera_position=(-4, 20, -8))
    assert distance(courtyard)[-1, 63] == pytest.approx(20, rel=0.015)
    assert distance(above_wing)[-1, 63] == pytest.approx(10, rel=0.015)
    # Diagnostic colours also reflect the ground versus the roof.
    assert not np.array_equal(pixels(courtyard, "preview_png")[-1, 63],
                              pixels(above_wing, "preview_png")[-1, 63])


def test_heading_is_clockwise_and_seam_wraps_without_flipping_vertical_axis():
    east = box("east", x0=10, x1=20, z0=-5, z1=5)
    unrotated = render([east])
    rotated = render([east], heading_deg=90)
    np.testing.assert_array_equal(pixels(rotated), np.roll(pixels(unrotated), -WIDTH // 4, axis=1))
    assert distance(rotated)[31, 63] == pytest.approx(10, rel=0.015)
    south = render([box("south", z0=10, z1=20)])
    assert distance(south)[31, 0] == pytest.approx(10, rel=0.015)
    assert distance(south)[31, -1] == pytest.approx(10, rel=0.015)
    assert np.all(pixels(south)[0] == 0)  # Top is sky, not ground.
    assert np.all(pixels(south)[-1] > 0)


def test_world_labs_log_encoding_white_near_black_far_and_sky():
    clipped_near = render([], camera_position=(0, 0.05, 0), z_min=1, z_max=100)
    assert pixels(clipped_near).dtype == np.uint8
    assert pixels(clipped_near).shape == (HEIGHT, WIDTH)
    assert pixels(clipped_near)[-1, 63] == 255
    assert pixels(clipped_near)[0, 63] == 0
    midpoint = render([box()], z_min=1, z_max=100)
    # Ten metres is the logarithmic midpoint between one and one hundred metres.
    assert pixels(midpoint)[31, 63] in (127, 128)
    beyond_far = render([box()], z_min=1, z_max=5)
    assert pixels(beyond_far)[31, 63] == 0
    assert midpoint["metadata"]["z_min"] == 1
    assert midpoint["metadata"]["z_max"] == 100


def test_polygon_winding_and_redundant_collinear_vertices_do_not_change_visibility():
    building = box()
    reversed_building = {**building, "footprint": building["footprint"][::-1]}
    extra = {**building, "footprint": [[-8, -20], [0, -20], [8, -20], [8, -10], [-8, -10]]}
    original = render([building])
    np.testing.assert_array_equal(pixels(original), pixels(render([reversed_building])))
    np.testing.assert_array_equal(pixels(original), pixels(render([extra])))


def read_glb(blob):
    magic, version, declared_length = struct.unpack_from("<4sII", blob)
    assert (magic, version, declared_length) == (b"glTF", 2, len(blob))
    json_length, json_kind = struct.unpack_from("<I4s", blob, 12)
    assert json_kind == b"JSON" and json_length % 4 == 0
    doc = json.loads(blob[20:20 + json_length])
    bin_offset = 20 + json_length
    bin_length, bin_kind = struct.unpack_from("<I4s", blob, bin_offset)
    assert bin_kind == b"BIN\x00" and bin_length % 4 == 0
    binary = blob[bin_offset + 8:]
    assert bin_length == len(binary) == doc["buffers"][0]["byteLength"]
    assert "uri" not in doc["buffers"][0]
    assert not doc.get("images")
    return doc, binary


def accessor_array(doc, binary, accessor_index):
    accessor = doc["accessors"][accessor_index]
    view = doc["bufferViews"][accessor["bufferView"]]
    assert accessor["componentType"] == 5126 and accessor["type"] == "VEC3"
    assert view["byteOffset"] + view["byteLength"] <= len(binary)
    return np.frombuffer(binary, dtype="<f4", offset=view["byteOffset"],
                         count=accessor["count"] * 3).reshape(-1, 3)


def test_glb_embeds_valid_geometry_with_concave_roof_area_normals_and_ground():
    doc, binary = read_glb(render([concave_building()])["mesh_glb"])
    assert len(doc["scenes"][0]["nodes"]) == 2
    assert doc["nodes"][0]["extras"]["building_id"] == "courtyard"
    for mesh in doc["meshes"]:
        primitive = mesh["primitives"][0]
        positions = accessor_array(doc, binary, primitive["attributes"]["POSITION"])
        normals = accessor_array(doc, binary, primitive["attributes"]["NORMAL"])
        assert len(positions) % 3 == 0
        assert np.all(np.isfinite(positions)) and np.all(np.isfinite(normals))
        np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1)
        triangles = positions.reshape(-1, 3, 3)
        cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
        assert np.all(np.sum(cross * normals[::3], axis=1) > 0)
        material = doc["materials"][primitive["material"]]
        assert len(material["pbrMetallicRoughness"]["baseColorFactor"]) == 4
        if mesh["name"] == "courtyard":
            roof = triangles[np.all(triangles[:, :, 1] == 10, axis=1)]
            area = np.linalg.norm(np.cross(roof[:, 1] - roof[:, 0], roof[:, 2] - roof[:, 0]), axis=1).sum() / 2
            assert area == pytest.approx(12 * 10 - 4 * 7)
            centres = roof.mean(axis=1)
            assert not np.any((np.abs(centres[:, 0]) < 2) & (centres[:, 2] > -12))
        else:
            assert mesh["name"] == "Ground"
            assert np.all(positions[:, 1] == 0)
            np.testing.assert_array_equal(normals[:, 1], 1)


@pytest.mark.parametrize("footprint", [
    [[0, 0], [1, 1], [0, 1], [1, 0]],  # self-intersecting bow tie
    [[0, 0], [1, 0], [2, 0]],  # zero area
    [[0, 0], [2, 0], [1, 0], [1, 2]],  # backtracking adjacent edge
    [[0, 0], [1, 0], [1, 1], [0, 0]],  # closed ring instead of contract's unclosed ring
    [[0, 0], [151, 0], [1, 1]],
    [[0, 0], [math.nan, 0], [1, 1]],
    [[0, 0], [10 ** 500, 0], [1, 1]],
    [[0, 0], [True, 0], [1, 1]],
])
def test_invalid_polygons_fail_clearly(footprint):
    with pytest.raises(GeometryError, match="[Ff]ootprint"):
        render([{"id": "bad", "footprint": footprint, "height_m": 10}])


@pytest.mark.parametrize("height", [0, 151, math.inf, True])
def test_height_bounds(height):
    with pytest.raises(GeometryError, match="heights"):
        render([box(height=height)])


@pytest.mark.parametrize("camera", [(0, 2, -15), (0, 2, -10), (-8, 2, -10)])
def test_camera_inside_or_on_building_is_rejected(camera):
    with pytest.raises(GeometryError, match="Camera is inside or on"):
        render([box()], camera_position=camera)


def test_resource_bounds_invalid_camera_and_duplicate_ids():
    with pytest.raises(GeometryError, match="80"):
        render([box(str(i)) for i in range(81)])
    with pytest.raises(GeometryError, match="unique"):
        render([box(), box()])
    with pytest.raises(GeometryError, match="3 to 32"):
        render([{**box(), "footprint": [[i, 0] for i in range(33)]}])
    with pytest.raises(GeometryError, match="Camera"):
        render([], camera_position=(0, -1, 0))
    with pytest.raises(GeometryError, match="Heading"):
        render([], heading_deg=math.nan)
    with pytest.raises(GeometryError, match="2:1"):
        render_depth([], width=1024, height=1024)
    with pytest.raises(GeometryError, match="Depth bounds"):
        render([], z_min=10, z_max=1)
