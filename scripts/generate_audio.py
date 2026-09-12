"""Generate four quiet two-second original ambient cues (no external recordings)."""
import math
import random
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    destination = ROOT / 'web/audio'
    destination.mkdir(parents=True, exist_ok=True)
    rate = 22050
    for index, decade in enumerate(['1900s', '1920s', '1950s', '1970s']):
        rng = random.Random(1900+index)
        samples = []
        smooth = 0
        for i in range(rate*2):
            t = i/rate
            envelope = min(1, t/.2, (2-t)/.5)
            smooth = .94*smooth + .06*rng.uniform(-1,1)
            rumble = .075*math.sin(2*math.pi*(60+index*10)*t)
            chime = .09*math.sin(2*math.pi*(440+index*55)*t)*math.exp(-3*t)
            value = envelope * (smooth*.35+rumble+chime)
            samples.append(struct.pack('<h', int(max(-1,min(1,value))*32767)))
        with wave.open(str(destination/f'{decade}.wav'), 'wb') as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(rate)
            f.writeframes(b''.join(samples))


if __name__ == '__main__':
    main()
