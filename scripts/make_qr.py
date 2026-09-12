import argparse
from pathlib import Path
from urllib.parse import urlparse

import qrcode

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Create a QR code for the HTTPS phone demo.')
    parser.add_argument('url')
    parser.add_argument('--output', type=Path, default=Path('data/demo-qr.png'))
    args = parser.parse_args()
    if urlparse(args.url).scheme != 'https':
        parser.error('Use an HTTPS URL for the phone demo.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    qrcode.make(args.url).save(args.output)
    print(args.output.resolve())
