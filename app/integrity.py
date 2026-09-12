"""Detect a generated tile that is two pictures rather than one.

The editor is asked to repaint one continuous view. Occasionally it returns a
diptych instead: one half of the square is the scene it was given, the other half
is a different view of the same room -- different scale, different vanishing
point -- butted against it along a hard vertical line. Stitching cannot help,
because the break is inside a single tile, hundreds of pixels away from any seam,
and the seam metrics stay excellent while the panorama has an obvious wall
through the middle of it.

A vertical step on its own proves nothing: rooms contain door frames, window
mullions and the dark edges of furniture, and those are supposed to be there. The
signal is a step that the ORIGINAL photograph does not have. Structure is pinned
by the pixel lock, so an edge that appears from nowhere is the editor's invention,
and one that runs the full height of the tile is a break in the picture rather
than an object in it.
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from .color import delta_e, rgb_to_lab

# Measured on thirteen real generations across three jobs. Twelve intact tiles --
# outdoor streets, an office interior -- peaked at step 13.50 dE and 0.454 broken
# rows; their worst boundaries are window mullions, a doorway, the dark edge of a
# desk, and every one of them is a real object that stops partway down. The tile
# the user photographed measured 29.20 dE across 0.929 of its height. The three
# gates below sit in the gap, and each is independently far from both populations.
BLOCK_PX = 3            # columns averaged either side of a candidate boundary
MARGIN_PX = 24          # tile edges belong to the seam carve, not to this test
STEP_DE = 18.0          # below this a boundary is ordinary scene contrast
RATIO = 2.5             # how much harder than the original's own edge it must be
FULL_HEIGHT = 0.70      # fraction of rows that must break for it to be a break
ROW_DE = 10.0           # per-row delta that counts as broken


def _profile(image: Image.Image | np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-row Lab delta across every interior vertical boundary, and its columns.

    The block mean is taken with a running sum rather than a slice per column, so
    a whole tile costs one Lab conversion and a couple of passes over it.
    """
    lab = rgb_to_lab(image)
    width = lab.shape[1]
    if width < 2 * (MARGIN_PX + BLOCK_PX) + 1:
        return np.zeros((0, 0), dtype=np.float32), np.zeros(0, dtype=np.int64)
    running = np.cumsum(lab, axis=1, dtype=np.float32)
    running = np.concatenate([np.zeros((lab.shape[0], 1, 3), dtype=np.float32), running], axis=1)
    columns = np.arange(MARGIN_PX, width - MARGIN_PX)
    # Mean of lab[:, a:b] is (running[:, b] - running[:, a]) / (b - a).
    left = (running[:, columns] - running[:, columns - BLOCK_PX]) / BLOCK_PX
    right = (running[:, columns + BLOCK_PX] - running[:, columns]) / BLOCK_PX
    # delta_e wants image-shaped arrays; (H, columns, 3) is exactly that.
    rows = delta_e(left, right).astype(np.float32)
    del left, right, running, lab
    return rows, columns


def split_check(original: Image.Image | np.ndarray,
                generated: Image.Image | np.ndarray) -> dict:
    """Report the worst invented full-height vertical break in a generated tile.

    Returns a record that is always safe to put in the manifest. ``split`` is True
    only when a boundary is hard in absolute terms, much harder than the same
    boundary in the photograph, and present down essentially the whole height.
    """
    rows, columns = _profile(generated)
    if rows.size == 0:
        return {"split": False, "reason": "tile too narrow to test"}
    generated_de = rows.mean(axis=0)
    original_rows, _ = _profile(original)
    if original_rows.shape != rows.shape:
        return {"split": False, "reason": "original and generation differ in size"}
    original_de = original_rows.mean(axis=0)
    broken_rows = (rows >= ROW_DE).mean(axis=0)
    # Every boundary is tested, not just the single worst one. Scoring first and
    # testing one column would miss a break that happens to fall where the
    # photograph also has an edge, which is exactly where the editor likes to put
    # one -- it breaks the picture at a window frame it decided to redraw.
    failing = ((generated_de >= STEP_DE) & (generated_de >= RATIO * original_de)
               & (broken_rows >= FULL_HEIGHT))
    if failing.any():
        index = int(np.flatnonzero(failing)[np.argmax(generated_de[failing])])
    else:
        # Nothing is broken; report the boundary least explained by the original,
        # so the manifest still shows how close this tile came.
        index = int(np.argmax(generated_de - RATIO * original_de))
    step, source_step = float(generated_de[index]), float(original_de[index])
    record = {"split": bool(failing[index]), "column": int(columns[index]),
              "step_de": round(step, 3), "original_de": round(source_step, 3),
              "broken_rows": round(float(broken_rows[index]), 3)}
    if not record["split"]:
        record["reason"] = ("the photograph has the same edge"
                            if step >= STEP_DE and broken_rows[index] >= FULL_HEIGHT
                            else "no invented full-height break")
    return record


def worse(left: dict, right: dict) -> bool:
    """True when ``left`` is the more broken of two attempts at the same tile."""
    if bool(left.get("split")) != bool(right.get("split")):
        return bool(left.get("split"))
    return float(left.get("step_de", 0.0)) > float(right.get("step_de", 0.0))
