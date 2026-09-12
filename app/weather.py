"""Optional weather variants: one shared era prompt, weather-specific sky and ground."""

from __future__ import annotations

from dataclasses import dataclass

# Weather must never outrank the era reconstruction that precedes it.
ERA_WEATHER_LOCK = (
    "WEATHER_OVERRIDE: Change only atmosphere — sky, precipitation, wetness or snow on "
    "ground and roofs, and the lighting that weather implies. Keep the same historical "
    "year, architecture, materials, vehicles, clothing, signage style, land use, and "
    "camera framing from the era reconstruction above. Do not modernize the scene, do not "
    "add present-day objects, and do not replace period buildings with contemporary ones."
)


@dataclass(frozen=True)
class WeatherSpec:
    id: str
    label: str
    clause: str


# Keep ids stable: they are directory names and API values.
WEATHER_CATALOG: dict[str, WeatherSpec] = {
    "clear": WeatherSpec(
        "clear", "Clear",
        "Weather: clear sunny day — bright daylight, blue sky with light clouds, dry ground, "
        "strong natural sunlight and crisp shadows. Keep lighting, sky and palette consistent "
        "across the full panorama. Still a photograph of the historical year above.",
    ),
    "rain": WeatherSpec(
        "rain", "Rain",
        "Weather: rain — overcast gray sky, visible rainfall, wet reflective pavement and roofs, "
        "muted colors, soft diffused light. Keep lighting, sky and palette consistent across "
        "the full panorama. Still a photograph of the historical year above — rain on that era, "
        "not a modern street.",
    ),
    "snow": WeatherSpec(
        "snow", "Snow",
        "Weather: snow — cold pale winter sky, snow on ground ledges and roofs where it would settle, "
        "soft winter light, cool muted palette. Keep lighting, sky and palette consistent across "
        "the full panorama. Still a photograph of the historical year above — winter weather on "
        "that era, not a modern street.",
    ),
}

DEFAULT_WEATHER_IDS: tuple[str, ...] = ("clear", "rain", "snow")


def parse_weather_ids(raw: str | None) -> list[str]:
    """Parse a comma-separated weather list; empty means the default set."""
    if raw is None or not str(raw).strip():
        return list(DEFAULT_WEATHER_IDS)
    ids: list[str] = []
    for part in str(raw).split(","):
        key = part.strip().lower()
        if not key:
            continue
        if key not in WEATHER_CATALOG:
            raise ValueError(f"Unsupported weather: {key}")
        if key not in ids:
            ids.append(key)
    if not ids:
        raise ValueError("Choose at least one weather")
    return ids


def resolve_weathers(enabled: bool, raw_ids: str | None = None) -> list[WeatherSpec]:
    if not enabled:
        return []
    return [WEATHER_CATALOG[key] for key in parse_weather_ids(raw_ids)]


def apply_weather(prompt: str, weather: WeatherSpec | None) -> str:
    if weather is None:
        return prompt
    return f"{prompt.rstrip()}\n{ERA_WEATHER_LOCK}\n{weather.clause}"


def weather_subdir(weather_id: str) -> str:
    return f"weathers/{weather_id}"
