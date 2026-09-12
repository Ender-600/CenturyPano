"""Resolve photo locations and provide structured geographical history context."""
import math
import re
import threading
from functools import lru_cache

import reverse_geocoder as rg

_lock = threading.Lock()

COUNTRY_NAMES = {
    'US': 'USA', 'GB': 'United Kingdom', 'CN': 'China', 'CA': 'Canada',
    'JP': 'Japan', 'FR': 'France', 'DE': 'Germany', 'AU': 'Australia',
    'IN': 'India', 'IT': 'Italy', 'ES': 'Spain', 'PT': 'Portugal',
    'BR': 'Brazil', 'MX': 'Mexico', 'KR': 'South Korea', 'TW': 'Taiwan',
    'HK': 'Hong Kong', 'SG': 'Singapore', 'NZ': 'New Zealand',
    'NL': 'Netherlands', 'BE': 'Belgium', 'CH': 'Switzerland',
    'AT': 'Austria', 'SE': 'Sweden', 'NO': 'Norway', 'DK': 'Denmark',
    'FI': 'Finland', 'IE': 'Ireland', 'PL': 'Poland', 'RU': 'Russia',
    'UA': 'Ukraine', 'TR': 'Turkey', 'GR': 'Greece', 'EG': 'Egypt',
    'ZA': 'South Africa', 'AR': 'Argentina', 'CL': 'Chile', 'PE': 'Peru',
    'TH': 'Thailand', 'VN': 'Vietnam', 'ID': 'Indonesia', 'MY': 'Malaysia',
    'PH': 'Philippines', 'PK': 'Pakistan', 'BD': 'Bangladesh',
}
COUNTRY_ALIASES = {name.casefold(): cc for cc, name in COUNTRY_NAMES.items()} | {
    'united states': 'US', 'united states of america': 'US', '美国': 'US',
    'uk': 'GB', 'britain': 'GB', '英国': 'GB', '中国': 'CN', '日本': 'JP',
    '加拿大': 'CA', '法国': 'FR', '德国': 'DE', '澳大利亚': 'AU',
}
US_STATES = dict(zip(
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(),
    'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming'.split('|'),
))


def _valid(lat, lon):
    return (not isinstance(lat, bool) and not isinstance(lon, bool)
            and isinstance(lat, (int, float)) and isinstance(lon, (int, float))
            and math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180)


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
    parts = [part.strip() for part in re.split(r'[,，]', place) if part.strip()]
    query = parts[0].casefold() if parts else ''
    with _lock:
        geocoder = rg.RGeocoder(mode=1, verbose=False)
        matches = [r for r in geocoder.locations if r['name'].casefold() == query]
    # Every supplied qualifier must match; never silently ignore a country or
    # choose the first same-named city (formerly biased toward the USA).
    for suffix in parts[1:]:
        country = COUNTRY_ALIASES.get(suffix.casefold())
        upper = suffix.upper()
        if country:
            matches = [r for r in matches if r['cc'] == country]
        elif re.fullmatch(r'[A-Z]{2}', upper):
            # Codes such as CA can mean Canada or California. Keep both
            # candidates until another qualifier disambiguates them.
            matches = [r for r in matches if r['cc'] == upper or (
                r['cc'] == 'US' and US_STATES.get(upper, '').casefold() == r['admin1'].casefold())]
        else:
            matches = [r for r in matches if suffix.casefold() in {
                r['admin1'].casefold(), r.get('admin2', '').casefold(),
            } or (r['cc'] == 'US' and US_STATES.get(upper, '').casefold() == r['admin1'].casefold())]
    if len(matches) == 1:
        return {k: matches[0][k] for k in ('name', 'admin1', 'cc')} | {'prompt_safe': True}
    return {'name': place[:80], 'admin1': '', 'cc': '', 'prompt_safe': False}


def resolve_place(lat=None, lon=None, gps=None, place='') -> dict:
    result = {'name': '', 'admin1': '', 'cc': '', 'lat': None, 'lon': None, 'source': 'none'}
    if place.strip():
        return result | _manual_city(place.strip()) | {'source': 'manual'}
    if gps:
        return result | city_from_latlon(*gps) | {'lat': gps[0], 'lon': gps[1], 'source': 'exif', 'prompt_safe': True}
    if lat is not None and lon is not None:
        return result | city_from_latlon(lat, lon) | {'lat': lat, 'lon': lon, 'source': 'geolocation', 'prompt_safe': True}
    return result


def _clean_name(value) -> str:
    if not isinstance(value, str):
        return ''
    value = value.strip()
    if len(value) > 100 or re.search(r'[\d/\\\n\r<>;:{}]', value):
        return ''
    return value


def location_context(place: dict) -> dict:
    """Expose resolved place data, including GPS, for exact-site history reasoning.

    A city centroid is never invented for manual input. Unresolved manual text
    remains a UI label, and GPS is context rather than evidence of past land use.
    """
    if not isinstance(place, dict):
        place = {}
    source = place.get('source')
    source = source if source in {'manual', 'geolocation', 'exif', 'none'} else 'none'
    safe = place.get('prompt_safe') is not False and (source != 'manual' or place.get('prompt_safe') is True)
    city = _clean_name(place.get('name')) if safe else ''
    admin = _clean_name(place.get('admin1')) if safe else ''
    cc = str(place.get('cc') or '').strip().upper() if safe else ''
    if not re.fullmatch(r'[A-Z]{2}', cc):
        cc = ''
    # A direct caller cannot smuggle a street address through the city field.
    if re.search(r'\b(street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?)$', city, re.I):
        city = ''
    coordinates = None
    if source != 'manual' and _valid(place.get('lat'), place.get('lon')):
        coordinates = {'lat': place['lat'], 'lon': place['lon']}
    return {'city': city, 'country': COUNTRY_NAMES.get(cc, cc), 'country_code': cc,
            'admin1': admin, 'coordinates': coordinates, 'source': source,
            'precision': 'coordinates' if coordinates else 'city' if city else 'unknown'}
