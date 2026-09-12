"""Run a supplied panorama and record a serial baseline, then mark as replay."""
import argparse
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from app.config import settings
from app.location import exif_gps, resolve_place
from app.main import initial_manifest
from app.manifest import create_manifest, read_manifest, update_manifest
from app.pipeline import run_baseline, run_job
from app.temporal import resolve_year

register_heif_opener()


async def make_replay(image_path: Path, decade: str, place='', *, baseline=True, is_360=None, title=None):
    job_id = str(uuid.uuid4())
    with Image.open(image_path) as image:
        gps = exif_gps(image)
        w, h = ImageOps.exif_transpose(image).size
    settings.in_dir.mkdir(parents=True, exist_ok=True)
    target = settings.in_dir / f'{job_id}{image_path.suffix.lower()}'
    target.write_bytes(image_path.read_bytes())
    source = {'path': f'in/{target.name}', 'w': w, 'h': h,
              'is_360': abs(w/h - 2) < 0.1 if is_360 is None else is_360}
    manifest = initial_manifest(job_id, source, decade, resolve_place(gps=gps, place=place))
    if title:
        manifest['title'] = title
    create_manifest(job_id, manifest)
    await run_job(job_id)
    if read_manifest(job_id)['status'] not in ('done', 'done_partial'):
        raise RuntimeError(f'Job failed: {job_id}; inspect its manifest.')
    if baseline:
        await run_baseline(job_id)
    update_manifest(job_id, lambda m: m.update(mode='replay'))
    return read_manifest(job_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('decade', type=resolve_year, metavar='YEAR',
                        help='Exact year (1800 through this year), or a legacy preset such as 1920s')
    parser.add_argument('--place', default='')
    parser.add_argument('--no-baseline', action='store_true', help='Skip the extra paid serial run')
    parser.add_argument('--is-360', action='store_true', default=None)
    args = parser.parse_args()
    m = asyncio.run(make_replay(args.image, args.decade, args.place, baseline=not args.no_baseline, is_360=args.is_360))
    print(f'Replay ready: /?replay={m["job_id"]}')
    print(f'Provider: {m.get("provider")}; metrics: {m["metrics"]}')


if __name__ == '__main__':
    main()
