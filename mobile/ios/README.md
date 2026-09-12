# CenturyPano iOS motion shell

Native UIKit / WKWebView / ARKit client for the [motion bridge](../BRIDGE.md). The existing hosted CenturyPano webpage renders its world with Spark; this app supplies display-oriented camera position and rotation in meters. Requires iOS 16 or later and an ARKit-capable iPhone or iPad for world tracking. The simulator can load the webpage but cannot verify physical tracking.

Open `CenturyPano.xcodeproj` in Xcode, select the `CenturyPano` scheme and your signing team, then run on a connected device with Developer Mode enabled. Paste your HTTPS demonstration URL, including its access fragment if needed. No URL, API key, access code, signing identity, or team is bundled; links are held only in memory and the WebView uses a nonpersistent data store.

The webpage's location action uses `navigator.geolocation` through WebKit and iOS permission prompts. The native app includes a When In Use location usage description. ARKit asks for camera permission only when the webpage explicitly starts physical movement. The native camera frames remain in ARKit; this bridge sends only position, quaternion, and tracking status. The webpage's server-side generation pipeline may use the GPS coordinates according to its own UI, independently of the native pose bridge.

Only the chosen HTTPS origin can load inside this WebView; the bridge is injected into its main frame only. Other origins, popup windows, and webpage camera/microphone capture are blocked. Navigation, leaving the screen, backgrounding, or an AR interruption pauses the camera and requires the user to start again. A limited AR tracking state sends no pose. Returning from the camera permission dialog can finish the explicit pending start; returning from the background does not restart tracking.

The world frame uses gravity alignment. Each pose comes from `inverse(camera.viewMatrix(for: interfaceOrientation))`; it is not a rotated accumulated displacement. Publishing is capped at 30 Hz with at most one JavaScript evaluation in flight, one pending status, and one latest pose. A status transition is delivered before a later valid pose so the webpage can freeze and require re-anchoring after tracking loss.

## Build without signing

```sh
xcodebuild -project mobile/ios/CenturyPano.xcodeproj -scheme CenturyPano -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath /private/tmp/centurypano-ios-simulator CODE_SIGNING_ALLOWED=NO build
xcodebuild -project mobile/ios/CenturyPano.xcodeproj -scheme CenturyPano -configuration Debug -destination 'generic/platform=iOS' -derivedDataPath /private/tmp/centurypano-ios-device CODE_SIGNING_ALLOWED=NO build
```

Unsigned builds verify compilation, not installation, GPS authorization, actual AR tracking, metric scene scale, or historical alignment. A real phone test must check camera denial, landscape/portrait rotation, walking forward/back, tracking loss and re-anchoring, and background/navigation stopping the camera. Model scale still requires reliable metadata or explicit calibration in the webpage; this shell does not establish geographic registration or historical accuracy.

## Validation on 2026-09-12

Xcode 26.3 successfully built the generic iOS Simulator and generic iOS device targets with code signing disabled. The simulator app was installed and launched on an iPhone 17 Pro Max running iOS 26.2, and its URL-entry screen was visually checked. This does not verify the WebView permission flow or physical AR tracking.

One automatic device-signing attempt found no valid Xcode account for the selected local development team and no development provisioning profile for `com.centurypano.motion`. The existing local signing certificate alone is insufficient for installation. Log in to the corresponding team in Xcode Settings → Accounts and connect/unlock the phone before building for that device. No team identifier or certificate is stored in this project.
