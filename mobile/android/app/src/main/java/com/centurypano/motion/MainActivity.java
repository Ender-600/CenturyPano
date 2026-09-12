package com.centurypano.motion;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.opengl.GLSurfaceView;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.google.ar.core.ArCoreApk;
import com.google.ar.core.Session;
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** A user-selected CenturyPano site + local ARCore tracking. Contains no service credentials. */
public final class MainActivity extends Activity implements TrackingRenderer.Sink {
    private static final int CAMERA_PERMISSION = 40, LOCATION_PERMISSION = 41;
    private static final String NATIVE_OBJECT = "__CenturyNativeMotion";
    private static final String FACADE = "(()=>{if(window!==window.top)return;"
            + "const d=Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');"
            + "Object.defineProperty(window,'__CenturyMotionDocument',{value:d,configurable:false,writable:false});"
            + "Object.defineProperty(window,'CenturyMotion',{value:Object.freeze({version:1,platform:'android',"
            + "postMessage:(s)=>{if(typeof s==='string'&&s.length<=2048)window.__CenturyNativeMotion.postMessage(JSON.stringify({documentId:d,payload:s}));}}),"
            + "configurable:false,writable:false});})();";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SessionGate gate = new SessionGate();
    private record Envelope(long epoch, long sequence, String json) {}
    private final AtomicReference<Envelope> latest = new AtomicReference<>();
    private final AtomicBoolean evaluating = new AtomicBoolean();
    private WebView web;
    private GLSurfaceView surface;
    private TrackingRenderer tracker;
    private ScriptHandler script;
    private TextView status;
    private EditText address;
    private String pinnedOrigin;
    private String documentId;
    private boolean foreground, trustedDocument, destroyed, installRequested;
    private long cameraPermissionEpoch = -1;
    private Boolean cameraPermissionResult, locationPermissionResult;
    private boolean locationPermissionRequested;
    private GeolocationPermissions.Callback locationCallback;
    private String locationOrigin;
    private String locationDocumentId;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // URL fragments may contain a demo access token; do not save view state or log URLs.
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(246, 247, 243));
        LinearLayout bar = new LinearLayout(this); bar.setPadding(12, 4, 12, 4);
        address = new EditText(this); address.setSingleLine(true); address.setSaveEnabled(false);
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("Paste an HTTPS demo link");
        if (Build.VERSION.SDK_INT >= 26) address.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        bar.addView(address, new LinearLayout.LayoutParams(0, -2, 1));
        Button open = new Button(this); open.setText("Open"); open.setOnClickListener(v -> openSite());
        bar.addView(open); root.addView(bar);
        status = new TextView(this); status.setPadding(16, 0, 16, 8);
        status.setText("After loading a world, tap Enable walking in the webpage. The camera tracks position only on this device."); root.addView(status);
        FrameLayout content = new FrameLayout(this);
        surface = new GLSurfaceView(this); surface.setEGLContextClientVersion(2);
        surface.setPreserveEGLContextOnPause(true);
        tracker = new TrackingRenderer(this, this); surface.setRenderer(tracker);
        surface.setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);
        content.addView(surface, new FrameLayout.LayoutParams(-1, -1));
        web = new WebView(this); web.setSaveEnabled(false); web.setBackgroundColor(Color.WHITE);
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        configureWebView();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(true); settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (BridgePolicy.allows(pinnedOrigin, request.getUrl().toString(), true)) return false;
                if (request.isForMainFrame()) stopTracking("paused", "navigation");
                status.setText("Navigation away from the selected website was blocked. Paste a new HTTPS link to change websites."); return true;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap icon) {
                stopTracking("paused", "navigation"); trustedDocument = false; documentId = null; cancelLocation();
                if (!BridgePolicy.allows(pinnedOrigin, url, true)) { view.stopLoading(); status.setText("Only the selected HTTPS origin is allowed."); }
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                bindDocument(url);
            }
            @Override public void onPageFinished(WebView view, String url) {
                bindDocument(url);
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); trustedDocument = false; stopTracking("error", "insecure_connection");
                status.setText("Certificate verification failed. The connection was stopped.");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (!foreground || !trustedDocument || !BridgePolicy.allows(pinnedOrigin, origin, true)) {
                    callback.invoke(origin, false, false); return;
                }
                cancelLocation(); locationCallback = callback; locationOrigin = origin; locationDocumentId = documentId;
                new AlertDialog.Builder(MainActivity.this).setTitle("Allow this website to access your current location?")
                        .setMessage("The webpage uses your location to select a neighborhood. Real walking uses the on-device camera to track your position.")
                        .setPositiveButton("Allow", (dialog, which) -> {
                            if (locationCallback == null) return;
                            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                                    || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) finishLocation(true);
                            else {
                                locationPermissionRequested = true;
                                requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                                        Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
                            }
                        }).setNegativeButton("Deny", (dialog, which) -> cancelLocation())
                        .setOnCancelListener(dialog -> cancelLocation()).show();
            }
            @Override public void onGeolocationPermissionsHidePrompt() { cancelLocation(); }
        });
    }

    private void bindDocument(String url) {
        if (!BridgePolicy.allows(pinnedOrigin, url, true) || !BridgePolicy.allows(pinnedOrigin, web.getUrl(), true)) return;
        long epoch = gate.epoch();
        // Bind the currently committed document, not just the origin of a late queued message.
        web.evaluateJavascript("window.__CenturyMotionDocument||null", result -> {
            if (destroyed || !gate.current(epoch) || result == null || result.length() > 80
                    || !BridgePolicy.allows(pinnedOrigin, web.getUrl(), true)) return;
            try {
                Object value = new JSONTokener(result).nextValue();
                if (value instanceof String && ((String) value).matches("[a-f0-9]{32}")) {
                    documentId = (String) value; trustedDocument = true;
                    status.setText("Connected to the selected website · Tap Enable walking in the webpage");
                }
            } catch (JSONException ignored) { /* Unsupported or replaced document: leave bridge disabled. */ }
        });
    }

    private void openSite() {
        String url = address.getText().toString().trim();
        String origin = BridgePolicy.origin(url);
        if (origin == null) { status.setText("Enter a valid HTTPS link. URLs containing a username or password are not supported."); return; }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            status.setText("Please update Android System WebView or Chrome. The current version does not support the secure location bridge."); return;
        }
        stopTracking("paused", "navigation"); trustedDocument = false; documentId = null; cancelLocation();
        if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) script.remove();
        if (pinnedOrigin != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
            WebViewCompat.removeWebMessageListener(web, NATIVE_OBJECT);
        pinnedOrigin = origin;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
            WebViewCompat.addWebMessageListener(web, NATIVE_OBJECT, Collections.singleton(origin),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!trustedDocument || !isMainFrame
                            || !BridgePolicy.allows(pinnedOrigin, sourceOrigin.toString(), true)
                            || !BridgePolicy.allows(pinnedOrigin, view.getUrl(), true)
                            || message.getType() != WebMessageCompat.TYPE_STRING) return;
                    String data = message.getData();
                    if (data == null || data.length() > 4096) return;
                    try {
                        JSONObject envelope = new JSONObject(data);
                        if (documentId != null && documentId.equals(envelope.optString("documentId")))
                            handleMessage(envelope.optString("payload", ""));
                    } catch (JSONException ignored) { /* No raw input is logged or returned. */ }
                });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT))
            script = WebViewCompat.addDocumentStartJavaScript(web, FACADE, Collections.singleton(origin));
        address.setText(origin); // Avoid retaining a pasted demo token in the visible toolbar.
        ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(address.getWindowToken(), 0);
        web.requestFocus(); status.setText("Loading the selected website…"); web.loadUrl(url);
    }

    private void handleMessage(String json) {
        if (json == null || json.length() > 2048) return;
        try {
            JSONObject request = new JSONObject(json);
            Object version = request.opt("version");
            String id = request.optString("sessionId", ""), action = request.optString("action", "");
            if (!(version instanceof Integer) || ((Integer) version) != 1 || !BridgePolicy.validSession(id)) return;
            if (action.equals("stop")) {
                if (id.equals(gate.sessionId())) stopTracking("paused", "stopped");
            } else if (action.equals("start")) {
                if (!foreground) return;
                stopTracking("paused", "initializing");
                installRequested = false; // This is a fresh explicit user request, including after declining installation.
                long epoch = gate.begin(id);
                packet(epoch, "limited", "initializing", null, null, System.currentTimeMillis());
                prepareTracking(epoch, 0);
            }
        } catch (JSONException ignored) { /* Never echo input, tokens, or provider data. */ }
    }

    private boolean canStart(long epoch) {
        return foreground && !destroyed && trustedDocument && gate.current(epoch)
                && BridgePolicy.allows(pinnedOrigin, web.getUrl(), true);
    }

    private void prepareTracking(long epoch, int attempt) {
        if (!canStart(epoch)) return;
        ArCoreApk.Availability availability = ArCoreApk.getInstance().checkAvailability(this);
        if (availability.isTransient() && attempt < 10) {
            main.postDelayed(() -> prepareTracking(epoch, attempt + 1), 250); return;
        }
        if (!availability.isSupported()) {
            boolean unsupported = availability == ArCoreApk.Availability.UNSUPPORTED_DEVICE_NOT_CAPABLE;
            packet(epoch, unsupported ? "unsupported" : "error", "arcore_unavailable", null, null, System.currentTimeMillis());
            status.setText(unsupported ? "This device does not support ARCore tracking. You can still drag to explore the webpage."
                    : "ARCore availability is not confirmed. Check your connection and Google Play services, then try again."); return;
        }
        try {
            if (ArCoreApk.getInstance().requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true;
                packet(epoch, "paused", "arcore_install_required", null, null, System.currentTimeMillis());
                status.setText("Install or update Google Play Services for AR, then return and tap Enable walking again."); return;
            }
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                cameraPermissionEpoch = epoch;
                requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION); return;
            }
            tracker.start(new Session(this), epoch);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            status.setText("Camera tracking runs on this device · No camera images uploaded · Watch for real obstacles");
        } catch (UnavailableUserDeclinedInstallationException ignored) {
            packet(epoch, "denied", "arcore_install_declined", null, null, System.currentTimeMillis());
            status.setText("ARCore installation is incomplete. Try turning on tracking again later.");
        } catch (Exception ignored) {
            packet(epoch, "error", "session_failed", null, null, System.currentTimeMillis());
            status.setText("The tracking session did not start. Check the camera and ARCore services.");
        }
    }

    private void stopTracking(String state, String code) {
        long epoch = gate.invalidate(); cameraPermissionEpoch = -1; cameraPermissionResult = null; latest.set(null);
        if (tracker != null) tracker.stop();
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        packet(epoch, state, code, null, null, System.currentTimeMillis());
    }

    @Override public void packet(long epoch, String state, String code, float[] position, float[] quaternion, long timestamp) {
        SessionGate.Ticket ticket = gate.next(epoch);
        if (ticket == null) return;
        try {
            JSONObject packet = new JSONObject().put("version", 1).put("sessionId", ticket.sessionId())
                    .put("sequence", ticket.sequence()).put("timestampMs", timestamp).put("state", state).put("messageCode", code);
            if (state.equals("tracking") && position != null && quaternion != null) {
                JSONArray p = new JSONArray(), q = new JSONArray();
                for (float value : position) p.put((double) value);
                for (float value : quaternion) q.put((double) value);
                packet.put("position", p).put("quaternion", q);
            }
            Envelope next = new Envelope(epoch, ticket.sequence(), packet.toString());
            // Replacing one pending packet provides backpressure when JS is busy.
            latest.accumulateAndGet(next, (old, replacement) -> old == null || replacement.epoch() > old.epoch()
                    || replacement.epoch() == old.epoch() && replacement.sequence() > old.sequence() ? replacement : old);
            scheduleDelivery();
        } catch (JSONException ignored) { /* Reject non-finite native values. */ }
    }

    private void scheduleDelivery() {
        if (evaluating.compareAndSet(false, true)) main.post(this::deliver);
    }
    private void deliver() {
        Envelope envelope = latest.getAndSet(null);
        if (envelope == null || destroyed || !foreground || !trustedDocument || !gate.current(envelope.epoch())
                || !BridgePolicy.allows(pinnedOrigin, web.getUrl(), true)) {
            evaluating.set(false); if (latest.get() != null) scheduleDelivery(); return;
        }
        // JSONObject.quote escapes all data; page/demo strings never form JavaScript source.
        String js = "(()=>{if(window===window.top&&location.origin===" + JSONObject.quote(pinnedOrigin)
                + "&&window.__CenturyMotionDocument===" + JSONObject.quote(documentId)
                + ")window.dispatchEvent(new CustomEvent('century:motion',{detail:JSON.parse("
                + JSONObject.quote(envelope.json()) + ")}));})();";
        web.evaluateJavascript(js, ignored -> {
            evaluating.set(false); if (latest.get() != null) scheduleDelivery();
        });
    }

    @Override public void failure(long epoch) {
        main.post(() -> {
            if (!gate.current(epoch)) return;
            stopTracking("error", "camera_unavailable");
            status.setText("Camera tracking stopped. Turn it on again in the webpage.");
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == CAMERA_PERMISSION) {
            cameraPermissionResult = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            if (foreground) finishCameraPermission();
        } else if (requestCode == LOCATION_PERMISSION) {
            boolean allowed = false;
            for (int result : results) allowed |= result == PackageManager.PERMISSION_GRANTED;
            locationPermissionResult = allowed;
            if (foreground) finishLocation(allowed);
        }
    }
    private void finishCameraPermission() {
        if (cameraPermissionResult == null) return;
        long epoch = cameraPermissionEpoch;
        boolean granted = cameraPermissionResult;
        cameraPermissionEpoch = -1; cameraPermissionResult = null;
        if (!canStart(epoch)) return;
        if (granted) prepareTracking(epoch, 0);
        else {
            packet(epoch, "denied", "camera_permission", null, null, System.currentTimeMillis());
            status.setText("Camera permission was not granted. Allow it in system settings, then try again.");
        }
    }
    private void finishLocation(boolean allow) {
        if (locationCallback != null) locationCallback.invoke(locationOrigin,
                allow && foreground && trustedDocument && documentId != null && documentId.equals(locationDocumentId)
                        && BridgePolicy.allows(pinnedOrigin, locationOrigin, true), false);
        locationCallback = null; locationOrigin = null; locationDocumentId = null;
        locationPermissionRequested = false; locationPermissionResult = null;
    }
    private void cancelLocation() { finishLocation(false); }

    @Override protected void onResume() {
        super.onResume(); foreground = true;
        if (surface != null) surface.onResume();
        if (web != null) web.onResume();
        boolean awaitingCamera = cameraPermissionEpoch >= 0;
        if (cameraPermissionResult != null) finishCameraPermission();
        if (locationPermissionResult != null) finishLocation(locationPermissionResult);
        if (!awaitingCamera && gate.sessionId() != null) {
            packet(gate.epoch(), "paused", "background", null, null, System.currentTimeMillis());
            status.setText("Tracking paused. Tap Enable walking again in the webpage.");
        }
        // Never resume the camera automatically after backgrounding or installation.
    }
    @Override protected void onPause() {
        // A runtime permission dialog can pause the Activity without backgrounding it.
        // Preserve only that outstanding request; onStop/navigation cancels it definitively.
        boolean permissionPending = cameraPermissionEpoch >= 0 || locationPermissionRequested;
        if (permissionPending) {
            tracker.stop(); latest.set(null);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else { stopTracking("paused", "background"); cancelLocation(); }
        foreground = false;
        if (surface != null) surface.onPause();
        if (web != null) web.onPause();
        super.onPause();
    }
    @Override protected void onStop() {
        stopTracking("paused", "background"); cancelLocation(); super.onStop();
    }
    @Override protected void onDestroy() {
        stopTracking("paused", "background"); destroyed = true; main.removeCallbacksAndMessages(null);
        if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) script.remove();
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
    @Override public void onBackPressed() {
        stopTracking("paused", "navigation");
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
