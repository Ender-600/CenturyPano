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
const RECOVERABLE = new Set(['timeout', 'jump', 'background']);
const RECOVERY_MESSAGES = {
  timeout: 'Waiting for fresh GPS updates. Walking will resume automatically.',
  jump: 'GPS position changed abruptly. Holding the view until location settles.',
  background: 'Waiting for fresh GPS updates after returning to the page.',
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
 * start({ automatic: true }) resumes after a temporary tracking loss once two
 * reliable fixes establish a new origin at the held camera position.
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
  let status = { enabled: false, locked: false, phase: 'idle', needsReanchor: false, automatic: false,
    accuracyMeters: null, displacementMeters: 0, observedDisplacementMeters: 0,
    pendingMovementMeters: 0, deadbandMeters: null, message: MESSAGES.idle };
  let disposed = false, timer = null, epoch = 0, receivedAt = null, startedAt = null;
  let origin = null, previousFix = null, targetFix = null, worldOrigin = null;
  let target = null, output = null, scale = 1, alignment = new THREE.Quaternion();
  let automatic = false, recoveryFix = null, recoveryStartedAt = null;
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
    const recovering = automatic && RECOVERABLE.has(phase);
    if (!recovering) automatic = false;
    recoveryFix = null; recoveryStartedAt = now();
    publish({ enabled: false, locked: true, needsReanchor: !recovering, automatic, phase,
      message: recovering ? RECOVERY_MESSAGES[phase] : MESSAGES[phase] || MESSAGES.error });
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
    automatic = false; recoveryFix = null; recoveryStartedAt = null;
    publish({ enabled: false, locked: false, phase, needsReanchor: false, automatic: false, accuracyMeters: null,
      displacementMeters: 0, observedDisplacementMeters: 0, pendingMovementMeters: 0,
      deadbandMeters: null, message: MESSAGES[phase] || MESSAGES.idle });
  }
  function start({ worldUnitsPerMeter, anchorPosition, headingDegrees, worldYaw, automatic: auto = false } = {}) {
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
    automatic = auto === true; recoveryFix = null; recoveryStartedAt = null;
    origin = null; previousFix = null; targetFix = null; receivedAt = null; startedAt = now();
    publish({ enabled: true, locked: true, phase: 'waiting', needsReanchor: false, automatic,
      accuracyMeters: null, displacementMeters: 0, observedDisplacementMeters: 0,
      pendingMovementMeters: 0, deadbandMeters: null, message: MESSAGES.waiting });
    armTimer(startupMs); return true;
  }
  function receiveRecoveryFix(fix) {
    // Recovery deliberately discards travel while tracking was unreliable. Two
    // consistent new fixes establish a new GPS origin at the displayed camera,
    // never at a possibly distant location or an unfinished smoothing target.
    if (fix.accuracy_m > maxAccuracyMeters) { recoveryFix = null; return false; }
    if (!output || fix.timestamp_ms < recoveryStartedAt
        || recoveryFix && fix.timestamp_ms <= recoveryFix.timestamp_ms) return false;
    const accepted = { lat: fix.lat, lon: fix.lon, accuracy_m: fix.accuracy_m, timestamp_ms: fix.timestamp_ms };
    if (!recoveryFix) { recoveryFix = accepted; return false; }
    const elapsed = (accepted.timestamp_ms - recoveryFix.timestamp_ms) / 1000;
    const uncertainty = Math.max(3, Math.min(8, (recoveryFix.accuracy_m + accepted.accuracy_m) / 2));
    if (elapsed > staleMs / 1000 || locationDistance(recoveryFix, accepted) > maxSpeedMetersPerSecond * elapsed + uncertainty) {
      recoveryFix = accepted; return false;
    }
    if (elapsed < 1) return false;
    ++epoch;
    worldOrigin = output.clone(); target = output.clone();
    origin = accepted; previousFix = accepted; targetFix = accepted;
    recoveryFix = null; recoveryStartedAt = null; startedAt = now(); receivedAt = now();
    publish({ enabled: true, locked: true, phase: 'tracking', needsReanchor: false, automatic,
      accuracyMeters: accepted.accuracy_m, displacementMeters: 0, observedDisplacementMeters: 0,
      pendingMovementMeters: 0, deadbandMeters: Math.max(minDeadbandMeters, accepted.accuracy_m * 0.7),
      message: MESSAGES.tracking });
    armTimer(staleMs); return true;
  }
  function receiveFix(fix) {
    checkFreshness();
    const recovering = automatic && status.locked && !status.enabled && RECOVERABLE.has(status.phase);
    if ((!status.enabled && !recovering) || doc?.visibilityState === 'hidden') return false;
    if (!fix || !['lat', 'lon', 'accuracy_m', 'timestamp_ms'].every((key) => finite(fix[key]))
        || Math.abs(fix.lat) > 85 || Math.abs(fix.lon) > 180 || fix.accuracy_m < 0
        || now() - fix.timestamp_ms > maxFixAgeMs || fix.timestamp_ms - now() > 1000
        || !recovering && (fix.timestamp_ms < startedAt
          || previousFix && fix.timestamp_ms <= previousFix.timestamp_ms)) return false;
    if (recovering) return receiveRecoveryFix(fix);
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
    // A revoked permission also ends an automatic recovery session. Retrying
    // requires an explicit browser permission action, never a prompt loop.
    if (error?.code === 1 && automatic && status.locked && !status.enabled) {
      freeze('denied'); return;
    }
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
  const pageHide = () => { if (status.enabled || automatic && status.locked) freeze('background'); };
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
