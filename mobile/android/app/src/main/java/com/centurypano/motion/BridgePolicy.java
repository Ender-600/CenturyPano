package com.centurypano.motion;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

/** One explicitly selected HTTPS origin; no wildcard, credentials, or opaque URL. */
final class BridgePolicy {
    private static final Pattern SESSION = Pattern.compile("[A-Za-z0-9-]{16,128}");
    static String origin(String value) {
        if (value == null || value.length() > 8192) return null;
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            int port = uri.getPort();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null
                    || uri.getRawUserInfo() != null || port == 0 || port > 65535) return null;
            return "https://" + host.toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
        } catch (URISyntaxException ignored) { return null; }
    }
    static boolean allows(String pinned, String url, boolean mainFrame) {
        return mainFrame && pinned != null && pinned.equals(origin(url));
    }
    static boolean validSession(String id) { return id != null && SESSION.matcher(id).matches(); }
}
