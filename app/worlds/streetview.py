"""Bounded, opt-in Google Street View RGB panorama input.

The switch represents separately verified permission covering extraction,
retention and external AI processing. A Maps API key alone is insufficient.
Nothing is downloaded, cached, or submitted to another provider by default.
"""

from __future__ import annotations

import asyncio
import io
import json
import math
import re
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from PIL import Image, UnidentifiedImageError


_BASE = "https://tile.googleapis.com"
_JSON_LIMIT = 128 * 1024
_TILE_LIMIT = 2 * 1024 * 1024
_TOTAL_LIMIT = 48 * 1024 * 1024
_MAX_REQUESTS = 50
_MAX_ZOOM = 5
_ID = re.compile(r"[A-Za-z0-9_-]{1,256}\Z")


class StreetViewError(Exception):
    """Safe errors never contain upstream response bodies or keyed URLs."""

    def __init__(self, message: str, *, code: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _error(code: str, status_code: int | None = None) -> StreetViewError:
    messages = {
        "missing_key": "Google Maps API key is not configured.",
        "invalid_key": "Google Maps API key has an invalid format.",
        "ai_use_not_authorized": "Street View external AI processing permission is not configured.",
        "invalid_location": "Street View requires valid coordinates and a bounded search radius.",
        "invalid_response": "Street View returned invalid or unsupported panorama metadata.",
        "no_coverage": "No Street View panorama is available within the search radius.",
        "http_error": "Street View request failed.",
        "transport_error": "Street View connection failed.",
        "response_too_large": "Street View response exceeds the download limit.",
        "incomplete_panorama": "Street View panorama tiles are incomplete or invalid.",
        "request_limit": "Street View panorama exceeds the request budget.",
    }
    return StreetViewError(messages[code], code=code, status_code=status_code)


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _location(lat: float, lon: float) -> bool:
    return _number(lat) and _number(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def streetview_url(lat: float, lon: float) -> str:
    """Open Google's viewer near these coordinates; this is not an image URL."""
    if not _location(lat, lon):
        raise _error("invalid_location")
    return "https://www.google.com/maps/@?" + urlencode({
        "api": "1", "map_action": "pano", "viewpoint": f"{lat:.7f},{lon:.7f}",
    })


def _distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a1, a2 = math.radians(lat1), math.radians(lat2)
    chord = math.sin((a2 - a1) / 2) ** 2 + math.cos(a1) * math.cos(a2) * math.sin(
        math.radians(lon2 - lon1) / 2,
    ) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1, max(0, chord))))


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    a1, a2, delta = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    return math.degrees(math.atan2(math.sin(delta) * math.cos(a2),
        math.cos(a1) * math.sin(a2) - math.sin(a1) * math.cos(a2) * math.cos(delta))) % 360


def _angle(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def _text(value: Any, limit: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit and not any(
        ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value
    )


def _report_link(value: Any, pano_id: str) -> str | None:
    if not _text(value, 2048):
        return None
    try:
        url = urlsplit(value)
        query = parse_qs(url.query, strict_parsing=True)
        allowed = {"output", "panoid", "cb_client", "cbp", "hl", "gl"}
        if (
            url.scheme == "https" and url.netloc == "cbks0.googleapis.com" and url.path == "/cbk"
            and not url.fragment and set(query) <= allowed
            and query.get("output") == ["report"] and query.get("panoid") == [pano_id]
            and all(len(values) == 1 for values in query.values())
        ):
            return value
    except ValueError:
        pass
    return None


def _metadata(data: dict, lat: float, lon: float, radius: float) -> dict:
    pano = data.get("panoId")
    if not isinstance(pano, str) or _ID.fullmatch(pano) is None:
        raise _error("invalid_response")
    if not _location(data.get("lat"), data.get("lng")):
        raise _error("invalid_response")
    distance = _distance(lat, lon, data["lat"], data["lng"])
    if distance > radius + 1:
        raise _error("no_coverage")
    width, height = data.get("imageWidth"), data.get("imageHeight")
    tw, th = data.get("tileWidth"), data.get("tileHeight")
    if (
        type(width) is not int or type(height) is not int or width != height * 2
        or not 2048 <= width <= 32768 or tw != 512 or th != 512
        or type(tw) is not int or type(th) is not int
    ):
        raise _error("invalid_response")
    for name, maximum in (("heading", 360), ("tilt", 180), ("roll", 360)):
        if not _number(data.get(name)) or not 0 <= data[name] <= maximum:
            raise _error("invalid_response")
    if not _text(data.get("copyright"), 1024):
        raise _error("invalid_response")
    date = data.get("date")
    if date is not None and (not isinstance(date, str) or not re.fullmatch(r"[12]\d{3}(?:-(?:0[1-9]|1[0-2]))?", date)):
        raise _error("invalid_response")
    # z=5 is native size in the documented six-level pyramid. Refuse dimensions
    # that cannot be exactly divided: do not stretch, guess, or crop image content.
    for zoom in (3, 2, 1):
        divisor = 1 << (_MAX_ZOOM - zoom)
        if width % divisor or height % divisor:
            continue
        out_w, out_h = width // divisor, height // divisor
        nx, ny = math.ceil(out_w / tw), math.ceil(out_h / th)
        if out_w <= 3840 and out_w * out_h <= 8_294_400 and 2 + nx * ny <= _MAX_REQUESTS:
            break
    else:
        raise _error("invalid_response")
    result = {
        "pano_id": pano, "lat": data["lat"], "lon": data["lng"],
        "requested_lat": lat, "requested_lon": lon, "search_radius_m": radius,
        "distance_m": round(distance, 3), "heading": data["heading"],
        "tilt": data["tilt"], "roll": data["roll"],
        "image_width": out_w, "image_height": out_h,
        "source_image_width": width, "source_image_height": height,
        "tile_width": tw, "tile_height": th, "zoom": zoom,
        "copyright": data["copyright"], "date": date,
        "panorama_format": "equirectangular_360x180",
        "orientation_transform_applied": False,
        "provider": "google_streetview_tiles", "coordinate_alignment_verified": False,
    }
    link = _report_link(data.get("reportProblemLink"), pano)
    if link:
        result["report_problem_link"] = link
    if isinstance(data.get("imageryType"), str) and data["imageryType"] in {"indoor", "outdoor"}:
        result["imagery_type"] = data["imageryType"]
    # Only official adjacency identifiers and headings survive this boundary.
    # Never retain link text, URLs, session tokens, or arbitrary provider fields.
    links = data.get("links", [])
    result["links"] = []
    if isinstance(links, list) and len(links) <= 32:
        seen = {pano}
        for adjacent in links:
            if not isinstance(adjacent, dict):
                continue
            target, heading = adjacent.get("panoId"), adjacent.get("heading")
            if (isinstance(target, str) and _ID.fullmatch(target) and target not in seen
                    and _number(heading) and 0 <= heading <= 360):
                seen.add(target)
                result["links"].append({"pano_id": target, "heading": heading % 360})
    return result


class GoogleStreetViewClient:
    """One complete RGB panorama per call, with no retries or persistent cache."""

    def __init__(
        self, api_key: str | None, *, ai_authorized: bool = False,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise _error("missing_key")
        if _ID.fullmatch(api_key.strip()) is None:
            raise _error("invalid_key")
        if ai_authorized is not True:
            raise _error("ai_use_not_authorized")
        self._key = api_key.strip()
        self._client = httpx.AsyncClient(
            base_url=_BASE, timeout=httpx.Timeout(30, connect=10),
            headers={"Accept-Encoding": "identity"},
            follow_redirects=False, trust_env=False, transport=transport,
        )
        self._semaphore = asyncio.Semaphore(8)
        self._fetch_lock = asyncio.Lock()

    async def __aenter__(self) -> GoogleStreetViewClient:
        return self

    async def __aexit__(self, exc_type, exc_value, traceback) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _download(self, method, path, budget, *, params=None, payload=None, image=False):
        # No caller- or upstream-supplied host/path can reach this method.
        query = {"key": self._key, **(params or {})}
        async with self._semaphore:
            if budget["requests"] >= _MAX_REQUESTS:
                raise _error("request_limit")
            budget["requests"] += 1
            try:
                async with self._client.stream(method, path, params=query, json=payload) as response:
                    if not response.is_success:
                        if response.status_code == 404 and path.endswith("/metadata"):
                            raise _error("no_coverage", 404)
                        raise _error("http_error", response.status_code)
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        raise _error("invalid_response")
                    limit = _TILE_LIMIT if image else _JSON_LIMIT
                    content_length = response.headers.get("content-length", "")
                    if content_length.isdecimal() and int(content_length) > limit:
                        raise _error("response_too_large")
                    if image and response.headers.get("content-type", "").split(";")[0] not in {"image/jpeg", "image/png"}:
                        raise _error("incomplete_panorama")
                    chunks, length = [], 0
                    async for chunk in response.aiter_bytes(64 * 1024):
                        length += len(chunk)
                        budget["bytes"] += len(chunk)
                        if length > limit or budget["bytes"] > _TOTAL_LIMIT:
                            raise _error("response_too_large")
                        chunks.append(chunk)
                    body = b"".join(chunks)
            except httpx.HTTPError:
                raise _error("transport_error") from None
        if image:
            return body
        try:
            data = json.loads(body)
        except (ValueError, UnicodeError):
            raise _error("invalid_response") from None
        if not isinstance(data, dict):
            raise _error("invalid_response")
        upstream_error = data.get("error")
        if data.get("status") == "ZERO_RESULTS" or (
            isinstance(upstream_error, dict) and upstream_error.get("status") == "NOT_FOUND"
        ):
            raise _error("no_coverage")
        return data

    async def fetch_panorama(self, lat: float, lon: float, *, radius_m: float = 50) -> dict:
        if not _location(lat, lon) or not _number(radius_m) or not 1 <= radius_m <= 150:
            raise _error("invalid_location")
        async with self._fetch_lock:
            return await self._fetch(lat, lon, radius_m)

    async def _fetch(self, lat, lon, radius):
        budget = {"requests": 0, "bytes": 0}
        session = await self._session(budget)
        metadata = await self._get_metadata(session, budget, lat, lon, radius)
        return await self._tiles(metadata, session, budget)

    async def _session(self, budget):
        session_data = await self._download("POST", "/v1/createSession", budget, payload={
            "mapType": "streetview", "language": "en-US", "region": "US",
        })
        session = session_data.get("session")
        if not isinstance(session, str) or _ID.fullmatch(session) is None:
            raise _error("invalid_response")
        return session

    async def _get_metadata(self, session, budget, lat, lon, radius, pano_id=None):
        raw = await self._download("GET", "/v1/streetview/metadata", budget, params={
            "session": session, **({"panoId": pano_id} if pano_id else
                                    {"lat": lat, "lng": lon, "radius": radius}),
        })
        metadata = _metadata(raw, lat, lon, radius)
        if pano_id is not None and metadata["pano_id"] != pano_id:
            raise _error("invalid_response")
        public_json = json.dumps(metadata)
        if self._key in public_json or session in public_json:
            raise _error("invalid_response")
        return metadata

    async def select_forward_panorama(self, lat: float, lon: float, *, heading_deg: float,
                                      lookahead_m: float, current_pano_id: str | None = None) -> dict:
        """Follow official road links; at most nine metadata calls and no tiles.

        A nearby GPS panorama is the anchor, so an old displayed camera cannot
        pull a walker back to a street they have already left. Forks with two
        similarly plausible forward links are deliberately left unpredicted.
        """
        if (not _location(lat, lon) or not _number(heading_deg) or not 0 <= heading_deg < 360
                or not _number(lookahead_m) or not 30 <= lookahead_m <= 150):
            raise _error("invalid_location")
        async with self._fetch_lock:
            budget = {"requests": 0, "bytes": 0}
            session = await self._session(budget)
            current = await self._get_metadata(session, budget, lat, lon, 35)
            path = [current["pano_id"]]
            minimum = max(25, lookahead_m * .65)
            best = None
            for _ in range(8):
                if current.get("imagery_type") == "indoor":
                    return {"status": "skipped", "reason": "indoor_coverage"}
                choices = sorted(((_angle(link["heading"], heading_deg), link)
                    for link in current["links"] if link["pano_id"] not in path), key=lambda item: item[0])
                choices = [item for item in choices if item[0] <= 45]
                if not choices:
                    return best or {"status": "skipped", "reason": "no_forward_link"}
                if len(choices) > 1 and choices[1][0] - choices[0][0] < 20:
                    return best or {"status": "skipped", "reason": "ambiguous_junction"}
                next_pano = await self._get_metadata(session, budget, lat, lon,
                                                    lookahead_m + 60, choices[0][1]["pano_id"])
                segment = _distance(current["lat"], current["lon"], next_pano["lat"], next_pano["lon"])
                bearing = _bearing(current["lat"], current["lon"], next_pano["lat"], next_pano["lon"])
                distance = _distance(lat, lon, next_pano["lat"], next_pano["lon"])
                if (not 2 <= segment <= 100 or _angle(bearing, heading_deg) > 60
                        or _angle(_bearing(lat, lon, next_pano["lat"], next_pano["lon"]), heading_deg) > 45
                        or next_pano.get("imagery_type") == "indoor"):
                    return {"status": "skipped", "reason": "route_diverges"}
                path.append(next_pano["pano_id"])
                if next_pano["pano_id"] != current_pano_id and minimum <= distance <= lookahead_m + 35:
                    best = {"metadata": next_pano, "path": list(path), "distance_m": round(distance, 2),
                            "metadata_requests": budget["requests"] - 1}
                if distance >= lookahead_m:
                    return best or {"status": "skipped", "reason": "target_too_far"}
                current = next_pano
            return best or {"status": "skipped", "reason": "insufficient_route"}

    async def fetch_panorama_by_id(self, pano_id: str, *, lat: float, lon: float) -> dict:
        """Download the selected camera, never a second nearest-coordinate match."""
        if not isinstance(pano_id, str) or not _ID.fullmatch(pano_id) or not _location(lat, lon):
            raise _error("invalid_location")
        async with self._fetch_lock:
            budget = {"requests": 0, "bytes": 0}
            session = await self._session(budget)
            metadata = await self._get_metadata(session, budget, lat, lon, 1, pano_id)
            return await self._tiles(metadata, session, budget)

    async def _tiles(self, metadata, session, budget):
        width, height = metadata["image_width"], metadata["image_height"]
        tw, th = metadata["tile_width"], metadata["tile_height"]
        canvas = Image.new("RGB", (width, height))

        async def tile(x, y):
            body = await self._download(
                "GET", f"/v1/streetview/tiles/{metadata['zoom']}/{x}/{y}", budget,
                params={"session": session, "panoId": metadata["pano_id"]}, image=True,
            )
            try:
                with Image.open(io.BytesIO(body)) as source:
                    if source.format not in {"JPEG", "PNG"} or source.size != (tw, th):
                        raise _error("incomplete_panorama")
                    source.load()
                    # Only discard tile padding beyond the metadata's image extent.
                    right, bottom = min(tw, width - x * tw), min(th, height - y * th)
                    canvas.paste(source.convert("RGB").crop((0, 0, right, bottom)), (x * tw, y * th))
            except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
                raise _error("incomplete_panorama") from None

        tasks = [asyncio.create_task(tile(x, y)) for y in range(math.ceil(height / th))
                 for x in range(math.ceil(width / tw))]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        output = io.BytesIO()
        canvas.save(output, "JPEG", quality=95, subsampling=0)
        if output.tell() > 10 * 1024 * 1024:
            raise _error("response_too_large")
        metadata["request_count"] = budget["requests"]
        return {"image_bytes": output.getvalue(), "metadata": metadata}
