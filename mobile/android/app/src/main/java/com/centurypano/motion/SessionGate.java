package com.centurypano.motion;

/** Prevents an old permission result, GL frame, or JS callback crossing a session/navigation. */
final class SessionGate {
    record Ticket(long epoch, String sessionId, long sequence) {}
    private long epoch, sequence;
    private String sessionId;
    synchronized long begin(String id) {
        if (!BridgePolicy.validSession(id)) throw new IllegalArgumentException("Invalid session ID");
        epoch++; if (!id.equals(sessionId)) sequence = 0; sessionId = id; return epoch;
    }
    synchronized long invalidate() { return ++epoch; }
    synchronized long epoch() { return epoch; }
    synchronized String sessionId() { return sessionId; }
    synchronized Ticket next(long expected) {
        return expected == epoch && sessionId != null ? new Ticket(epoch, sessionId, ++sequence) : null;
    }
    synchronized boolean current(long expected) { return expected == epoch; }
}
