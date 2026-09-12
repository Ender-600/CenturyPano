import * as THREE from 'three';
import { locationDistance } from './location.js';

const RAD = Math.PI / 180;
const EARTH_RADIUS = 6371000;
const UP = new THREE.Vector3(0, 1, 0);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const MESSAGES = {
  idle: 'GPS walking stopped.',
  waiting: 'Waiting for an accurate location. Stand still until the location is ready, then start walking.',
  tracking: 'Approximate GPS follow is on · Turn your phone to control the view independently.',
  accuracy: 'Location accuracy is low. Holding your position while waiting for a more accurate fix.',
  timeout: 'Location updates timed out. Movement paused. Stand still, then tap “Reset start”.',
  jump: 'A location jump was detected. Movement paused. Stand still, then tap “Reset start”.',
  background: 'Movement paused while the page was in the background. Tap “Reset start” when you return.',
  denied: 'Location permission is off. Allow location access in your browser, then try again.',
  error: 'Location is temporarily unavailable. Holding your position while waiting for a fresh fix.',
  scale: 'First set the number of model units per real meter.',
  anchor: 'Align your real direction with the world view, then tap “Enable GPS walking”.',
  changed: 'The world changed. GPS walking stopped. Tap “Enable GPS walking” to set a new start.',
};

/** Local meters: east=+X, north=-Z. Preserve camera height; GPS altitude is unused. */
function localDisplacement(origin, fix) {
  const longitude = ((fix.lon - origin.lon + 540) % 360 - 180) * RAD;
  return new THREE.Vector3(EARTH_RADIUS * longitude * Math.cos((origin.lat + fix.lat) * RAD / 2),
    0, -EARTH_RADIUS * (fix.lat - origin.lat) * RAD);
}

/**
 * A position-only controller. The caller owns the Geolocation watch and forwards
 * normalized fixes; no permission or sensor access happens on construction.
 *
 * At start, headingDegrees is a geographic clockwise bearing and worldYaw is
 * the corresponding Three camera rotation about +Y, in radians. This mapping
 * remains fixed for the session, so looking sideways cannot redirect a walk.
 * GPS is approximate: the accuracy-dependent deadband suppresses small movement
 * as well as stationary noise. It cannot deliver reliable indoor meter tracking.
 */
export function createGPSWalkingController({
  window: win = globalThis.window,
  document: doc = globalThis.document,
  now = Date.now,
  onChange = () => {},
  maxAccuracyMeters = 20,
  maxFixAgeMs = 5000,
  staleMs = 20000,
  startupMs = 20000,
  minDeadbandMeters = 1.5,
  maxSpeedMetersPerSecond = 4,
  smoothingSeconds = 0.35,
} = {}) {
  let status = { enabled: false, locked: false, phase: 'idle', needsReanchor: false,
    accuracyMeters: null, displacementMeters: 0, observedDisplacementMeters: 0,
    pendingMovementMeters: 0, deadbandMeters: null, message: MESSAGES.idle };
  let disposed = false, timer = null, epoch = 0, receivedAt = null, startedAt = null;
  let origin = null, previousFix = null, targetFix = null, worldOrigin = null;
  let target = null, output = null, scale = 1, alignment = new THREE.Quaternion();
  const setTimer = win?.setTimeout?.bind(win) || globalThis.setTimeout;
  const cancelTimer = win?.clearTimeout?.bind(win) || globalThis.clearTimeout;
  const publish = (patch) => {
    const next = { ...status, ...patch };
    if (Object.keys(next).every((key) => next[key] === status[key])) return;
    status = next; onChange({ ...status });
  };
  const clearTimer = () => { if (timer !== null) cancelTimer(timer); timer = null; };
  function freeze(phase) {
    clearTimer(); ++epoch;
    // Discard any unfinished smoothing: loss must freeze the displayed position.
    if (output) target = output.clone();
    publish({ enabled: false, locked: true, needsReanchor: true, phase,
      message: MESSAGES[phase] || MESSAGES.error });
  }
  const armTimer = (delay) => {
    clearTimer(); const session = epoch;
    timer = setTimer(() => {
      if (session !== epoch || !status.enabled) return;
      timer = null; freeze('timeout');
    }, delay);
  };
  const checkFreshness = () => {
    if (status.enabled && (receivedAt === null ? now() - startedAt > startupMs : now() - receivedAt > staleMs)) freeze('timeout');
  };
  function stop(phase = 'idle') {
    clearTimer(); ++epoch;
    origin = null; previousFix = null; targetFix = null; worldOrigin = null; target = null; output = null;
    receivedAt = null; startedAt = null;
    publish({ enabled: false, locked: false, phase, needsReanchor: false, accuracyMeters: null,
      displacementMeters: 0, observedDisplacementMeters: 0, pendingMovementMeters: 0,
      deadbandMeters: null, message: MESSAGES[phase] || MESSAGES.idle });
  }
  function start({ worldUnitsPerMeter, anchorPosition, headingDegrees, worldYaw } = {}) {
    if (disposed || doc?.visibilityState === 'hidden') return false;
    if (!finite(worldUnitsPerMeter) || worldUnitsPerMeter <= 0 || worldUnitsPerMeter > 10000) {
      stop('scale'); return false;
    }
    if (!anchorPosition || !['x', 'y', 'z'].every((key) => finite(anchorPosition[key]))
        || !finite(headingDegrees) || !finite(worldYaw)) { stop('anchor'); return false; }
    clearTimer(); ++epoch;
    scale = worldUnitsPerMeter;
    worldOrigin = new THREE.Vector3(anchorPosition.x, anchorPosition.y, anchorPosition.z);
    target = worldOrigin.clone(); output = worldOrigin.clone();
    alignment = new THREE.Quaternion().setFromAxisAngle(UP, headingDegrees * RAD + worldYaw);
    origin = null; previousFix = null; targetFix = null; receivedAt = null; startedAt = now();
    publish({ enabled: true, locked: true, phase: 'waiting', needsReanchor: false,
      accuracyMeters: null, displacementMeters: 0, observedDisplacementMeters: 0,
      pendingMovementMeters: 0, deadbandMeters: null, message: MESSAGES.waiting });
    armTimer(startupMs); return true;
  }
  function receiveFix(fix) {
    checkFreshness();
    if (!status.enabled || doc?.visibilityState === 'hidden') return false;
    if (!fix || !['lat', 'lon', 'accuracy_m', 'timestamp_ms'].every((key) => finite(fix[key]))
        || Math.abs(fix.lat) > 85 || Math.abs(fix.lon) > 180 || fix.accuracy_m < 0
        || now() - fix.timestamp_ms > maxFixAgeMs || fix.timestamp_ms - now() > 1000
        || fix.timestamp_ms < startedAt
        || previousFix && fix.timestamp_ms <= previousFix.timestamp_ms) return false;
    if (fix.accuracy_m > maxAccuracyMeters) {
      // A single noisy update is not tracking loss. Hold the displayed position,
      // but do not extend the deadline measured from the last reliable fix.
      publish({ phase: 'accuracy', accuracyMeters: fix.accuracy_m,
        message: origin ? MESSAGES.accuracy
          : 'Location accuracy is low. Waiting for a more accurate fix. Move to an open outdoor area.' });
      return false;
    }
    if (previousFix) {
      const elapsed = (fix.timestamp_ms - previousFix.timestamp_ms) / 1000;
      const uncertainty = Math.max(3, Math.min(8, (previousFix.accuracy_m + fix.accuracy_m) / 2));
      if (locationDistance(previousFix, fix) > maxSpeedMetersPerSecond * elapsed + uncertainty) {
        freeze('jump'); return false;
      }
    }
    const accepted = { lat: fix.lat, lon: fix.lon, accuracy_m: fix.accuracy_m, timestamp_ms: fix.timestamp_ms };
    if (!origin) { origin = accepted; targetFix = accepted; }
    const meters = localDisplacement(origin, accepted);
    // Compare with the last target, rather than each noisy consecutive fix, so
    // a series of sub-threshold steps can eventually accumulate into movement.
    const deadband = Math.max(minDeadbandMeters, (targetFix.accuracy_m + accepted.accuracy_m) * 0.35);
    let pendingMovement = locationDistance(targetFix, accepted);
    if (pendingMovement > deadband) {
      target.copy(meters).applyQuaternion(alignment).multiplyScalar(scale).add(worldOrigin);
      targetFix = accepted;
      pendingMovement = 0;
    }
    previousFix = accepted; receivedAt = now(); armTimer(staleMs);
    publish({ enabled: true, locked: true, phase: 'tracking', needsReanchor: false,
      accuracyMeters: accepted.accuracy_m, displacementMeters: target.distanceTo(worldOrigin) / scale,
      observedDisplacementMeters: meters.length(), pendingMovementMeters: pendingMovement,
      deadbandMeters: deadband,
      message: MESSAGES.tracking });
    return true;
  }
  function getPosition(deltaSeconds = 0) {
    checkFreshness();
    if (!status.locked || !output) return null;
    if (status.enabled && status.phase === 'tracking' && origin && finite(deltaSeconds) && deltaSeconds > 0) {
      const alpha = smoothingSeconds > 0 ? -Math.expm1(-Math.min(deltaSeconds, 0.25) / smoothingSeconds) : 1;
      output.lerp(target, alpha);
    }
    return output.clone();
  }
  function fail(error) {
    checkFreshness();
    if (!status.enabled) return;
    if (error?.code === 1) {
      if (!origin) stop('denied');
      else freeze('denied');
    } else {
      // Browser watches can report temporary failures and still deliver the next
      // fix. Preserve the anchor within the same bounded freshness window.
      publish({ phase: 'error', message: MESSAGES.error });
    }
  }
  const pageHide = () => { if (status.enabled) freeze('background'); };
  const visibility = () => { if (doc?.visibilityState === 'hidden') pageHide(); };
  win?.addEventListener?.('pagehide', pageHide);
  doc?.addEventListener?.('visibilitychange', visibility);
  return { start, reanchor: start, receiveFix, getPosition, stop, fail,
    getStatus() { checkFreshness(); return { ...status }; },
    dispose() {
      stop(); disposed = true;
      win?.removeEventListener?.('pagehide', pageHide);
      doc?.removeEventListener?.('visibilitychange', visibility);
    } };
}
