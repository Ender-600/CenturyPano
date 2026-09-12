"""Bounded public-asset downloads and offline container inspection for Marble.

SPZ checks follow https://github.com/nianticlabs/spz#file-format: legacy
versions 1–3 have a gzip-compressed 16-byte header; v4 has a plaintext
32-byte NGSP header and a table of independently compressed ZSTD streams.
These are container/header checks, not Gaussian decoding or renderer tests.
Scale metadata is preserved, never applied here:
https://docs.worldlabs.ai/api/rendering-spz
"""
from __future__ import annotations

import asyncio
import gzip
import hashlib
import math
from pathlib import Path
import re
import struct
import tempfile
from urllib.parse import urlsplit
import warnings
import zlib

import httpx
from PIL import Image, UnidentifiedImageError

MAX_ASSET_BYTES = 100 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
CHUNK_BYTES = 64 * 1024
NGSP_MAGIC = 0x5053474E

# Explicit application policy, not a promise about every future provider URL.
# Unexpected hosts must be reviewed without generating the world a second time.
ALLOWED_ASSET_HOSTS = frozenset({"cdn.marble.worldlabs.ai"})


class AssetError(Exception):
    """Messages and codes are fixed; do not include signed URLs or HTTP bodies."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _mapping(value) -> dict:
    return value if isinstance(value, dict) else {}


def _validate_url(value: str) -> str:
    try:
        if not isinstance(value, str) or any(ord(character) <= 32 for character in value) or "\\" in value:
            raise ValueError
        parsed = urlsplit(value)
        if (parsed.scheme != "https" or parsed.hostname not in ALLOWED_ASSET_HOSTS
                or parsed.username is not None or parsed.password is not None
                or parsed.port not in (None, 443) or parsed.fragment):
            raise ValueError
    except (ValueError, TypeError):
        raise AssetError("unsupported_asset_url", "Asset URL is outside the approved HTTPS download policy.") from None
    return value


def _select_assets(world: dict) -> list[dict]:
    assets = _mapping(world.get("assets"))
    splats = _mapping(assets.get("splats"))
    urls = _mapping(splats.get("spz_urls"))
    available = {key: value for key, value in urls.items()
                 if isinstance(key, str) and isinstance(value, str) and value.strip()}
    if not available:
        raise AssetError("missing_spz", "World response has no downloadable SPZ asset; rendering capability is unavailable.")
    numeric = []
    for label in available:
        match = re.fullmatch(r"(\d+(?:\.\d+)?)([km]?)", label.lower().strip())
        if match:
            amount = float(match[1]) * {"": 1, "k": 1000, "m": 1_000_000}[match[2]]
            if amount > 0 and math.isfinite(amount):
                numeric.append((amount, label))
    # Keep the provider's complete scene when available. Numeric keys describe
    # reduced point counts, so select the largest one only as a fallback.
    lod = "full_res" if "full_res" in available else max(numeric)[1] if numeric else sorted(available)[0]
    selected = [{"kind": "spz", "lod": lod, "url": available[lod], "filename": "scene.spz"}]
    for kind, url, filename in (
        ("pano", _mapping(assets.get("imagery")).get("pano_url"), "panorama"),
        ("collider", _mapping(assets.get("mesh")).get("collider_mesh_url"), "collider.glb"),
    ):
        if url is not None:
            if not isinstance(url, str) or not url.strip():
                raise AssetError("invalid_asset_metadata", "An optional asset URL is malformed.")
            selected.append({"kind": kind, "url": url, "filename": filename})
    for item in selected:
        _validate_url(item["url"])
    return selected


def _semantics(world: dict) -> dict:
    supplied = _mapping(_mapping(_mapping(world.get("assets")).get("splats")).get("semantics_metadata"))
    values = {}
    invalid = False
    for key in ("metric_scale_factor", "ground_plane_offset"):
        if key not in supplied:
            continue
        value = supplied[key]
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                or key == "metric_scale_factor" and value <= 0):
            invalid = True
        else:
            values[key] = value
    status = "invalid" if invalid else "present" if len(values) == 2 else "partial" if values else "missing"
    return {"semantics_metadata": values or None, "semantics_status": status}


def inspect_spz(path: Path) -> dict:
    """Read bounded headers/TOC only; no full splat or ZSTD decoding occurs."""
    try:
        size = path.stat().st_size
        with path.open("rb") as source:
            prefix = source.read(32)
        if prefix.startswith(b"\x1f\x8b"):
            with gzip.open(path, "rb") as compressed:
                header = compressed.read(16)
            if len(header) != 16:
                raise ValueError
            magic, version, points, degree, fractional, flags, reserved = struct.unpack("<IIIBBBB", header)
            if magic != NGSP_MAGIC or version not in (1, 2, 3) or points == 0 or degree > 4 or reserved != 0:
                raise ValueError
            return {"level": "header_only", "format": "spz", "version": version,
                    "compression": "gzip", "num_points": points, "sh_degree": degree,
                    "fractional_bits": fractional, "flags": flags, "renderer_verified": False,
                    "payload_decoded": False, "limitation": "Gzip header inspected; complete payload and CRC not verified."}
        if len(prefix) != 32:
            raise ValueError
        magic, version, points, degree, fractional, flags, streams, toc, reserved = struct.unpack("<IIIBBBBI12s", prefix)
        if (magic != NGSP_MAGIC or version != 4 or points == 0 or degree > 4 or streams == 0
                or reserved != bytes(12) or toc < 32 or toc + streams * 16 > size):
            raise ValueError
        if not flags & 2 and toc != 32:
            raise ValueError
        with path.open("rb") as source:
            source.seek(toc)
            entries = [struct.unpack("<QQ", source.read(16)) for _ in range(streams)]
        if any(compressed == 0 for compressed, _ in entries):
            raise ValueError
        if toc + streams * 16 + sum(compressed for compressed, _ in entries) != size:
            raise ValueError
        return {"level": "header_and_toc", "format": "spz", "version": version,
                "compression": "zstd", "num_points": points, "sh_degree": degree,
                "fractional_bits": fractional, "flags": flags, "streams": streams,
                "declared_uncompressed_bytes": sum(raw for _, raw in entries),
                "renderer_verified": False, "payload_decoded": False,
                "limitation": "Header and stream byte ranges inspected; ZSTD streams, extensions and Gaussians not decoded."}
    except (OSError, EOFError, ValueError, struct.error, zlib.error):
        raise AssetError("invalid_spz", "SPZ asset failed the supported container/header inspection.") from None


def inspect_image(path: Path) -> dict:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.format not in ("JPEG", "PNG") or image.width * image.height > MAX_IMAGE_PIXELS:
                    raise ValueError
                result = {"level": "image_decoded", "format": image.format.lower(),
                          "width": image.width, "height": image.height, "renderer_verified": False}
                image.verify()
            # verify() alone does not decode JPEG scan data.
            with Image.open(path) as image:
                image.load()
        return result
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise AssetError("invalid_image", "Panorama asset is not a valid bounded JPEG or PNG image.") from None


def inspect_glb(path: Path) -> dict:
    try:
        with path.open("rb") as source:
            header = source.read(12)
        magic, version, length = struct.unpack("<4sII", header)
        if magic != b"glTF" or version != 2 or length != path.stat().st_size or length < 12:
            raise ValueError
    except (OSError, ValueError, struct.error):
        raise AssetError("invalid_glb", "Collider asset failed the GLB header and length inspection.") from None
    return {"level": "header_and_length", "format": "glb", "version": 2,
            "renderer_verified": False, "payload_decoded": False,
            "limitation": "GLB header checked; mesh topology, collision quality and glTF chunks are not verified."}


async def _download(client: httpx.AsyncClient, url: str, target: Path) -> dict:
    digest = hashlib.sha256()
    total = 0
    try:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise AssetError("asset_http_error", "Asset server did not return a successful download; redirects are not followed.")
            encoding = response.headers.get("content-encoding", "identity").lower()
            if encoding not in ("", "identity"):
                raise AssetError("unsupported_encoding", "Asset HTTP content encoding is unsupported by this bounded downloader.")
            supplied_length = response.headers.get("content-length")
            expected = None
            if supplied_length is not None:
                if len(supplied_length) > 20 or not re.fullmatch(r"\d+", supplied_length):
                    raise AssetError("invalid_content_length", "Asset server returned an invalid content length.")
                expected = int(supplied_length)
                if expected > MAX_ASSET_BYTES:
                    raise AssetError("asset_too_large", "Asset exceeds the 100 MB download limit.")
            with target.open("wb") as output:
                async for chunk in response.aiter_raw(CHUNK_BYTES):
                    total += len(chunk)
                    if total > MAX_ASSET_BYTES:
                        raise AssetError("asset_too_large", "Asset exceeds the 100 MB download limit.")
                    output.write(chunk)
                    digest.update(chunk)
            if not total or expected is not None and total != expected:
                raise AssetError("truncated_asset", "Asset download was empty or did not match its declared size.")
    except httpx.HTTPError:
        raise AssetError("asset_transport_error", "Asset download failed or timed out.") from None
    except OSError:
        raise AssetError("asset_io_error", "Asset could not be written to local storage.") from None
    return {"bytes": total, "sha256": digest.hexdigest()}


async def download_assets(world: dict, output_dir: Path) -> list[dict]:
    """Download one highest-detail SPZ and optional panorama/collider, without API keys.

    Missing SPZ is a capability error, even if the generation operation succeeded.
    Any error keeps the caller's existing outputs intact; staging files are removed.
    This function does not make generation requests or mutate the world response.
    """
    selected = _select_assets(world)
    output_dir = Path(output_dir).resolve()
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".asset-staging-", dir=output_dir) as staging:
            staged = []
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                         headers={"Accept-Encoding": "identity"},
                                         timeout=httpx.Timeout(60, connect=15)) as client:
                for item in selected:
                    temporary = Path(staging) / item["filename"]
                    received = await _download(client, item["url"], temporary)
                    inspector = {"spz": inspect_spz, "pano": inspect_image, "collider": inspect_glb}[item["kind"]]
                    checked = await asyncio.to_thread(inspector, temporary)
                    filename = item["filename"]
                    if item["kind"] == "pano":
                        filename += ".jpg" if checked["format"] == "jpeg" else ".png"
                    record = {"kind": item["kind"], "filename": filename,
                              "path": str(output_dir / filename), **received, "validation": checked,
                              "media_type": {"spz": "application/octet-stream", "collider": "model/gltf-binary",
                                             "pano": "image/" + checked["format"]}[item["kind"]]}
                    if item["kind"] == "spz":
                        record.update(lod=item["lod"], **_semantics(world))
                    staged.append((temporary, record))
            for temporary, record in staged:
                temporary.replace(output_dir / record["filename"])
            return [record for _, record in staged]
    except OSError:
        raise AssetError("asset_io_error", "Asset staging or publication failed.") from None
