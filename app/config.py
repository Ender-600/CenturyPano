import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from .temporal import DECADE_ANCHOR as DECADE_ANCHOR

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')

TILE = H = 1024
STEP_TARGET = 870
N_MIN, N_MAX = 3, 8
BAND_FRAC_360 = 1 / 3
ANCHOR_MAX_ASPECT = 21 / 9
COLOR_MATCH_K = 0.8
MAX_CONCURRENCY = 6
POLL_MS = 500
WIPE_MS = 1500
GYRO_SMOOTH = 0.15
PANO_FOV_PHONE_DEG = 120
MAX_UPLOAD_MB = 40
DEFAULT_DECADE = '1920s'


@dataclass
class Settings:
    in_dir: Path = field(default_factory=lambda: Path(os.getenv('IN_DIR', str(ROOT / 'data/in'))).resolve())
    out_dir: Path = field(default_factory=lambda: Path(os.getenv('OUT_DIR', str(ROOT / 'data/out'))).resolve())
    provider: str = field(default_factory=lambda: os.getenv('PROVIDER',
        'openai' if os.getenv('OPENAI_API_KEY') else 'gemini' if os.getenv('GEMINI_API_KEY') else 'demo'))
    provider_fallback: str = field(default_factory=lambda: os.getenv('PROVIDER_FALLBACK', 'fal'))
    max_concurrency: int = field(default_factory=lambda: max(1, min(6, int(os.getenv('MAX_CONCURRENCY', '6')))))
    openai_api_key: str = field(default_factory=lambda: os.getenv('OPENAI_API_KEY', ''), repr=False)
    openai_image_model: str = field(default_factory=lambda: os.getenv('OPENAI_IMAGE_MODEL', 'gpt-image-2.5-sunburst'))
    openai_image_quality: str = field(default_factory=lambda: os.getenv('OPENAI_IMAGE_QUALITY', 'medium'))
    openai_image_timeout_s: float = field(default_factory=lambda: float(os.getenv('OPENAI_IMAGE_TIMEOUT_S', '180')))
    gemini_api_key: str = field(default_factory=lambda: os.getenv('GEMINI_API_KEY', ''), repr=False)
    fal_key: str = field(default_factory=lambda: os.getenv('FAL_KEY', ''), repr=False)
    k2_api_key: str = field(default_factory=lambda: os.getenv('K2_API_KEY', ''), repr=False)
    worldlab_api_key: str = field(default_factory=lambda: os.getenv('WORLDLAB_API_KEY', ''), repr=False)
    world_dir: Path = field(default_factory=lambda: Path(os.getenv('WORLD_DIR', str(ROOT / 'data/worlds'))).resolve())
    world_access_token: str = field(default_factory=lambda: os.getenv('WORLD_ACCESS_TOKEN') or secrets.token_urlsafe(32), repr=False)
    gemini_image_model: str = field(default_factory=lambda: os.getenv('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image'))
    gemini_text_model: str = field(default_factory=lambda: os.getenv('GEMINI_TEXT_MODEL', 'gemini-2.5-flash'))
    k2_model: str = field(default_factory=lambda: os.getenv('K2_MODEL', 'IFM/K2-Horizon-375B-A23B'))
    k2_base_url: str = field(default_factory=lambda: os.getenv('K2_BASE_URL', 'https://api.ifm.ai/v1'))
    fal_model: str = field(default_factory=lambda: os.getenv('FAL_MODEL', 'fal-ai/flux/dev/image-to-image'))

    def provider_configured(self, provider: str | None = None) -> bool:
        selected = provider if provider is not None else self.provider
        return selected == 'demo' or bool({
            'openai': self.openai_api_key, 'gemini': self.gemini_api_key, 'fal': self.fal_key,
        }.get(selected))


settings = Settings()
