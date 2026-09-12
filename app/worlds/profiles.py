"""World generation choices and their published world-only credit requirements.

Panorama preparation is billed separately. These values are preflight checks,
not a total pipeline cost cap or a guarantee of generated visual quality.
"""

from typing import Literal


WorldModel = Literal["marble-1.1", "marble-1.0-draft"]
DEFAULT_WORLD_MODEL: WorldModel = "marble-1.1"
WORLD_MODELS = {
    "marble-1.1": {
        "id": "marble-1.1", "label": "标准质量", "world_credits": 1500,
        "cost_label": "1,500 credits / 世界",
        "description": "正式生成模型；最终细节与空间效果仍需查看。",
    },
    "marble-1.0-draft": {
        "id": "marble-1.0-draft", "label": "快速草稿", "world_credits": 150,
        "cost_label": "150 credits / 世界", "description": "适合快速预览。",
    },
}


def world_credits(model: str) -> int:
    if not isinstance(model, str) or model not in WORLD_MODELS:
        raise ValueError("Unsupported world generation model")
    return WORLD_MODELS[model]["world_credits"]
