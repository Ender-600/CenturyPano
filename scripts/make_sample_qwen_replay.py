"""One-shot: build a Qwen replay from sample/sample_image.jpg."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.manifest import read_manifest, update_manifest
from scripts.make_replay import make_replay


async def main() -> None:
    print(
        f"provider={settings.provider} vl={settings.k2_vl_model} "
        f"img={settings.qwen_image_model} fallback={settings.provider_fallback!r}",
        flush=True,
    )
    manifest = await make_replay(
        Path("sample/sample_image.jpg"),
        1925,
        "Pittsburgh, Pennsylvania, US",
        baseline=False,
        title="Pittsburgh campus · Qwen sample",
    )
    update_manifest(
        manifest["job_id"],
        lambda item: item["source"].update(
            example=True,
            attribution="Sample photograph; Qwen3-VL scene + Qwen image reconstruction.",
        ),
    )
    manifest = read_manifest(manifest["job_id"])
    job_id = manifest["job_id"]
    print("DONE", flush=True)
    print("job_id", job_id, flush=True)
    print(
        "status",
        manifest["status"],
        "mode",
        manifest["mode"],
        "provider",
        manifest["provider"],
        flush=True,
    )
    print("year", manifest.get("target_year"), flush=True)
    scene = manifest.get("scene") or {}
    print("scene_fallback", scene.get("fallback"), flush=True)
    print("scene_summary", scene.get("summary"), flush=True)
    print("history_fallback", (manifest.get("constraints") or {}).get("fallback"), flush=True)
    anchor = manifest.get("anchor") or {}
    print("anchor", anchor.get("status"), anchor.get("ms"), anchor.get("error"), flush=True)
    tiles = [
        (tile.get("i"), tile.get("status"), tile.get("provider"), tile.get("ms"), tile.get("error"))
        for tile in (manifest.get("tiles") or [])
    ]
    print("tiles", tiles, flush=True)
    print("metrics", json.dumps(manifest.get("metrics"), ensure_ascii=False), flush=True)
    print("url", f"http://localhost:8000/?replay={job_id}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
