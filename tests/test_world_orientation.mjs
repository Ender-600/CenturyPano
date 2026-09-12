import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { cameraQuaternionFromAngles, createOrientationController, headingFromQuaternion, orientationSample, yawAlignment } from '../web/world/orientation.js';

const RAD = Math.PI / 180;
function near(actual, expected, tolerance = 1e-7) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`); }
function sameRotation(actual, expected) { assert.ok(actual.angleTo(expected) < 1e-7, `${actual.toArray()} != ${expected.toArray()}`); }
function facing(heading) { return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * RAD); }

class Surface {
  listeners = new Map();
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, data = {}) { for (const handler of [...(this.listeners.get(type) || [])]) handler({ type, ...data }); }
  count(type) { return this.listeners.get(type)?.size || 0; }
  total() { return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0); }
}

function fixture(options = {}) {
  const win = new Surface(), doc = new Surface(), screen = new Surface();
  let current = 10000, sequence = 0, calls = 0, viewer = options.viewerQuaternion?.clone() || facing(options.viewerHeading || 0);
  const timers = new Map(), updates = [];
  doc.visibilityState = 'visible'; screen.angle = 0;
  Object.assign(win, { isSecureContext: true, screen: { orientation: screen }, performance: { now: () => current },
    DeviceOrientationEvent: options.unsupported ? undefined : {},
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: current + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  if (options.permission) win.DeviceOrientationEvent.requestPermission = (...args) => { calls++; return options.permission(...args); };
  const controller = createOrientationController({ window: win, document: doc, onChange: (status) => updates.push(status),
    getCameraQuaternion: () => viewer, staleMs: options.staleMs || 15000 });
  return { win, doc, screen, controller, timers, updates, calls: () => calls,
    camera(heading) { viewer = facing(heading); },
    send(data = {}, type = 'deviceorientation') { win.emit(type, { alpha: 0, beta: 90, gamma: 0, timeStamp: current, ...data }); },
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= current) { timers.delete(id); timer.callback(); }
    },
  };
}

test('upright rear-camera north/east/south/west uses ENU world axes', () => {
  for (const [alpha, expected, vector] of [[0, 0, [0, 0, -1]], [270, 90, [1, 0, 0]], [180, 180, [0, 0, 1]], [90, 270, [-1, 0, 0]]]) {
    const quaternion = cameraQuaternionFromAngles(alpha, 90, 0);
    near(headingFromQuaternion(quaternion), expected);
    const optical = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    optical.toArray().forEach((value, index) => near(value, vector[index]));
  }
});

test('the optical bearing depends on all three angles, not just alpha', () => {
  near(headingFromQuaternion(cameraQuaternionFromAngles(0, 90, 30)), 330);
  near(headingFromQuaternion(cameraQuaternionFromAngles(270, 0, 90)), 0);
  const pitched = cameraQuaternionFromAngles(0, 120, 0);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pitched);
  near(forward.y, 0.5);
  near(forward.z, -Math.sqrt(3) / 2);
  assert.equal(headingFromQuaternion(cameraQuaternionFromAngles(0, 0, 0)), null);
});

test('portrait and both landscape orientations preserve optical axis and screen horizon', () => {
  const portrait = cameraQuaternionFromAngles(0, 90, 0, 0);
  sameRotation(cameraQuaternionFromAngles(270, 0, 90, -90), portrait);
  sameRotation(cameraQuaternionFromAngles(90, 0, -90, 90), portrait);
  // Screen metadata by itself only changes the roll, never the optical bearing.
  for (const angle of [-90, 90, 180]) near(headingFromQuaternion(cameraQuaternionFromAngles(270, 90, 0, angle)), 90);
});

test('wrapping 359 through north takes the short arc when interpolated', () => {
  const from = cameraQuaternionFromAngles(1, 90, 0), to = cameraQuaternionFromAngles(0, 90, 0);
  near(from.angleTo(to) / RAD, 1);
  near(headingFromQuaternion(from.clone().slerp(to, 0.5)), 359.5);
});

test('null, strings, undefined, NaN and infinity cannot turn into north readings', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) {
    assert.equal(cameraQuaternionFromAngles(value, 90, 0), null);
    assert.equal(orientationSample({ alpha: 0, beta: value, gamma: 0, absolute: true }), null);
    assert.equal(orientationSample({ alpha: value, beta: 90, gamma: 0, absolute: true }), null);
  }
  assert.equal(headingFromQuaternion(null), null);
  assert.equal(yawAlignment(cameraQuaternionFromAngles(0, 0, 0), facing(0)), null);
});

test('Safari compass is a separate north seed only when accurate and screen-up level', () => {
  const sample = orientationSample({ alpha: 10, beta: 20, gamma: 15, webkitCompassHeading: 90, webkitCompassAccuracy: 12 });
  assert.equal(sample.absolute, true);
  assert.equal(sample.source, 'relative');
  assert.equal(sample.reference, 'magnetic-north');
  assert.equal(sample.accuracy, 12);
  sameRotation(sample.quaternion, cameraQuaternionFromAngles(10, 20, 15));
  sameRotation(sample.northQuaternion, cameraQuaternionFromAngles(270, 20, 15));
  for (const accuracy of [-1, 36, null, undefined, NaN]) {
    const invalid = orientationSample({ alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: 90, webkitCompassAccuracy: accuracy });
    assert.equal(invalid.absolute, false);
    assert.equal(invalid.heading, null);
    assert.equal(invalid.northQuaternion, null);
  }
  for (const [beta, gamma] of [[90, 0], [75, 10], [0, 80], [180, 0], [30, 30]]) {
    const upright = orientationSample({ alpha: 10, beta, gamma, webkitCompassHeading: 90, webkitCompassAccuracy: 12 });
    assert.equal(upright.absolute, false);
    assert.equal(upright.compassNeedsLevel, true);
    sameRotation(upright.quaternion, cameraQuaternionFromAngles(10, beta, gamma));
  }
  assert.equal(orientationSample({ alpha: 10, beta: 90, gamma: 0 }).absolute, false);
});

test('relative orientation anchors to the current viewer bearing and follows turn deltas', async () => {
  const f = fixture({ viewerHeading: 120 }); await f.controller.startFromGesture();
  f.send({ alpha: 30 }); near(headingFromQuaternion(f.controller.getQuaternion()), 120);
  assert.equal(f.controller.getStatus().mode, 'relative');
  assert.equal(f.controller.getStatus().heading, null);
  f.send({ alpha: 20 }); near(headingFromQuaternion(f.controller.getQuaternion()), 130);
  f.controller.dispose();
});

test('absolute events seed north, then relative attitude takes over without a jump', async () => {
  const f = fixture({ viewerHeading: 200 }); await f.controller.startFromGesture();
  f.send({ alpha: 270 }, 'deviceorientationabsolute');
  near(headingFromQuaternion(f.controller.getQuaternion()), 90);
  assert.equal(f.controller.getStatus().mode, 'absolute');
  assert.equal(f.controller.getStatus().reference, 'magnetic-north');
  f.send({ alpha: 10 }); near(headingFromQuaternion(f.controller.getQuaternion()), 90);
  near(f.controller.getStatus().physicalHeading, 90);
  f.send({ alpha: 0 }); near(headingFromQuaternion(f.controller.getQuaternion()), 100);
  f.send({ alpha: 150 }, 'deviceorientationabsolute');
  near(headingFromQuaternion(f.controller.getQuaternion()), 100);
  near(f.controller.getStatus().physicalHeading, 100);
  f.controller.dispose();
});

test('raising and tilting the phone follows full attitude without reinjecting compass jumps', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  f.send({ alpha: 10, beta: 0, webkitCompassHeading: 90, webkitCompassAccuracy: 12 });
  assert.equal(f.controller.getStatus().northInitialized, true);
  assert.equal(f.controller.getStatus().physicalHeading, null); // Optical axis points down.
  const northOffset = facing(100);
  for (const beta of [40, 70, 89.5, 90, 100, 120]) {
    f.send({ alpha: 10, beta, webkitCompassHeading: (beta * 7) % 360, webkitCompassAccuracy: 5 });
    sameRotation(f.controller.getQuaternion(), northOffset.clone().multiply(cameraQuaternionFromAngles(10, beta, 0)));
    near(f.controller.getStatus().physicalHeading, 90);
    assert.equal(f.controller.getStatus().accuracy, 12);
  }
  // At the Euler singularity, alpha and gamma can trade values for the same
  // attitude. The old compass-as-alpha code converted this into a false turn.
  f.send({ alpha: 10, beta: 90, gamma: 30, webkitCompassHeading: 30, webkitCompassAccuracy: 8 });
  const before = f.controller.getQuaternion();
  f.send({ alpha: 40, beta: 90, gamma: 0, webkitCompassHeading: 270, webkitCompassAccuracy: 8 });
  sameRotation(f.controller.getQuaternion(), before);
  near(f.controller.getStatus().physicalHeading, 60);
  // Returning to level with a new magnetic measurement does not re-anchor yaw.
  f.send({ alpha: 40, beta: 0, webkitCompassHeading: 230, webkitCompassAccuracy: 1 });
  f.send({ alpha: 40, beta: 90, webkitCompassHeading: 230, webkitCompassAccuracy: -1 });
  near(f.controller.getStatus().physicalHeading, 60);
  f.controller.dispose();
});

test('upright startup remains usable and delayed north initialization preserves the view', async () => {
  const f = fixture({ viewerHeading: 140 }); await f.controller.startFromGesture();
  f.send({ alpha: 10, webkitCompassHeading: 250, webkitCompassAccuracy: 5 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 140);
  assert.equal(f.controller.getStatus().physicalHeading, null);
  assert.match(f.controller.getStatus().message, /hold the phone flat/);
  f.send({ alpha: 0, beta: 100, webkitCompassHeading: 50, webkitCompassAccuracy: 5 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 150);
  f.send({ alpha: 0, beta: 0, webkitCompassHeading: 90, webkitCompassAccuracy: 10 });
  assert.equal(f.controller.getStatus().northInitialized, true);
  f.send({ alpha: 0, beta: 90, webkitCompassHeading: 270, webkitCompassAccuracy: 5 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 150);
  near(f.controller.getStatus().physicalHeading, 90);
  assert.equal(f.controller.getStatus().mode, 'relative');
  f.controller.dispose();
});

test('a concurrent absolute sample initializes north without replacing relative look', async () => {
  const f = fixture({ viewerHeading: 160 }); await f.controller.startFromGesture();
  f.send({ alpha: 20 });
  f.send({ alpha: 270 }, 'deviceorientationabsolute');
  near(headingFromQuaternion(f.controller.getQuaternion()), 160);
  near(f.controller.getStatus().physicalHeading, 90);
  f.send({ alpha: 10 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 170);
  near(f.controller.getStatus().physicalHeading, 100);
  f.send({ alpha: 90 }, 'deviceorientationabsolute');
  near(f.controller.getStatus().physicalHeading, 100);
  f.controller.dispose();
});

test('relative/absolute fallback and compass accuracy changes preserve independent calibrations', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  f.send({ alpha: 270 }, 'deviceorientationabsolute');
  f.send({ alpha: 10 });
  assert.equal(f.controller.calibrate(facing(20)), true);
  f.send({ alpha: 0, webkitCompassHeading: 300, webkitCompassAccuracy: 7 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 30);
  near(f.controller.getStatus().physicalHeading, 100);
  f.advance(1001);
  f.send({ alpha: 200 }, 'deviceorientationabsolute');
  near(headingFromQuaternion(f.controller.getQuaternion()), 30);
  near(f.controller.getStatus().physicalHeading, 100);
  f.send({ alpha: 190 }, 'deviceorientationabsolute');
  near(headingFromQuaternion(f.controller.getQuaternion()), 40);
  near(f.controller.getStatus().physicalHeading, 110);
  f.send({ alpha: 340, webkitCompassHeading: 90, webkitCompassAccuracy: -1 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 40);
  near(f.controller.getStatus().physicalHeading, 110);
  f.send({ alpha: 330, webkitCompassHeading: 0, webkitCompassAccuracy: 7 });
  near(headingFromQuaternion(f.controller.getQuaternion()), 50);
  near(f.controller.getStatus().physicalHeading, 120);
  f.controller.dispose();
});

test('a level relative startup follows pitch when the phone is raised', async () => {
  for (const pitch of [-30, 0, 30]) {
    const viewerQuaternion = facing(160).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch * RAD));
    const f = fixture({ viewerQuaternion }); await f.controller.startFromGesture();
    f.send({ alpha: 20, beta: 0 });
    assert.ok(f.controller.getQuaternion());
    f.send({ alpha: 20, beta: 90 });
    near(headingFromQuaternion(f.controller.getQuaternion()), 160);
    f.controller.dispose();
  }
});

test('relativeOnly preserves arbitrary model axes even with a compass', async () => {
  const f = fixture({ viewerHeading: 160 }); await f.controller.startFromGesture({ relativeOnly: true });
  f.send({ alpha: 270, absolute: true }); near(headingFromQuaternion(f.controller.getQuaternion()), 160);
  assert.equal(f.controller.getStatus().mode, 'relative');
  assert.equal(f.controller.getStatus().physicalHeading, 90);
  f.send({ alpha: 260, absolute: true }); near(headingFromQuaternion(f.controller.getQuaternion()), 170);
  assert.doesNotMatch(f.controller.getStatus().message, /Compass follow/);
  f.controller.dispose();
});

test('manual calibration preserves physical bearing metadata and subsequent turns', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  f.send({ alpha: 270, absolute: true });
  assert.equal(f.controller.calibrate(facing(15)), true);
  near(headingFromQuaternion(f.controller.getQuaternion()), 15);
  assert.equal(f.controller.getStatus().heading, 90);
  assert.equal(f.controller.getStatus().mode, 'calibrated');
  f.send({ alpha: 260, absolute: true });
  near(headingFromQuaternion(f.controller.getQuaternion()), 25);
  near(f.controller.getStatus().physicalHeading, 100);
  f.controller.dispose();
});

test('permission request runs synchronously in the gesture and denial removes listeners', async () => {
  let finish, requestedAbsolute;
  const f = fixture({ permission: (absolute) => { requestedAbsolute = absolute; return new Promise((resolve) => { finish = resolve; }); } });
  assert.equal(f.calls(), 0);
  const pending = f.controller.startFromGesture();
  assert.equal(f.calls(), 1); assert.equal(requestedAbsolute, true);
  assert.equal(f.win.count('deviceorientation'), 0);
  finish('denied'); assert.equal(await pending, false);
  assert.equal(f.controller.getStatus().phase, 'denied');
  assert.equal(f.controller.getQuaternion(), null);
  assert.equal(f.win.total(), 0); assert.equal(f.doc.total(), 0); assert.equal(f.timers.size, 0);
});

test('permission exceptions and unavailable sensors leave drag mode intact', async () => {
  for (const options of [{ permission: () => { throw new Error('denied'); } }, { unsupported: true }]) {
    const f = fixture(options);
    assert.equal(await f.controller.startFromGesture(), false);
    assert.equal(f.controller.getStatus().enabled, false);
    assert.equal(f.controller.getQuaternion(), null);
    assert.equal(f.win.total(), 0);
  }
});

test('hidden page cancels a pending grant and never requests access on resume', async () => {
  let finish;
  const f = fixture({ permission: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = f.controller.startFromGesture();
  f.doc.visibilityState = 'hidden'; f.doc.emit('visibilitychange');
  finish('granted'); assert.equal(await pending, false);
  f.doc.visibilityState = 'visible'; f.doc.emit('visibilitychange');
  assert.equal(f.calls(), 1); assert.equal(f.win.total(), 0);
  assert.equal(f.controller.getStatus().enabled, false);
});

test('pagehide and stop remove all sensor, screen and lifecycle listeners and timers', async () => {
  for (const action of ['pagehide', 'stop', 'dispose', 'visibility']) {
    const f = fixture(); await f.controller.startFromGesture(); f.send({ absolute: true });
    assert.equal(f.win.count('deviceorientation'), 1); assert.equal(f.screen.total(), 1);
    if (action === 'pagehide') f.win.emit('pagehide');
    else if (action === 'visibility') { f.doc.visibilityState = 'hidden'; f.doc.emit('visibilitychange'); }
    else f.controller[action]();
    assert.equal(f.win.total(), 0); assert.equal(f.doc.total(), 0); assert.equal(f.screen.total(), 0); assert.equal(f.timers.size, 0);
    f.send({ alpha: 40, absolute: true }); assert.equal(f.controller.getQuaternion(), null);
  }
});

test('stale callbacks and out-of-order events cannot move the viewer', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  f.send({ timeStamp: 100, alpha: 90, absolute: true }); assert.equal(f.controller.getQuaternion(), null);
  f.send({ alpha: 270, absolute: true });
  f.advance(100);
  f.send({ timeStamp: 9999, alpha: 90, absolute: true }); near(headingFromQuaternion(f.controller.getQuaternion()), 90);
  f.advance(15001);
  assert.equal(f.controller.getStatus().phase, 'stale'); assert.equal(f.controller.getQuaternion(), null);
  assert.equal(f.controller.getStatus().heading, null);
  f.send({ timeStamp: 10000, alpha: 90, absolute: true }); assert.equal(f.controller.getQuaternion(), null);
  f.send({ alpha: 180, absolute: true }); near(headingFromQuaternion(f.controller.getQuaternion()), 180);
  f.controller.dispose();
});

test('no readings produces a timeout and invalid data cannot renew stale samples', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  f.advance(15001); assert.equal(f.controller.getStatus().phase, 'stale');
  f.send({ alpha: null, beta: null, gamma: null });
  assert.equal(f.controller.getQuaternion(), null); assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('a queued sensor callback from the old session cannot enter a restarted session', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  const oldCallback = [...f.win.listeners.get('deviceorientation')][0];
  f.controller.stop(); await f.controller.startFromGesture();
  oldCallback({ type: 'deviceorientation', alpha: 270, beta: 90, gamma: 0, absolute: true, timeStamp: 10000 });
  assert.equal(f.controller.getQuaternion(), null);
  f.send({ alpha: 180, absolute: true }); near(headingFromQuaternion(f.controller.getQuaternion()), 180);
  f.controller.dispose();
});

test('screen orientation event updates roll without corrupting physical bearing', async () => {
  const f = fixture(); await f.controller.startFromGesture();
  f.send({ alpha: 270, beta: 0, gamma: 90, absolute: true });
  f.screen.angle = -90; f.screen.emit('change');
  sameRotation(f.controller.getQuaternion(), facing(0));
  near(f.controller.getStatus().physicalHeading, 0);
  f.controller.dispose();
});
