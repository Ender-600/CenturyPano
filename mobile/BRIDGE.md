# CenturyPano motion bridge v1

The native shell loads a user-entered HTTPS CenturyPano URL. No API keys or demo access codes are bundled. The shell pins the chosen origin, blocks other origins inside the WebView, and only enables the motion bridge for that origin's main frame. The native camera is used locally for tracking; camera frames are not uploaded by the bridge.

At document start expose `window.CenturyMotion = { version: 1, platform: 'ios'|'android', postMessage(jsonString) }`. The main-frame web page sends JSON `{version:1, action:'start'|'stop', sessionId:string}`. Session IDs are 16–128 ASCII alphanumeric/hyphen characters. `start` asks for camera permission if necessary and starts a new gravity-aligned world-tracking session. `stop` pauses tracking. Backgrounding or navigation stops tracking; returning does not restart the camera automatically.

Native publishes `window.dispatchEvent(new CustomEvent('century:motion', {detail: packet}))`, with JSON safely serialized rather than interpolating user strings into JavaScript source. Packets:

```
{
  "version": 1,
  "sessionId": "web-generated-session-id",
  "sequence": 1,
  "timestampMs": 1789217875000,
  "state": "tracking",
  "position": [0, 0, 0],
  "quaternion": [0, 0, 0, 1],
  "messageCode": "tracking"
}
```

Coordinates are **meters**, right-handed, gravity-aligned +Y up. The quaternion is `[x,y,z,w]`, transforming the **display-oriented rear camera** to that coordinate system: camera looks along -Z with display-up along +Y. iOS derives it by inverting `ARCamera.viewMatrix(for: currentInterfaceOrientation)`; Android uses ARCore `Camera.getDisplayOrientedPose()` after `Session.setDisplayGeometry`. Position is the camera optical center, not accumulated walking distance. Rotation never changes translation. Pose packets are sent at up to 30 Hz; do not queue unbounded JavaScript evaluations.

`timestampMs` is the capture time expressed as Unix milliseconds, derived from the platform frame timestamp and current monotonic/wall clocks. `sequence` strictly increases within a session, including status messages. Other states are `limited`, `paused`, `unsupported`, `denied`, `error`; omit pose fields when tracking is not reliable. `messageCode` is a fixed non-sensitive reason such as `initializing`, `relocalizing`, `insufficient_features`, `excessive_motion`, `camera_permission`, `background`, `camera_unavailable`, or `session_failed`.

Web validates session, sequence, freshness, finite meter positions, and a normalized quaternion before applying a pose. It freezes on tracking loss and requires explicit re-anchoring before resuming after loss/relocalization. The first valid pose is anchored to the current virtual viewpoint, with yaw-only alignment to preserve gravity. A known model scale or explicitly entered calibration is required for meaningful distance mapping; missing metric metadata must not be represented as verified 1:1 scale. Sensor coordinates and page/demo tokens are never logged or sent to generation services.
