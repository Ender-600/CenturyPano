"""World generation choices and their published world-only credit requirements.

Panorama preparation is billed separately. These values are preflight checks,
not a total pipeline cost cap or a guarantee of generated visual quality.
"""

from typing import Literal


WorldModel = Literal["marble-1.1", "marble-1.0-draft"]
DEFAULT_WORLD_MODEL: WorldModel = "marble-1.1"
WORLD_MODELS = {
    "marble-1.1": {
        "id": "marble-1.1", "label": "Standard quality", "world_credits": 1500,
        "cost_label": "1,500 credits / world",
        "description": "Full generation model; review the final detail and spatial quality.",
    },
    "marble-1.0-draft": {
        "id": "marble-1.0-draft", "label": "Quick draft", "world_credits": 150,
        "cost_label": "150 credits / world", "description": "Suitable for quick previews.",
    },
}


def world_credits(model: str) -> int:
    if not isinstance(model, str) or model not in WORLD_MODELS:
        raise ValueError("Unsupported world generation model")
    return WORLD_MODELS[model]["world_credits"]
