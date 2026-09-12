"""Weather catalog parsing and prompt clauses."""

import pytest

from app.weather import apply_weather, parse_weather_ids, resolve_weathers, WEATHER_CATALOG


def test_parse_weather_ids_defaults_and_dedupes():
    assert parse_weather_ids(None) == ["clear", "rain", "snow"]
    assert parse_weather_ids(" snow, clear, snow ") == ["snow", "clear"]


def test_parse_weather_ids_rejects_unknown():
    with pytest.raises(ValueError, match="Unsupported weather"):
        parse_weather_ids("fog")


def test_resolve_weathers_optional():
    assert resolve_weathers(False) == []
    specs = resolve_weathers(True, "rain")
    assert [spec.id for spec in specs] == ["rain"]
    assert specs[0].clause == WEATHER_CATALOG["rain"].clause


def test_apply_weather_appends_clause():
    base = "Era prompt."
    assert apply_weather(base, None) == base
    rainy = apply_weather(base, WEATHER_CATALOG["rain"])
    assert rainy.startswith(base)
    assert "WEATHER_OVERRIDE" in rainy
    assert "Weather: rain" in rainy
    assert rainy.index("WEATHER_OVERRIDE") < rainy.index("Weather: rain")
