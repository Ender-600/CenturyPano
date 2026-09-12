package com.centurypano.motion;

import org.junit.Test;
import static org.junit.Assert.*;

public class SessionGateTest {
    @Test public void navigationRejectsOldPermissionAndGlCallbacks() {
        SessionGate gate = new SessionGate();
        long old = gate.begin("session-one-12345");
        assertEquals(1, gate.next(old).sequence());
        long paused = gate.invalidate();
        assertNull(gate.next(old));
        assertFalse(gate.current(old));
        assertEquals(2, gate.next(paused).sequence());
        long fresh = gate.begin("session-two-12345");
        assertNull(gate.next(paused));
        assertEquals("session-two-12345", gate.next(fresh).sessionId());
    }
    @Test public void duplicateStartDoesNotReverseSequenceWithinSession() {
        SessionGate gate = new SessionGate();
        long epoch = gate.begin("same-session-12345");
        gate.next(epoch); gate.next(epoch);
        long replacement = gate.begin("same-session-12345");
        assertEquals(3, gate.next(replacement).sequence());
        assertNull(gate.next(epoch));
    }
}
