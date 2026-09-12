import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from .temporal import DECADE_ANCHOR as DECADE_ANCHOR

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env', override=True)

TILE = H = 1024
STEP_TARGET = 870
N_MIN, N_MAX = 3, 8
BAND_FRAC_360 = 1 / 3
ANCHOR_MAX_ASPECT = 21 / 9
COLOR_MATCH_K = 0.8
MAX_CONCURRENCY = 6  # Legacy alias; prefer TILE_CONCURRENCY (0/unset = match tile count).
POLL_MS = 500
WIPE_MS = 1500
GYRO_SMOOTH = 0.15
PANO_FOV_PHONE_DEG = 120
MAX_UPLOAD_MB = 40
DEFAULT_DECADE = '1920s'


def _optional_positive_int(*names: str) -> int | None:
    """First set env wins; blank / 0 / missing means 'match the natural count'."""
    for name in names:
        raw = os.getenv(name)
        if raw is None or not str(raw).strip():
            continue
        value = int(raw)
        if value <= 0:
            return None
        return max(1, value)
    return None


@dataclass
class Settings:
    in_dir: Path = field(default_factory=lambda: Path(os.getenv('IN_DIR', str(ROOT / 'data/in'))).resolve())
    out_dir: Path = field(default_factory=lambda: Path(os.getenv('OUT_DIR', str(ROOT / 'data/out'))).resolve())
    provider: str = field(default_factory=lambda: os.getenv(
        'PROVIDER', 'gemini' if os.getenv('GEMINI_API_KEY') else 'grok' if os.getenv('XAI_API_KEY') else 'demo',
    ))
    provider_fallback: str = field(default_factory=lambda: os.getenv('PROVIDER_FALLBACK', 'fal'))
    # None / unset = match tile count (geometry n). Set TILE_CONCURRENCY to cap.
    tile_concurrency: int | None = field(default_factory=lambda: _optional_positive_int('TILE_CONCURRENCY'))
    # None / unset = match weather count when the weather system is on.
    weather_concurrency: int | None = field(default_factory=lambda: _optional_positive_int('WEATHER_CONCURRENCY'))
    # Server default for new jobs; each POST /jobs can still opt in/out.
    weather_enabled: bool = field(default_factory=lambda: os.getenv('WEATHER_ENABLED', '0') not in {'0', 'false', 'no', ''})
    # Deprecated alias for older call sites; prefer tile_concurrency / resolve_tile_concurrency.
    max_concurrency: int = field(default_factory=lambda: _optional_positive_int('TILE_CONCURRENCY') or N_MAX)
    gemini_api_key: str = field(default_factory=lambda: os.getenv('GEMINI_API_KEY', ''), repr=False)
    grok_api_key: str = field(default_factory=lambda: os.getenv('XAI_API_KEY', ''), repr=False)
    fal_key: str = field(default_factory=lambda: os.getenv('FAL_KEY', ''), repr=False)
    k2_api_key: str = field(default_factory=lambda: os.getenv('K2_API_KEY', ''), repr=False)
    openai_api_key: str = field(default_factory=lambda: os.getenv('OPENAI_API_KEY', ''), repr=False)
    gemini_image_model: str = field(default_factory=lambda: os.getenv('GEMINI_IMAGE_MODEL', 'gemini-3.1-flash-image'))
    gemini_text_model: str = field(default_factory=lambda: os.getenv('GEMINI_TEXT_MODEL', 'gemini-3.6-flash'))
    grok_image_model: str = field(default_factory=lambda: os.getenv('GROK_IMAGE_MODEL', 'grok-imagine-image-2.0'))
    k2_model: str = field(default_factory=lambda: os.getenv('K2_MODEL', 'IFM/K2-Horizon-375B-A23B'))
    k2_vl_model: str = field(default_factory=lambda: os.getenv('K2_VL_MODEL', 'qwen3-vl-plus'))
    k2_base_url: str = field(default_factory=lambda: os.getenv('K2_BASE_URL', 'https://api.ifm.ai/v1'))
    qwen_image_model: str = field(default_factory=lambda: os.getenv('QWEN_IMAGE_MODEL', 'qwen-image-edit'))
    openai_image_model: str = field(default_factory=lambda: os.getenv('OPENAI_IMAGE_MODEL', 'gpt-image-1.5'))
    openai_image_quality: str = field(default_factory=lambda: os.getenv('OPENAI_IMAGE_QUALITY', 'medium'))
    openai_text_model: str = field(default_factory=lambda: os.getenv('OPENAI_TEXT_MODEL', 'gpt-4o-mini'))
    openai_image_timeout_s: float = field(default_factory=lambda: max(30.0, float(os.getenv('OPENAI_IMAGE_TIMEOUT_S', '180'))))
    fal_model: str = field(default_factory=lambda: os.getenv('FAL_MODEL', 'fal-ai/flux/dev/image-to-image'))
    # Soft composition lock: allow historical reshape; nudge overlap margins for seams.
    structure_lock: bool = field(default_factory=lambda: os.getenv('STRUCTURE_LOCK', '1') not in {'0', 'false', 'no'})
    lean_locked_prompt: bool = field(default_factory=lambda: os.getenv('LEAN_LOCKED_PROMPT', '1') not in {'0', 'false', 'False'})
    # Head start for the tile the viewer is facing, so viewport priority is real
    # even when every tile fits inside the concurrency budget at once.
    priority_stagger_s: float = field(default_factory=lambda: max(0.0, float(os.getenv('PRIORITY_STAGGER_S', '0.4'))))

    def resolve_tile_concurrency(self, tile_count: int, override: int | None = None) -> int:
        """Per-weather tile parallelism. Default matches the tile count."""
        limit = self.tile_concurrency if override is None else override
        count = max(1, int(tile_count))
        if limit is None:
            return count
        return max(1, min(count, int(limit)))

    def resolve_weather_concurrency(self, weather_count: int) -> int:
        """How many weather variants may run at once. Default matches the weather count."""
        count = max(1, int(weather_count))
        if self.weather_concurrency is None:
            return count
        return max(1, min(count, int(self.weather_concurrency)))


settings = Settings()
