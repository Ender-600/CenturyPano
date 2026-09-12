"""Historical context bound to the panorama capture point, with no mesh input."""
from __future__ import annotations

import json
from pathlib import Path

from app.constraints import build_constraints
from app.scene import DEFAULT_SCENE_SPEC
from app.temporal import resolve_year


async def photo_history(lat: float, lon: float, year: int) -> dict:
    year = resolve_year(year)
    curated = json.loads((Path(__file__).parent / 'data/cmu_history.json').read_text())
    scope = curated['scope']
    at_cmu = scope['south'] <= lat <= scope['north'] and scope['west'] <= lon <= scope['east']
    place_name = ('Carnegie Institute of Technology campus (now Carnegie Mellon), Pittsburgh, Pennsylvania, United States'
                  if at_cmu else 'Street View capture location')
    context = await build_constraints({'name': place_name, 'lat': lat, 'lon': lon, 'source': 'geolocation',
                                       'coordinate_provenance': 'streetview_capture', 'prompt_safe': True},
                                      year, DEFAULT_SCENE_SPEC)
    history = context.to_dict()['historical_context']
    history.update(place_name=place_name, reference_date=f'{year}-07-01',
                   camera_location={'lat': lat, 'lon': lon}, geometry_authority='none_rgb_input')
    sources, rules = [], []
    if at_cmu:
        used = set()
        for building in curated['buildings']:
            years = building['completion_years']
            if building.get('mixed_phases') or min(years) <= year <= max(years):
                action = 'unknown'
                reason = 'Construction phases or completion dates are ambiguous; do not assume the entire visible building is historically unchanged.'
            elif year < min(years):
                action = 'remove_if_visible'
                reason = f'This completed building postdates {year}. Remove it only if identified in the source photo; earlier land use is unknown.'
            else:
                action = 'predates_target'
                reason = 'Completion predates the target year, but its exact historical appearance and later additions remain unverified.'
            name = building['aliases'][0]
            rules.append({'building_id': 'cmu:' + name, 'name': name, 'label': name, 'action': action,
                          'completion_years': years, 'reason': reason, 'evidence_ids': building['evidence_ids'],
                          'visibility': 'not_verified_in_image'})
            used.update(building['evidence_ids'])
        sources = [source for source in curated['sources'] if source['id'] in used]
    history['curated_site_rules'] = rules
    return {'history_context': history, 'sources': sources, 'changes': rules,
            'uncertainties': ['The Street View capture point may differ from your phone location, and the image may have been captured on an earlier date.',
                              'Historical rules apply only when the corresponding buildings can be identified in the photo; individual building identification has not been verified.',
                              'The historical appearance, panorama seam continuity, and generated world geometry still need review. These results do not establish an accurate historical reconstruction.']}
