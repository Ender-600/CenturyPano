package com.centurypano.motion;

/** A recovered ARCore map must never silently move a previously anchored virtual camera. */
final class TrackingLatch {
    private boolean tracked, lost;
    boolean allowPose(boolean currentlyTracking) {
        if (tracked && !currentlyTracking) lost = true;
        if (currentlyTracking) tracked = true;
        return currentlyTracking && !lost;
    }
    boolean lost() { return lost; }
}
