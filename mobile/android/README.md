# Android motion shell

This small Java/ARCore app loads the existing CenturyPano HTTPS site in a WebView. The site's Spark renderer remains responsible for displaying the world; this app supplies local camera poses through [the motion contract](../BRIDGE.md). It does not contain Google/OpenAI/World Labs keys, generate worlds, upload camera frames, or implement Unity.

Build with Android SDK 34, build-tools 34.0.0, and JDK 17 or Android Studio's bundled JBR. The wrapper pins Gradle 8.7; AGP 8.5.2, AndroidX WebKit 1.11.0 and ARCore 1.46.0 support the installed compile SDK. Initial dependency resolution requires access to Google Maven and Maven Central.

```sh
cd mobile/android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
ANDROID_HOME="/Users/maxwell/Library/Android/sdk" \
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Adjust the SDK/JDK paths for your machine. Android Studio can also open this directory directly. The debug APK is `app/build/outputs/apk/debug/app-debug.apk`; install it on an ARCore-supported Android phone with `adb install -r app/build/outputs/apk/debug/app-debug.apk`. Minimum Android API is 24. Unsupported devices can still browse the site but cannot provide physical movement.

Paste the HTTPS demo/world URL into the app, open it, then explicitly start real walking in the webpage. No demo URL or access token is bundled or saved in the native toolbar. The shell pins the selected origin. External navigation is blocked; select a new URL explicitly to change origins. WebView must support `WEB_MESSAGE_LISTENER` and `DOCUMENT_START_SCRIPT`; there is no unsafe JavaScript-interface fallback. Each document receives a nonce; both incoming controls and outgoing pose dispatches are bound to that document as well as to origin/session. An iframe cannot start the camera.

Grant camera permission and install/update Google Play Services for AR if requested. Returning from background or an installer does not restart tracking: use the webpage's start control again. A transient permission-dialog pause preserves the pending request, while an actual Activity stop or navigation cancels it; permission results are applied only to the same foreground document/session. Camera capture runs behind the opaque web renderer in a `GLSurfaceView`, with a real OES texture and `Session.update()`. No recording, cloud anchors, or geospatial API is enabled. Native GPS permission is separate and only supports the webpage's normal location selection.

Only ARCore `TRACKING` frames include pose fields. Position is the camera optical center in gravity-aligned meters; orientation uses `getDisplayOrientedPose()` after `setDisplayGeometry()`. Tracking loss sends a status without a fabricated pose. After tracking has first succeeded, any loss is latched until a fresh explicit start; ARCore recovery cannot silently resume movement or overwrite a pending loss status with a pose. Native frame dispatch is capped at 30 Hz and coalesces to one pending packet while one JavaScript evaluation is in flight. Navigation/background/stop invalidate pending permission results and GL callbacks and close the camera session.

ARCore documents the frame timestamp's clock epoch as unspecified. `FrameClock` anchors the first frame against the receipt's monotonic/wall clocks, then preserves capture-time deltas so delayed frames remain old. Absolute timestamps include the unknown first-frame delivery latency. Duplicate, reversed, or implausibly future capture timestamps are rejected.

Build/unit tests/lint do not demonstrate actual tracking accuracy. Device acceptance must cover camera denial, ARCore installation/unsupported devices, background/return, same-origin reload and foreign-origin/iframe attempts, portrait/landscape rotation, limited tracking without displacement, and slow measured forward/sideways movement after the webpage's scale/anchor calibration. Verify first that the generated world has a usable meter scale; ARCore's meter positions alone do not calibrate a Marble asset. There is no native collision detection or guarantee that generated geometry matches real obstacles.

Official API references: [ARCore Session](https://developers.google.com/ar/reference/java/com/google/ar/core/Session), [display-oriented camera pose](https://developers.google.com/ar/reference/java/com/google/ar/core/Camera), [frame timestamps](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame), [restricted WebView messaging and document scripts](https://developer.android.com/reference/androidx/webkit/WebViewCompat).
