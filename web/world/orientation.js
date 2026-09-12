import * as THREE from 'three';

const RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const SCREEN_Z = new THREE.Vector3(0, 0, 1);
const ENU_TO_WORLD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
export const wrapDegrees = (value) => (value % 360 + 360) % 360;

/** Clockwise bearing of the rear-camera optical axis; null when pointing vertically. */
export function headingFromQuaternion(quaternion) {
  if (!quaternion || !['x', 'y', 'z', 'w'].every((axis) => finite(quaternion[axis]))) return null;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
  if (Math.hypot(forward.x, forward.z) < 0.08) return null;
  return wrapDegrees(Math.atan2(forward.x, -forward.z) / RAD);
}

/**
 * W3C device coordinates are fixed to the phone's natural portrait orientation.
 * Rz(alpha) Rx(beta) Ry(gamma) gives the complete attitude, including pitch/roll.
 * Convert ENU (East, North, Up) to Three (East, Up, South), then compensate the
 * screen's rotation around the optical axis. North-facing upright portrait is
 * identity. The optical direction is unchanged by screen rotation.
 * https://www.w3.org/TR/orientation-event/#a-1-calculating-compass-heading
 */
export function cameraQuaternionFromAngles(alpha, beta, gamma, screenAngle = 0) {
  if (![alpha, beta, gamma, screenAngle].every(finite)) return null;
  const attitude = new THREE.Quaternion().setFromEuler(new THREE.Euler(beta * RAD, gamma * RAD, alpha * RAD, 'ZXY'));
  return ENU_TO_WORLD.clone().multiply(attitude)
    .multiply(new THREE.Quaternion().setFromAxisAngle(SCREEN_Z, -screenAngle * RAD)).normalize();
}

/**
 * Keep the fused attitude intact: replacing alpha with a compass bearing breaks
 * the coupled Euler angles near upright and can flip the view when pitching.
 * A compass is only a candidate for a one-time north alignment, never look data.
 */
export function orientationSample(event, screenAngle = 0, maxCompassAccuracy = 35) {
  if (!event) return null;
  const quaternion = cameraQuaternionFromAngles(event.alpha, event.beta, event.gamma, screenAngle);
  if (!quaternion) return null;
  const source = event.absolute === true || event.type === 'deviceorientationabsolute' ? 'absolute' : 'relative';
  let northQuaternion = source === 'absolute' ? quaternion.clone() : null;
  let accuracy = null;
  const compass = finite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0 && event.webkitCompassHeading <= 360;
  const measuredAccuracy = finite(event.webkitCompassAccuracy) ? event.webkitCompassAccuracy : null;
  const compassAccurate = compass && measuredAccuracy !== null && measuredAccuracy >= 0 && measuredAccuracy <= maxCompassAccuracy;
  // Safari's heading is for the top of the phone. Seed it with the screen facing
  // up, within 35 degrees of horizontal; its top-axis projection is singular
  // upright. The full attitude then carries that north reference as it is raised.
  const level = Math.cos(event.beta * RAD) * Math.cos(event.gamma * RAD) >= Math.cos(35 * RAD);
  if (source === 'relative' && compassAccurate && level) {
    northQuaternion = cameraQuaternionFromAngles(360 - event.webkitCompassHeading, event.beta, event.gamma, screenAngle);
    accuracy = measuredAccuracy;
  }
  return { quaternion, source, northQuaternion, reference: northQuaternion ? 'magnetic-north' : 'relative',
    absolute: !!northQuaternion, accuracy, heading: northQuaternion ? headingFromQuaternion(northQuaternion) : null,
    compassNeedsLevel: source === 'relative' && compassAccurate && !level,
    compassUnreliable: source === 'relative' && compass && !compassAccurate };
}

/** Return a world-up rotation aligning two horizontal optical bearings. */
export function yawAlignment(source, target) {
  const from = headingFromQuaternion(source), to = headingFromQuaternion(target);
  if (from === null || to === null) return null;
  return new THREE.Quaternion().setFromAxisAngle(UP, (from - to) * RAD);
}

function topHeading(quaternion) {
  const top = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  return Math.hypot(top.x, top.z) < 0.08 ? null : wrapDegrees(Math.atan2(top.x, -top.z) / RAD);
}

// A level phone points its optical axis down. Its top edge still defines yaw.
// Compare the same axes when transferring sensor frames; for the initial view,
// align that edge with the viewer's optical bearing so raising it faces forward.
function attitudeYawAlignment(source, target, initialView = false) {
  const optical = yawAlignment(source, target);
  if (optical) return optical;
  const from = topHeading(source) ?? headingFromQuaternion(source);
  const to = initialView ? headingFromQuaternion(target) ?? topHeading(target)
    : topHeading(target) ?? headingFromQuaternion(target);
  return from === null || to === null ? null : new THREE.Quaternion().setFromAxisAngle(UP, (from - to) * RAD);
}

/**
 * startFromGesture must be called directly from a click/tap handler. It invokes
 * iOS requestPermission synchronously, before returning its promise. Sensors
 * never start or request access on construction, visibility resume, or page load.
 * The returned quaternion uses world North=-Z. Rotate panorama content to its
 * source bearing separately; splat coordinates need their own verified mapping.
 */
export function createOrientationController({
  window: win = globalThis.window,
  document: doc = globalThis.document,
  getCameraQuaternion = () => new THREE.Quaternion(),
  onChange = () => {},
  now = () => win?.performance?.now?.() ?? Date.now(),
  staleMs = 15000,
  maxCompassAccuracy = 35,
} = {}) {
  let status = { enabled: false, phase: 'idle', mode: null, reference: null, heading: null, physicalHeading: null, accuracy: null, northInitialized: false, relativeOnly: false, message: 'Drag to look around · Enable motion to follow your phone' };
  let epoch = 0, pending = null, timer = null, latest = null, target = null, disposed = false;
  let yawOffset = new THREE.Quaternion(), northOffset = null, northAccuracy = null, calibrated = false, hasAnchor = false, viewUsesNorth = false;
  let startedAt = 0, receivedAt = 0, lastEventTime = -Infinity, relativeAt = -Infinity;
  let lastEvent = null, sensorListener = null, listening = false, lifecycleListening = false;
  const publish = (patch) => {
    status = { ...status, ...patch };
    if (typeof onChange === 'function') onChange({ ...status });
  };
  const screenAngle = () => finite(win?.screen?.orientation?.angle) ? win.screen.orientation.angle : finite(win?.orientation) ? win.orientation : 0;
  const clearTimer = () => { if (timer !== null) (win?.clearTimeout?.bind(win) || clearTimeout)(timer); timer = null; };
  const armTimer = () => {
    clearTimer();
    timer = (win?.setTimeout?.bind(win) || setTimeout)(() => {
      timer = null;
      if (status.enabled) publish({ phase: 'stale', heading: null, physicalHeading: null, message: 'No recent orientation updates. Turn your phone, or tap “Pause motion” and drag to look around.' });
    }, staleMs);
  };
  const eventClock = (stamp, current) => {
    if (!finite(stamp) || stamp <= 0) return null;
    if (stamp > 1e12 && current < 1e12) return stamp - (Date.now() - current);
    if (stamp < 1e12 && current > 1e12) return finite(win?.performance?.timeOrigin) ? win.performance.timeOrigin + stamp : null;
    return stamp;
  };
  const applySample = (sample) => {
    const sourceChanged = latest && latest.source !== sample.source;
    if (sourceChanged) {
      // Both streams use gravity for pitch/roll, but their yaw origins differ.
      // Transfer each offset independently so a visual calibration never leaks
      // into the physical heading used for world/GPS alignment.
      const frameChange = attitudeYawAlignment(sample.quaternion, latest.quaternion);
      if (!frameChange) return;
      yawOffset.multiply(frameChange).normalize();
      if (northOffset) northOffset.multiply(frameChange).normalize();
    }
    if (!northOffset && sample.northQuaternion) {
      northOffset = attitudeYawAlignment(sample.quaternion, sample.northQuaternion);
      if (northOffset) northAccuracy = sample.accuracy;
    }
    if (!hasAnchor) {
      if (status.relativeOnly || !northOffset) {
        const alignment = attitudeYawAlignment(sample.quaternion, getCameraQuaternion(), true);
        if (!alignment) {
          publish({ phase: 'waiting', message: 'Hold your phone upright and point it forward, then tap “Align heading” to align the view.' });
          return;
        }
        yawOffset.copy(alignment);
      } else {
        yawOffset.copy(northOffset);
        viewUsesNorth = true;
      }
      hasAnchor = true;
    }
    latest = sample;
    target = yawOffset.clone().multiply(sample.quaternion).normalize();
    const physicalHeading = northOffset ? headingFromQuaternion(northOffset.clone().multiply(sample.quaternion)) : null;
    publish({ phase: 'tracking', mode: calibrated ? 'calibrated' : viewUsesNorth ? 'absolute' : 'relative',
      reference: northOffset ? 'magnetic-north' : 'relative', heading: physicalHeading, physicalHeading, accuracy: northAccuracy, northInitialized: !!northOffset,
      message: calibrated ? 'Manually aligned · Turn your phone to look around'
        : northOffset ? `North initialized${northAccuracy === null ? '' : ` (approx. ±${Math.round(northAccuracy)}°)`} · Turn or tilt your phone to look around${viewUsesNorth ? '' : ' · Align heading to match the view'}`
          : sample.compassNeedsLevel ? 'Relative follow · Briefly hold the phone flat, screen up, to initialize the compass'
            : sample.compassUnreliable ? 'Compass is unstable · Relative follow; tap “Align heading” to align manually'
              : 'Relative follow · Tap “Align heading” to align with your real direction' });
  };
  function handleOrientation(event) {
    if (!status.enabled || doc?.visibilityState === 'hidden') return;
    const current = now(), stamp = eventClock(event.timeStamp, current);
    if (stamp !== null && (stamp < startedAt - 250 || stamp < lastEventTime || current - stamp > staleMs || stamp > current + 1000)) return;
    const sample = orientationSample(event, screenAngle(), maxCompassAccuracy);
    if (!sample) return;
    // The relative stream is the browser's accelerometer/gyro fusion and avoids
    // ongoing magnetic corrections. Absolute attitude is a north seed and a
    // fallback for browsers that do not deliver relative orientation.
    // https://www.w3.org/TR/orientation-event/#choice-of-reference-coordinate-system
    if (sample.source === 'absolute' && current - relativeAt < 1000) {
      if (!northOffset && latest && sample.northQuaternion && current - receivedAt < 100) {
        northOffset = attitudeYawAlignment(latest.quaternion, sample.northQuaternion);
        if (northOffset) { northAccuracy = sample.accuracy; applySample(latest); }
      }
      return;
    }
    if (sample.source === 'relative') relativeAt = current;
    if (stamp !== null) lastEventTime = stamp;
    receivedAt = current;
    // Keep only inert scalar values; do not retain a browser event or target.
    lastEvent = { alpha: event.alpha, beta: event.beta, gamma: event.gamma, absolute: event.absolute, type: event.type,
      webkitCompassHeading: event.webkitCompassHeading, webkitCompassAccuracy: event.webkitCompassAccuracy };
    armTimer();
    applySample(sample);
  }
  function handleScreenChange() {
    if (!status.enabled || !lastEvent || now() - receivedAt > staleMs) return;
    const sample = orientationSample(lastEvent, screenAngle(), maxCompassAccuracy);
    if (sample) applySample(sample);
  }
  function handlePageHide() { stop('paused'); }
  function handleVisibility() { if (doc?.visibilityState === 'hidden') stop('paused'); }
  function attachLifecycle() {
    if (lifecycleListening) return;
    win?.addEventListener?.('pagehide', handlePageHide);
    doc?.addEventListener?.('visibilitychange', handleVisibility);
    lifecycleListening = true;
  }
  function detach() {
    if (listening) {
      win?.removeEventListener?.('deviceorientation', sensorListener);
      win?.removeEventListener?.('deviceorientationabsolute', sensorListener);
      win?.removeEventListener?.('orientationchange', handleScreenChange);
      win?.screen?.orientation?.removeEventListener?.('change', handleScreenChange);
      listening = false;
      sensorListener = null;
    }
    if (lifecycleListening) {
      win?.removeEventListener?.('pagehide', handlePageHide);
      doc?.removeEventListener?.('visibilitychange', handleVisibility);
      lifecycleListening = false;
    }
    clearTimer();
  }
  function stop(phase = 'idle') {
    epoch++;
    pending = null;
    detach();
    latest = null; target = null; lastEvent = null; calibrated = false; hasAnchor = false; viewUsesNorth = false;
    northOffset = null; northAccuracy = null; yawOffset.identity();
    relativeAt = -Infinity; lastEventTime = -Infinity;
    publish({ enabled: false, phase, mode: null, reference: null, heading: null, physicalHeading: null, accuracy: null, northInitialized: false,
      message: phase === 'paused' ? 'Motion paused. Tap “Enable motion” to resume.' : 'Drag to look around · Enable motion to follow your phone' });
  }
  function startFromGesture({ relativeOnly = false } = {}) {
    if (disposed) return Promise.resolve(false);
    if (pending) return pending;
    if (status.enabled) return Promise.resolve(true);
    if (win?.isSecureContext === false || !win?.DeviceOrientationEvent) {
      publish({ phase: 'unsupported', message: win?.isSecureContext === false ? 'Motion requires HTTPS.' : 'This browser does not support orientation sensors. Drag to look around.' });
      return Promise.resolve(false);
    }
    const requestEpoch = ++epoch;
    attachLifecycle();
    publish({ enabled: true, phase: 'requesting', relativeOnly: !!relativeOnly, message: 'Requesting phone orientation permission…' });
    let permission;
    try {
      // Do not insert awaits, timers or permission queries before this call.
      permission = typeof win.DeviceOrientationEvent.requestPermission === 'function'
        ? win.DeviceOrientationEvent.requestPermission(true) : 'granted';
    } catch (error) { permission = Promise.reject(error); }
    pending = Promise.resolve(permission).then((result) => {
      if (epoch !== requestEpoch || disposed) return false;
      pending = null;
      if (result !== 'granted') {
        detach();
        publish({ enabled: false, phase: 'denied', message: 'Orientation permission is off. You can still drag to look around.' });
        return false;
      }
      if (doc?.visibilityState === 'hidden') { stop('paused'); return false; }
      startedAt = now();
      sensorListener = (event) => { if (epoch === requestEpoch) handleOrientation(event); };
      win.addEventListener('deviceorientation', sensorListener);
      win.addEventListener('deviceorientationabsolute', sensorListener);
      win.addEventListener('orientationchange', handleScreenChange);
      win.screen?.orientation?.addEventListener?.('change', handleScreenChange);
      listening = true;
      publish({ phase: 'waiting', message: 'Hold up and turn your phone. Reading orientation…' });
      armTimer();
      return true;
    }).catch(() => {
      if (epoch !== requestEpoch || disposed) return false;
      pending = null;
      detach();
      publish({ enabled: false, phase: 'denied', message: 'Orientation permission is unavailable. You can still drag to look around.' });
      return false;
    });
    return pending;
  }
  function getQuaternion() {
    if (!status.enabled || status.phase !== 'tracking' || !target) return null;
    if (now() - receivedAt > staleMs) return null;
    return target.clone();
  }
  function calibrate(cameraQuaternion = getCameraQuaternion()) {
    if (!getQuaternion() || !latest) return false;
    const alignment = yawAlignment(latest.quaternion, cameraQuaternion);
    if (!alignment) return false;
    yawOffset.copy(alignment);
    calibrated = true;
    applySample(latest);
    return true;
  }
  return { startFromGesture, stop, calibrate, getQuaternion,
    getStatus: () => ({ ...status }),
    dispose() { stop(); disposed = true; } };
}
