"""Generate ONE paid Marble Draft world, or resume an existing operation without resubmitting.

  python scripts/probe_marble.py photo.heic --year 1925
  python scripts/probe_marble.py --resume data/probes/marble/RUN_ID

Input, operation responses, and asset URLs stay in the ignored probe directory.
This measures generation/download, not GPU rendering, AR tracking, or historical accuracy.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sys
import time
import uuid

from dotenv import load_dotenv
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.worlds.marble import MarbleClient, MarbleError, SubmissionUnknown

register_heif_opener()


def prepare_input(path: Path) -> tuple[bytes, dict]:
    """Preserve the complete oriented frame/aspect ratio; remove EXIF and bound upload size."""
    if path.stat().st_size > 40 * 1024 * 1024:
        raise ValueError('Input exceeds 40 MB')
    original = path.read_bytes()
    with Image.open(BytesIO(original)) as image:
        if image.width * image.height > 100_000_000 or min(image.size) < 32:
            raise ValueError('Unsupported image dimensions')
        oriented = ImageOps.exif_transpose(image).convert('RGB')
        original_size = list(oriented.size)
        oriented.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
        buffer = BytesIO()
        oriented.save(buffer, 'JPEG', quality=92, exif=b'')
    data = buffer.getvalue()
    return data, {
        'source_sha256': sha256(original).hexdigest(), 'input_sha256': sha256(data).hexdigest(),
        'original_dimensions': original_size, 'submitted_dimensions': list(oriented.size),
        'bytes': len(data), 'is_pano': False,
        'preprocessing': 'EXIF orientation, full frame, aspect-preserving max 2048 px, JPEG without metadata',
    }


def historical_prompt(year: int) -> str:
    return (
        f'Reimagine the environment in the supplied photograph as it might have appeared in {year}. '
        'Preserve the visible spatial layout, major walls, openings, and camera viewpoint. '
        'Replace present-day electronics, furnishings, finishes, clothing, and signage with plausible '
        f'period-appropriate equivalents for {year}. Remove people rather than copying their identity. '
        'Create a coherent explorable environment with continuous surfaces and plausible hidden areas. '
        'This is an imaginative historical reconstruction, not a verified record of this location.'
    )


def save_record(directory: Path, record: dict) -> None:
    temporary = directory / 'report.json.tmp'
    temporary.write_text(json.dumps(record, indent=2, ensure_ascii=False) + '\n')
    temporary.replace(directory / 'report.json')


def public_summary(record: dict) -> dict:
    """Explicit allowlist: never print provider payloads, signed URLs, keys, or source images."""
    allowed = ('status', 'model', 'requested_year', 'effective_year', 'operation_id', 'world_id',
               'generation_calls', 'timing_s', 'settled_credits', 'credits_before', 'credits_after',
               'error_code', 'error_type', 'http_status', 'report_path', 'validation')
    result = {key: record[key] for key in allowed if key in record}
    if 'assets' in record:
        result['assets'] = [{k: asset[k] for k in ('kind', 'path', 'bytes', 'sha256', 'validation')
                             if k in asset} for asset in record['assets']]
    return result


async def run_probe(*, api_key: str, output_dir: Path, input_path: Path | None = None,
                    year: int = 1925, resume: bool = False, wait_s: float = 600,
                    poll_s: float = 5, client=None, downloader=None) -> dict:
    """The record is written BEFORE the paid POST; only GETs are allowed on resume."""
    if not api_key.strip():
        raise ValueError('WORLDLAB_API_KEY is not configured')
    if not 1 <= year <= 2100 or wait_s <= 0 or poll_s <= 0:
        raise ValueError('Invalid year or polling settings')
    if resume:
        record = json.loads((output_dir / 'report.json').read_text())
        if not record.get('operation_id'):
            raise ValueError('No saved operation ID; reconcile the previous submission before generating again')
        if record.get('status') == 'assets_verified':
            return record
    else:
        if input_path is None:
            raise ValueError('An input image is required')
        prepared_at = time.time()
        image_bytes, image_info = prepare_input(input_path)
        output_dir.mkdir(parents=True, exist_ok=False)
        (output_dir / 'input.jpg').write_bytes(image_bytes)
        record = {
            'schema_version': 1, 'status': 'prepared', 'model': 'marble-1.0-draft',
            'requested_year': year, 'effective_year': year, 'input': image_info,
            'prompt': historical_prompt(year), 'generation_calls': 0,
            'started_at': datetime.now(timezone.utc).isoformat(), 'started_epoch': prepared_at,
            'report_path': str((output_dir / 'report.json').resolve()),
            'timing_s': {'input_preparation': round(time.time() - prepared_at, 3)},
            'validation': {'historical_accuracy': 'unverified', 'gpu_rendering': 'unverified',
                           'phone_6dof': 'unverified', 'real_world_alignment': 'unverified'},
        }
        save_record(output_dir, record)
    active_client = client or MarbleClient(api_key)
    try:
        if not resume:
            balance = await active_client.credits()
            record['credits_before'] = balance['remaining_credits']
            # Draft + non-pano is currently 150 + 80 credits. No refill/purchase occurs here.
            if balance['remaining_credits'] < 230:
                record.update(status='insufficient_credits', error_code='insufficient_credits')
                return record
            record.update(status='submitting', generation_calls=1, submitted_epoch=time.time())
            save_record(output_dir, record)
            operation = await active_client.generate_image(
                image_bytes, record['prompt'], f'CenturyPano M0 imagined {year}',
                model=record['model'], is_pano=False,
            )
            record.update(operation_id=operation['operation_id'], status='generating', operation=operation)
            record['timing_s']['submission'] = round(time.time() - record['submitted_epoch'], 3)
            save_record(output_dir, record)
            print(json.dumps(public_summary(record)), flush=True)
        else:
            operation = await active_client.operation(record['operation_id'])
        deadline = time.monotonic() + wait_s
        while not operation['done']:
            if time.monotonic() >= deadline:
                record['status'] = 'pending'
                return record
            await asyncio.sleep(min(poll_s, max(0, deadline - time.monotonic())))
            operation = await active_client.operation(record['operation_id'])
            record['operation'] = operation
            save_record(output_dir, record)
        record['operation'] = operation
        if operation.get('error') is not None:
            record.update(status='generation_failed', error_code='operation_failed')
            return record
        record.setdefault('completed_epoch', time.time())
        record['timing_s']['generation_observed'] = round(record['completed_epoch'] - record['submitted_epoch'], 3)
        cost = operation.get('cost')
        if isinstance(cost, dict) and isinstance(cost.get('total_credits'), (float, int)):
            record['settled_credits'] = cost['total_credits']
        world = operation.get('response') or {}
        if isinstance(world.get('world'), dict):
            world = world['world']
        world_id = world.get('world_id') or world.get('id')
        if not world_id:
            metadata = operation.get('metadata') or {}
            world_id = metadata.get('world_id')
        if not world_id:
            record.update(status='result_invalid', error_code='missing_world_id')
            return record
        world = await active_client.world(world_id)
        record.update(status='fetching_assets', world_id=world_id, world=world)
        save_record(output_dir, record)
        if downloader is None:
            from app.worlds.assets import download_assets
            downloader = download_assets
        started = time.monotonic()
        record['assets'] = await downloader(world, output_dir / 'assets')
        record['timing_s']['asset_download_validation'] = round(time.monotonic() - started, 3)
        record['timing_s']['total_to_assets'] = round(time.time() - record['started_epoch'], 3)
        record['status'] = 'assets_verified'
        # Billing is diagnostic; a failed balance GET must not discard a successful generation.
        try:
            record['credits_after'] = (await active_client.credits())['remaining_credits']
        except MarbleError:
            record['credits_after_unavailable'] = True
        return record
    except SubmissionUnknown as exc:
        record.update(status='submission_unknown', error_code=exc.code)
        return record
    except MarbleError as exc:
        record.update(status='failed', error_code=exc.code, http_status=exc.status_code)
        return record
    except Exception as exc:
        # Preserve recoverable IDs and avoid reflecting provider URLs, response bodies, or secrets.
        unknown = record['status'] == 'submitting'
        record.update(status='submission_unknown' if unknown else 'failed', error_type=type(exc).__name__)
        return record
    finally:
        save_record(output_dir, record)
        if client is None:
            await active_client.aclose()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path, nargs='?')
    parser.add_argument('--year', type=int, default=1925)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--resume', type=Path)
    parser.add_argument('--env-file', type=Path, help='Explicit dotenv file for isolated worktrees')
    parser.add_argument('--wait-seconds', type=float, default=600)
    args = parser.parse_args()
    if args.env_file:
        load_dotenv(args.env_file)
    from app.config import ROOT, Settings
    config = Settings()
    directory = args.resume or args.output or ROOT / 'data/probes/marble' / str(uuid.uuid4())
    try:
        record = asyncio.run(run_probe(api_key=config.worldlab_api_key, output_dir=directory.resolve(),
                                      input_path=args.image, year=args.year, resume=bool(args.resume),
                                      wait_s=args.wait_seconds))
    except (ValueError, OSError, MarbleError) as exc:
        print(json.dumps({'status': 'not_started', 'error_type': type(exc).__name__}))
        return 1
    print(json.dumps(public_summary(record), indent=2), flush=True)
    return 0 if record['status'] == 'assets_verified' else 2 if record['status'] == 'pending' else 1


if __name__ == '__main__':
    raise SystemExit(main())
