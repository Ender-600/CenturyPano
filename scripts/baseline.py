import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.manifest import read_manifest
from app.pipeline import run_baseline

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run an additional serial job (incurs provider usage in live mode).')
    parser.add_argument('job_id')
    args = parser.parse_args()
    asyncio.run(run_baseline(args.job_id))
    print(read_manifest(args.job_id)['metrics'])
