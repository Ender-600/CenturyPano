import * as THREE from 'three';
import { yawAlignment } from './orientation.js';

const SESSION_ID = /^[A-Za-z0-9-]{16,128}$/;
const STATES = new Set(['tracking', 'limited', 'paused', 'unsupported', 'denied', 'error']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const vector = (value, size, bound) => Array.isArray(value) && value.length === size
  && value.every((item) => finite(item) && Math.abs(item) <= bound);

/** Validate native v1 packets before any frame reaches the virtual camera. */
export function validateMotionPacket(packet, { sessionId, sequence = -1, timestampMs = -Infinity,
  now = Date.now(), staleMs = 1000 } = {}) {
  if (!packet || typeof packet !== 'object' || packet.version !== 1
      || packet.sessionId !== sessionId || !SESSION_ID.test(sessionId || '')
      || !Number.isSafeInteger(packet.sequence) || packet.sequence < 0 || packet.sequence <= sequence
      || !finite(packet.timestampMs) || packet.timestampMs <= 0 || packet.timestampMs < timestampMs
      || now - packet.timestampMs > staleMs || packet.timestampMs - now > 250
      || !STATES.has(packet.state)) return null;
  const result = { sequence: packet.sequence, timestampMs: packet.timestampMs, state: packet.state };
  if (packet.state !== 'tracking') return result;
  if (!vector(packet.position, 3, 1e6) || !vector(packet.quaternion, 4, 1.001)) return null;
  const length = Math.hypot(...packet.quaternion);
  if (Math.abs(length - 1) > 0.01) return null;
  return { ...result, position: new THREE.Vector3().fromArray(packet.position),
    quaternion: new THREE.Quaternion().fromArray(packet.quaternion).normalize() };
}

/** Anchor only yaw, keeping native gravity. Meter translation is independent of view direction. */
export function createPoseAnchor(nativePose, virtualPose, worldUnitsPerMeter) {
  if (!finite(worldUnitsPerMeter) || worldUnitsPerMeter <= 0 || worldUnitsPerMeter > 10000) return null;
  const yaw = yawAlignment(nativePose.quaternion, virtualPose.quaternion);
  if (!yaw) return null;
  return { nativeOrigin: nativePose.position.clone(), worldOrigin: virtualPose.position.clone(),
    yaw, worldUnitsPerMeter };
}

export function transformPose(pose, anchor) {
  return {
    position: pose.position.clone().sub(anchor.nativeOrigin).applyQuaternion(anchor.yaw)
      .multiplyScalar(anchor.worldUnitsPerMeter).add(anchor.worldOrigin),
    quaternion: anchor.yaw.clone().multiply(pose.quaternion).normalize(),
  };
}

const MESSAGES = {
  idle: 'Walking stopped. Drag to look around.',
  unavailable: 'Walking requires the CenturyPano native app (ARKit / ARCore). In Safari, you can still explore panoramas and enable motion to follow your phone.',
  waiting: 'Starting on-device camera tracking. Point your phone forward and slowly look around.',
  tracking: 'Walking is on · Move and turn your phone to control the view.',
  lost: 'Spatial tracking was lost. The view is frozen. Stand still, then tap “Reset start”. The view will not reset automatically.',
  timeout: 'Spatial tracking timed out. The view is frozen. Stand still, then tap “Reset start”.',
  background: 'Camera tracking stopped after leaving the page. Tap “Reset start” when you return.',
  denied: 'Camera permission is off. Allow camera access for the native app, then try again.',
  unsupported: 'This device does not support AR spatial tracking. You can still look around.',
  error: 'On-device camera tracking could not start. Stop tracking, then try again.',
  scale: 'First enter a positive scale: the number of model units per real meter.',
  anchor: 'Point your phone and the virtual view forward, then tap “Reset start”.',
  changed: 'The world changed. Spatial tracking stopped. Tap “Enable walking” to set the start for this world.',
};

export function createMotionController({ window: win = globalThis.window, document: doc = globalThis.document,
  now = Date.now, onChange = () => {}, staleMs = 1000, startupMs = 12000, sessionIdFactory } = {}) {
  let status = { enabled: false, locked: false, phase: 'idle', needsReanchor: false, message: MESSAGES.idle };
  let sessionId = null, sequence = -1, timestampMs = -Infinity, receivedAt = 0, timer = null;
  let anchor = null, initialView = null, scale = null, lastNative = null, output = null, disposed = false;
  const nativeBridge = () => {
    const candidate = win?.CenturyMotion;
    return candidate?.version === 1 && ['ios', 'android'].includes(candidate.platform)
      && typeof candidate.postMessage === 'function' ? candidate : null;
  };
  const publish = (patch) => {
    const next = { ...status, ...patch };
    if (Object.keys(next).every((key) => next[key] === status[key])) return;
    status = next; onChange({ ...status });
  };
  const clearTimer = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  const endSession = () => {
    clearTimer();
    const previous = sessionId; sessionId = null;
    if (previous) { try { nativeBridge()?.postMessage(JSON.stringify({ version: 1, action: 'stop', sessionId: previous })); } catch { /* Freeze locally even if native transport failed. */ } }
  };
  const freeze = (phase = 'lost') => {
    endSession();
    publish({ enabled: false, locked: true, needsReanchor: true, phase, message: MESSAGES[phase] || MESSAGES.lost });
  };
  const armTimer = (delay) => {
    clearTimer(); timer = win.setTimeout(() => { if (status.enabled) freeze('timeout'); }, delay);
  };
  function stop(phase = 'idle') {
    endSession(); anchor = null; output = null; lastNative = null;
    publish({ enabled: false, locked: false, needsReanchor: false, phase, message: MESSAGES[phase] || MESSAGES.idle });
  }
  function start({ worldUnitsPerMeter, anchorPosition, anchorQuaternion } = {}) {
    if (disposed || doc?.visibilityState === 'hidden') return false;
    if (!nativeBridge()) { stop('unavailable'); return false; }
    if (!finite(worldUnitsPerMeter) || worldUnitsPerMeter <= 0 || worldUnitsPerMeter > 10000) {
      publish({ phase: 'scale', message: MESSAGES.scale }); return false;
    }
    if (!anchorPosition || !anchorQuaternion || ![...anchorPosition.toArray(), ...anchorQuaternion.toArray()].every(finite)) return false;
    const createId = sessionIdFactory || (() => win.crypto?.randomUUID?.());
    const nextId = createId();
    if (!SESSION_ID.test(nextId || '')) { stop('error'); return false; }
    endSession(); sessionId = nextId; sequence = -1; timestampMs = -Infinity;
    anchor = null; lastNative = null; output = null; receivedAt = now(); scale = worldUnitsPerMeter;
    initialView = { position: anchorPosition.clone(), quaternion: anchorQuaternion.clone().normalize() };
    publish({ enabled: true, locked: true, phase: 'waiting', needsReanchor: false, message: MESSAGES.waiting });
    armTimer(startupMs);
    try { nativeBridge().postMessage(JSON.stringify({ version: 1, action: 'start', sessionId })); }
    catch { stop('error'); return false; }
    return true;
  }
  function receive(event) {
    if (!sessionId || !status.enabled || doc?.visibilityState === 'hidden') return;
    const packet = validateMotionPacket(event?.detail, { sessionId, sequence, timestampMs, now: now(), staleMs });
    if (!packet) return;
    sequence = packet.sequence; timestampMs = packet.timestampMs;
    if (packet.state !== 'tracking') {
      if (packet.state === 'limited' && !anchor) return;
      if (['denied', 'unsupported', 'error'].includes(packet.state) && !anchor) { stop(packet.state); return; }
      freeze(packet.state === 'paused' ? 'background' : 'lost'); return;
    }
    if (!anchor) {
      anchor = createPoseAnchor(packet, initialView, scale);
      if (!anchor) { freeze('anchor'); return; }
    } else if (lastNative) {
      const elapsed = Math.max(0, (packet.timestampMs - lastNative.timestampMs) / 1000);
      if (packet.position.distanceTo(lastNative.position) > Math.max(0.75, elapsed * 8)) { freeze('lost'); return; }
    }
    receivedAt = now(); lastNative = packet; output = transformPose(packet, anchor); armTimer(staleMs);
    publish({ enabled: true, locked: true, needsReanchor: false, phase: 'tracking', message: MESSAGES.tracking });
  }
  function getPose() {
    if (status.enabled && status.phase === 'tracking' && now() - receivedAt > staleMs) freeze('timeout');
    return output && status.locked ? { position: output.position.clone(), quaternion: output.quaternion.clone() } : null;
  }
  const pageHide = () => { if (status.locked || status.enabled) freeze('background'); };
  const visibility = () => { if (doc?.visibilityState === 'hidden') pageHide(); };
  win?.addEventListener?.('century:motion', receive);
  win?.addEventListener?.('pagehide', pageHide);
  doc?.addEventListener?.('visibilitychange', visibility);
  return { start, reanchor: start, stop, getPose, available: () => !!nativeBridge(), getStatus: () => ({ ...status }),
    dispose() { stop(); disposed = true; win?.removeEventListener?.('century:motion', receive);
      win?.removeEventListener?.('pagehide', pageHide); doc?.removeEventListener?.('visibilitychange', visibility); } };
}
