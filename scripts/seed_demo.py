"""Create synthetic engineering fixtures. These are not photos or AI reconstructions."""
import asyncio
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from PIL import Image, ImageDraw
from app.config import ROOT, settings
from app.manifest import update_manifest
from scripts.make_replay import make_replay


def draw_panorama(path, *, wrap=False, seed=7):
    rng = random.Random(seed)
    width, height = (2400, 1200) if wrap else (3000, 750)
    im = Image.new('RGB', (width, height))
    d = ImageDraw.Draw(im)
    for y in range(height):
        f = y / height
        d.line((0, y, width, y), fill=(int(128+80*f), int(163+52*f), int(178+28*f)))
    horizon = int(height * .58)
    d.ellipse((width*.62, height*.15, width*.62+height*.14, height*.29), fill='#f4dbad')
    for offset in (0, width):
        d.polygon([(x+offset, horizon - math.sin(x/300)*50-30) for x in range(-width, width+30, 30)] + [(width+offset, height),(offset-width,height)], fill='#8e9a92')
    d.rectangle((0, horizon, width, height), fill='#9c9a8f')
    d.polygon([(0, height), (width*.39, horizon), (width*.61, horizon), (width, height)], fill='#b8b3a4')
    x = 0
    while x < width:
        bw = rng.randint(110, 230)
        bh = rng.randint(int(height*.17), int(height*.35))
        base = horizon + rng.randint(5, 70)
        color = rng.choice(['#926d54', '#b69a7e', '#aa9278', '#7c7970', '#c7bba2'])
        d.rectangle((x, base-bh, x+bw, base), fill=color, outline='#5a5e58', width=2)
        d.rectangle((x-4, base-bh-8, x+bw+4, base-bh), fill='#514f49')
        for yy in range(base-bh+20, base-25, 43):
            for xx in range(x+15, x+bw-15, 28):
                d.rectangle((xx, yy, xx+13, yy+23), fill='#4b5b5d')
                d.line((xx, yy+23, xx+15, yy+23), fill='#d8c2a1', width=3)
        d.rectangle((x+25, base-32, x+bw-20, base-8), fill='#e0d3b9')
        d.text((x+31, base-29), rng.choice(['BOOKS', 'MARKET', 'CAFE', 'STUDIO']), fill='#5b5550')
        x += bw + rng.randint(8, 24)
    for x in range(90, width, 420):
        d.line((x, horizon-90, x, horizon+145), fill='#3f5149', width=7)
        d.ellipse((x-20, horizon-110, x+20, horizon-80), fill='#e8c890', outline='#3f5149', width=4)
        d.ellipse((x+80,horizon-80,x+190,horizon+35), fill='#607966')
        d.line((x+133,horizon,x+133,horizon+130), fill='#6d5b46', width=10)
    for x in range(120, width, 390):
        y=horizon+180
        d.rounded_rectangle((x,y,x+95,y+36),radius=10,fill=rng.choice(['#4e656e','#9f604c','#ded8c8']))
        d.polygon([(x+15,y),(x+28,y-24),(x+67,y-24),(x+85,y)],fill='#52636a')
        d.ellipse((x+12,y+25,x+30,y+43),fill='#393b38')
        d.ellipse((x+67,y+25,x+85,y+43),fill='#393b38')
    im.save(path, quality=93)


async def main():
    if settings.provider != 'demo':
        raise SystemExit('Set PROVIDER=demo to seed synthetic engineering examples; live runs use make_replay.py.')
    fixture_dir = ROOT / 'data/fixtures'
    fixture_dir.mkdir(parents=True, exist_ok=True)
    for name, decade, wrap, seed in [('城市街景', '1920s', False, 7), ('校园街区', '1950s', False, 13), ('360 环景', '1900s', True, 21)]:
        path = fixture_dir / f'engineering-{seed}.jpg'
        draw_panorama(path, wrap=wrap, seed=seed)
        m = await make_replay(path, decade, 'Pittsburgh', baseline=True, is_360=wrap, title=f'{name} · 工程示例')
        update_manifest(m['job_id'], lambda item: item['source'].update(example=True, attribution='Procedural illustration by Century Pano; not a photograph.'))
        print(f'{name}: {m["job_id"]} {m["metrics"]}', flush=True)


if __name__ == '__main__':
    asyncio.run(main())
