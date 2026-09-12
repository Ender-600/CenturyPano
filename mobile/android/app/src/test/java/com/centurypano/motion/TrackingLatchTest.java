package com.centurypano.motion;

import org.junit.Test;
import static org.junit.Assert.*;

public class TrackingLatchTest {
    @Test public void initializationCanTrackButRecoveryAfterLossNeedsNewSession() {
        TrackingLatch latch = new TrackingLatch();
        assertFalse(latch.allowPose(false));
        assertTrue(latch.allowPose(true));
        assertFalse(latch.allowPose(false));
        // Even if a slow JS consumer misses 100 frames, it can receive only loss statuses.
        for (int i = 0; i < 100; i++) assertFalse(latch.allowPose(true));
        assertTrue(latch.lost());
        assertTrue(new TrackingLatch().allowPose(true));
    }
}
