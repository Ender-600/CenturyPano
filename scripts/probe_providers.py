"""Make one real image-edit call per provider and save independently verified output.

Examples:
  .venv/bin/python scripts/probe_providers.py panorama.jpg
  .venv/bin/python scripts/probe_providers.py panorama.jpg --provider gemini

The default order is Gemini, then fal. Configured probes incur provider usage.
No retries, fallback, demo editor, VLM, or constraint-model calls are performed.
Exit status: 0 = every requested provider passed, 1 = at least one failed,
2 = at least one was skipped because its credential is missing.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from io import BytesIO
import json
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from app.config import DEFAULT_DECADE, DECADE_ANCHOR, MAX_UPLOAD_MB, ROOT, TILE, settings
from app.constraints import generic_decade_prompt
from app.editors.base import ProviderError, get_editor
from app.geometry import image_bytes

register_heif_opener()


def prepare_input(path: Path) -> bytes:
    """Use the center square of the supplied photo, with no metadata in the probe."""
    if path.stat().st_size > MAX_UPLOAD_MB * 1024 * 1024:
        raise ValueError("Input image exceeds 40 MB")
    with Image.open(path) as image:
        if image.width * image.height > 100_000_000 or min(image.size) < 32:
            raise ValueError("Input image dimensions are unsupported")
        oriented = ImageOps.exif_transpose(image).convert("RGB")
        tile = ImageOps.fit(oriented, (TILE, TILE), Image.Resampling.LANCZOS)
    return image_bytes(tile)


async def probe_provider(provider: str, image: bytes, prompt: str,
                         output_dir: Path, timeout_s: float) -> dict:
    credential, configured = {
        "gemini": ("GEMINI_API_KEY", bool(settings.gemini_api_key)),
        "fal": ("FAL_KEY", bool(settings.fal_key)),
    }[provider]
    record = {"provider": provider, "status": "skipped", "generation_calls": 0}
    if not configured:
        record["reason"] = f"{credential} is not configured; no call was made."
        return record
    started = time.perf_counter()
    record["generation_calls"] = 1
    try:
        editor = get_editor(provider)
        output = await asyncio.wait_for(
            editor.edit(image, prompt, reference=None, strength=.45, seed=1925,
                        negative=None, timeout_s=timeout_s),
            timeout=timeout_s,
        )
        if not isinstance(output, bytes) or not output:
            raise ValueError("Provider returned no image bytes")
        with Image.open(BytesIO(output)) as generated:
            if generated.format != "JPEG" or generated.size != (TILE, TILE):
                raise ValueError("Provider output must be a 1024 by 1024 JPEG")
            generated.verify()
        filename = f"{provider}.jpg"
        output_dir.mkdir(parents=True, exist_ok=True)
        temporary = output_dir / f"{filename}.tmp"
        temporary.write_bytes(output)
        temporary.replace(output_dir / filename)
        record.update(status="passed", output=str(output_dir / filename),
                      width=TILE, height=TILE, bytes=len(output))
    except ProviderError as exc:
        # ProviderError is deliberately sanitized by the adapters.
        record.update(status="failed", reason=str(exc), error_type=type(exc).__name__)
    except (TimeoutError, asyncio.TimeoutError):
        record.update(status="failed", reason="The image edit exceeded the configured timeout.",
                      error_type="TimeoutError")
    except Exception as exc:
        # Do not print raw HTTP exceptions, URLs, response bodies, or credentials.
        record.update(status="failed", reason="Image edit or output verification failed.",
                      error_type=type(exc).__name__)
    record["elapsed_s"] = round(time.perf_counter() - started, 4)
    return record


async def run_probes(image_path: Path, providers: list[str], output_dir: Path,
                     *, decade: str = DEFAULT_DECADE, timeout_s: float = 60.0) -> tuple[dict, int]:
    image = await asyncio.to_thread(prepare_input, image_path)
    results = []
    prompt = generic_decade_prompt(decade)
    for provider in providers:
        result = await probe_provider(provider, image, prompt, output_dir, timeout_s)
        results.append(result)
        detail = result.get("output") or result.get("reason", "")
        print(f"{provider.upper()}: {result['status'].upper()} — {detail}", flush=True)
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "input": str(image_path.resolve()), "input_crop": "center square, 1024x1024, metadata removed",
        "decade": decade, "results": results,
        "scope": "Provider image-response validation only; not a reconstruction-quality or historical-accuracy test.",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    failed = any(result["status"] == "failed" for result in results)
    skipped = any(result["status"] == "skipped" for result in results)
    exit_code = 1 if failed else 2 if skipped else 0
    return report, exit_code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("image", type=Path, help="User-supplied panorama or photo (JPEG, PNG, HEIC)")
    parser.add_argument("--provider", choices=("all", "gemini", "fal"), default="all")
    parser.add_argument("--decade", choices=DECADE_ANCHOR, default=DEFAULT_DECADE)
    parser.add_argument("--timeout", type=float, default=60.0, help="Maximum seconds for each edit (default: 60)")
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()
    if not args.image.is_file():
        parser.error("The supplied image file does not exist.")
    if not 0 < args.timeout <= 300:
        parser.error("--timeout must be greater than zero and at most 300 seconds.")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = (args.output_dir or ROOT / "data/probes" / f"{stamp}-{uuid.uuid4().hex[:6]}").resolve()
    providers = ["gemini", "fal"] if args.provider == "all" else [args.provider]
    try:
        _, code = asyncio.run(run_probes(args.image, providers, output_dir,
                                       decade=args.decade, timeout_s=args.timeout))
    except Exception as exc:
        print(f"Probe setup failed ({type(exc).__name__}); no successful probe is claimed.", file=sys.stderr)
        return 1
    print(f"Report: {output_dir / 'report.json'}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
