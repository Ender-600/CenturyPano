"""Exact reconstruction years, with compatibility for the original era presets."""
from datetime import datetime
import re

MIN_YEAR = 1800
MAX_YEAR = datetime.now().year
DEFAULT_YEAR = 1920
DECADE_ANCHOR = {'1900s': 1905, '1920s': 1925, '1950s': 1955, '1970s': 1975}


def resolve_year(value) -> int:
    """Resolve a strict calendar year or one of the four legacy decade aliases."""
    if isinstance(value, str):
        value = value.strip()
        if value in DECADE_ANCHOR:
            return DECADE_ANCHOR[value]
        if not re.fullmatch(r'[0-9]{4}', value):
            raise ValueError('Expected an integer calendar year')
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or not MIN_YEAR <= value <= MAX_YEAR:
        raise ValueError(f'Year must be between {MIN_YEAR} and {MAX_YEAR}')
    return value


def decade_for_year(year) -> str:
    return f'{resolve_year(year) // 10 * 10}s'


def manifest_year(manifest: dict) -> int:
    """Read exact-year manifests and archived manifests from the preset UI."""
    for field in ('target_year', 'anchor_year', 'decade'):
        if manifest.get(field) is not None:
            return resolve_year(manifest[field])
    return DEFAULT_YEAR
