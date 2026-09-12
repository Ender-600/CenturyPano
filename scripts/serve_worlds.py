"""Start the local historical-world app without changing another running server."""
import argparse
import os
from pathlib import Path
import sys

from dotenv import load_dotenv
import uvicorn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8001)
    parser.add_argument('--data-dir', type=Path)
    args = parser.parse_args()
    load_dotenv(args.env_file)
    if args.data_dir:
        os.environ['WORLD_DIR'] = str(args.data_dir.resolve())
    uvicorn.run('app.main:app', host=args.host, port=args.port, access_log=False)


if __name__ == '__main__':
    main()
