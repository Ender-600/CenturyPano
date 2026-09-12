"""City-level geocoding only. Uploaded GPS never leaves this process."""
import math
import re
import threading
from functools import lru_cache

import reverse_geocoder as rg

_lock = threading.Lock()


def _valid(lat, lon):
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def city_from_latlon(lat: float, lon: float) -> dict:
    if not _valid(lat, lon):
        raise ValueError('Invalid coordinates')
    with _lock:
        r = rg.search((lat, lon), mode=1, verbose=False)[0]
    return {'name': r['name'], 'admin1': r['admin1'], 'cc': r['cc']}


def exif_gps(image) -> tuple[float, float] | None:
    try:
        gps = image.getexif().get_ifd(34853)
        if not gps:
            return None
        def degrees(value):
            return float(value[0]) + float(value[1]) / 60 + float(value[2]) / 3600
        lat = degrees(gps[2]) * (-1 if gps.get(1) in ('S', b'S') else 1)
        lon = degrees(gps[4]) * (-1 if gps.get(3) in ('W', b'W') else 1)
        return (lat, lon) if _valid(lat, lon) else None
    except (KeyError, TypeError, ValueError, ZeroDivisionError, AttributeError):
        return None


@lru_cache(maxsize=256)
def _manual_city(place: str) -> dict:
    # Resolve an exact city name in the same offline gazetteer. An unrecognised
    # free-text entry may be displayed, but is never copied into model prompts.
    query = re.split(r'[,，]', place)[0].strip().casefold()
    with _lock:
        geocoder = rg.RGeocoder(mode=1, verbose=False)
        matches = [r for r in geocoder.locations if r['name'].casefold() == query]
    if matches:
        chosen = next((r for r in matches if r['cc'] == 'US'), matches[0])
        return {k: chosen[k] for k in ('name', 'admin1', 'cc')} | {'prompt_safe': True}
    return {'name': place[:80], 'admin1': '', 'cc': '', 'prompt_safe': False}


def resolve_place(lat=None, lon=None, gps=None, place='') -> dict:
    result = {'name': '', 'admin1': '', 'cc': '', 'lat': None, 'lon': None, 'source': 'none'}
    if lat is not None and lon is not None:
        return result | city_from_latlon(lat, lon) | {'lat': lat, 'lon': lon, 'source': 'geolocation', 'prompt_safe': True}
    if gps:
        return result | city_from_latlon(*gps) | {'lat': gps[0], 'lon': gps[1], 'source': 'exif', 'prompt_safe': True}
    if place.strip():
        return result | _manual_city(place.strip()) | {'source': 'manual'}
    return result
