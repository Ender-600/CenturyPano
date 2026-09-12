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

/** Only trustworthy north references are promoted to absolute orientation. */
export function orientationSample(event, screenAngle = 0, maxCompassAccuracy = 35) {
  if (!event || ![event.beta, event.gamma].every(finite)) return null;
  let alpha = event.alpha;
  let reference = 'relative';
  let accuracy = null;
  // Apple's alpha is arbitrary. Its compass property supplies the Z rotation,
  // not directly the optical bearing (which also depends on beta and gamma).
  // https://developer.apple.com/documentation/webkitjs/deviceorientationevent
  // https://lists.w3.org/Archives/Public/public-geolocation/2014Mar/0002.html
  const compass = finite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0 && event.webkitCompassHeading <= 360;
  const measuredAccuracy = finite(event.webkitCompassAccuracy) ? event.webkitCompassAccuracy : null;
  if (compass && measuredAccuracy !== null && measuredAccuracy >= 0 && measuredAccuracy <= maxCompassAccuracy) {
    alpha = 360 - event.webkitCompassHeading;
    accuracy = measuredAccuracy;
    reference = 'magnetic-north';
  } else if (event.absolute === true || event.type === 'deviceorientationabsolute') {
    reference = 'magnetic-north';
  }
  const quaternion = cameraQuaternionFromAngles(alpha, event.beta, event.gamma, screenAngle);
  if (!quaternion) return null;
  return { quaternion, reference, absolute: reference !== 'relative', accuracy,
    heading: reference !== 'relative' ? headingFromQuaternion(quaternion) : null,
    compassUnreliable: compass && reference === 'relative' };
}

/** Return a world-up rotation aligning two horizontal optical bearings. */
export function yawAlignment(source, target) {
  const from = headingFromQuaternion(source), to = headingFromQuaternion(target);
  if (from === null || to === null) return null;
  return new THREE.Quaternion().setFromAxisAngle(UP, (from - to) * RAD);
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
  let status = { enabled: false, phase: 'idle', mode: null, reference: null, heading: null, physicalHeading: null, accuracy: null, relativeOnly: false, message: '拖动查看 · 可开启手机跟随' };
  let epoch = 0, pending = null, timer = null, latest = null, target = null, disposed = false;
  let yawOffset = new THREE.Quaternion(), calibrated = false, hasAnchor = false;
  let startedAt = 0, receivedAt = 0, lastEventTime = -Infinity, absoluteAt = -Infinity;
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
      if (status.enabled) publish({ phase: 'stale', heading: null, physicalHeading: null, message: '方向暂未更新，请转动手机；也可关闭跟随后拖动' });
    }, staleMs);
  };
  const eventClock = (stamp, current) => {
    if (!finite(stamp) || stamp <= 0) return null;
    if (stamp > 1e12 && current < 1e12) return stamp - (Date.now() - current);
    if (stamp < 1e12 && current > 1e12) return finite(win?.performance?.timeOrigin) ? win.performance.timeOrigin + stamp : null;
    return stamp;
  };
  const applySample = (sample) => {
    const referenceChanged = latest && latest.reference !== sample.reference;
    if (!hasAnchor || referenceChanged) {
      if (calibrated || status.relativeOnly || !sample.absolute) {
        const alignment = yawAlignment(sample.quaternion, target || getCameraQuaternion());
        if (!alignment) {
          publish({ phase: 'waiting', message: '请举起手机朝向前方，再对齐视角' });
          return;
        }
        yawOffset.copy(alignment);
      } else yawOffset.identity();
      hasAnchor = true;
    }
    latest = sample;
    target = yawOffset.clone().multiply(sample.quaternion).normalize();
    publish({ phase: 'tracking', mode: calibrated ? 'calibrated' : sample.absolute && !status.relativeOnly ? 'absolute' : 'relative',
      reference: sample.reference, heading: sample.heading, physicalHeading: sample.heading, accuracy: sample.accuracy,
      message: calibrated ? '已手动对齐 · 转动手机查看'
        : sample.absolute && !status.relativeOnly ? `指南针跟随（近似）${sample.accuracy === null ? '' : ` · ±${Math.round(sample.accuracy)}°`}`
          : sample.compassUnreliable ? '指南针不稳定 · 相对跟随，可手动对齐' : '相对跟随 · 可手动对齐真实方向' });
  };
  function handleOrientation(event) {
    if (!status.enabled || doc?.visibilityState === 'hidden') return;
    const current = now(), stamp = eventClock(event.timeStamp, current);
    if (stamp !== null && (stamp < startedAt - 250 || stamp < lastEventTime || current - stamp > staleMs || stamp > current + 1000)) return;
    const sample = orientationSample(event, screenAngle(), maxCompassAccuracy);
    if (!sample || !sample.absolute && current - absoluteAt < 1000) return;
    if (sample.absolute) absoluteAt = current;
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
    latest = null; target = null; lastEvent = null; calibrated = false; hasAnchor = false;
    absoluteAt = -Infinity; lastEventTime = -Infinity;
    publish({ enabled: false, phase, mode: null, reference: null, heading: null, physicalHeading: null, accuracy: null,
      message: phase === 'paused' ? '手机跟随已暂停，点击重新开启' : '拖动查看 · 可开启手机跟随' });
  }
  function startFromGesture({ relativeOnly = false } = {}) {
    if (disposed) return Promise.resolve(false);
    if (pending) return pending;
    if (status.enabled) return Promise.resolve(true);
    if (win?.isSecureContext === false || !win?.DeviceOrientationEvent) {
      publish({ phase: 'unsupported', message: win?.isSecureContext === false ? '手机跟随需要 HTTPS 页面' : '此浏览器不支持方向传感器，请拖动查看' });
      return Promise.resolve(false);
    }
    const requestEpoch = ++epoch;
    attachLifecycle();
    publish({ enabled: true, phase: 'requesting', relativeOnly: !!relativeOnly, message: '正在请求手机方向权限' });
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
        publish({ enabled: false, phase: 'denied', message: '方向权限未开启，仍可拖动查看' });
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
      publish({ phase: 'waiting', message: '请举起并转动手机，正在读取方向' });
      armTimer();
      return true;
    }).catch(() => {
      if (epoch !== requestEpoch || disposed) return false;
      pending = null;
      detach();
      publish({ enabled: false, phase: 'denied', message: '方向权限不可用，仍可拖动查看' });
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
