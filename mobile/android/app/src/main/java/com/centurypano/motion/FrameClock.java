package com.centurypano.motion;

/** ARCore's timestamp epoch is unspecified: anchor first capture to monotonic/wall receipt.
 * Subsequent times preserve capture deltas, so a delayed frame does not become fresh.
 * Absolute capture time includes the unknown first-frame camera delivery latency. */
final class FrameClock {
    private long firstFrame, firstMono, wallOrigin, lastFrame;
    long timestamp(long frameNs, long monoNs, long wallMs) {
        if (frameNs <= 0 || frameNs <= lastFrame) return -1;
        if (firstFrame == 0) { firstFrame = frameNs; firstMono = monoNs; wallOrigin = wallMs; }
        long delta = frameNs - firstFrame;
        if (delta > monoNs - firstMono + 100_000_000L) return -1;
        lastFrame = frameNs;
        return wallOrigin + delta / 1_000_000L;
    }
}
