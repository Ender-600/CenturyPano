package com.centurypano.motion;

import org.junit.Test;
import static org.junit.Assert.*;

public class BridgePolicyTest {
    @Test public void pinsSchemeHostAndPortButNotDemoToken() {
        assertEquals("https://example.com", BridgePolicy.origin("HTTPS://EXAMPLE.COM:443/world/?world=id#access=private"));
        assertTrue(BridgePolicy.allows("https://example.com", "https://example.com/world/", true));
        assertFalse(BridgePolicy.allows("https://example.com", "https://example.com:8443/world/", true));
        assertFalse(BridgePolicy.allows("https://example.com", "https://example.com.evil.invalid/", true));
        assertFalse(BridgePolicy.allows("https://example.com", "https://sub.example.com/", true));
    }
    @Test public void refusesIframeAndOpaqueInsecureCredentialOrigins() {
        assertFalse(BridgePolicy.allows("https://example.com", "https://example.com", false));
        for (String url : new String[]{"http://example.com", "file:///data/x", "javascript:alert(1)",
                "https://user:pass@example.com/", "https://example.com@evil.invalid", "https://example.com:0", "https://example.com:65536"}) {
            assertNull(url, BridgePolicy.origin(url));
        }
    }
    @Test public void enforcesBoundedAsciiSessionIds() {
        assertTrue(BridgePolicy.validSession("a1234567-1234-5678"));
        assertFalse(BridgePolicy.validSession("short"));
        assertFalse(BridgePolicy.validSession("a".repeat(129)));
        assertFalse(BridgePolicy.validSession("a1234567-1234-567\""));
        assertFalse(BridgePolicy.validSession("a1234567-1234-567中"));
    }
}
