package com.centurypano.motion;

import org.junit.Test;
import static org.junit.Assert.*;

public class FrameClockTest {
    @Test public void independentFrameEpochPreservesCaptureTimeAcrossDeliveryDelay() {
        FrameClock clock = new FrameClock();
        long wall = 1789217875000L;
        assertEquals(wall, clock.timestamp(8_000_000_000L, 700_000_000_000L, wall));
        // The next capture is 33ms later but arrives 400ms later: do not stamp it as fresh.
        assertEquals(wall + 33, clock.timestamp(8_033_000_000L, 700_400_000_000L, wall + 400));
        assertEquals(-1, clock.timestamp(8_033_000_000L, 700_500_000_000L, wall + 500));
        assertEquals(-1, clock.timestamp(8_000_000_000L, 700_500_000_000L, wall + 500));
    }
    @Test public void rejectsMissingAndImplausiblyFutureFrames() {
        FrameClock clock = new FrameClock();
        assertEquals(-1, clock.timestamp(0, 10, 1000));
        assertEquals(1000, clock.timestamp(100_000_000L, 100_000_000L, 1000));
        assertEquals(-1, clock.timestamp(2_000_000_000L, 101_000_000L, 1001));
    }
}
