import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createGPSWalkingController } from '../web/world/gps-walking.js';

const NOW = 1800000000000;
const DEGREE_METERS = 6371000 * Math.PI / 180;
const vector = (...values) => new THREE.Vector3(...values);
const close = (actual, expected, tolerance = 1e-6) => {
  assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} != ${expected.toArray()}`);
};
function rig(options = {}) {
  let clock = NOW, counter = 0;
  const events = new Map(), timers = new Map(), changes = [];
  const addEventListener = (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); };
  const removeEventListener = (name, fn) => events.get(name)?.delete(fn);
  const win = { addEventListener, removeEventListener,
    setTimeout(fn, delay) {
      const id = ++counter; timers.set(id, { fn() { timers.delete(id); fn(); }, delay }); return id;
    }, clearTimeout(id) { timers.delete(id); } };
  const doc = { visibilityState: 'visible', addEventListener, removeEventListener };
  const controller = createGPSWalkingController({ window: win, document: doc, now: () => clock,
    onChange: (status) => changes.push(status), ...options });
  return { controller, changes, timers, doc,
    start(overrides = {}) { return controller.start({ worldUnitsPerMeter: 1,
      anchorPosition: vector(10, 2, 20), headingDegrees: 0, worldYaw: 0, ...overrides }); },
    fix(east = 0, north = 0, overrides = {}) {
      return controller.receiveFix({ lat: north / DEGREE_METERS, lon: east / DEGREE_METERS,
        accuracy_m: 1, timestamp_ms: clock, ...overrides });
    },
    advance(ms) { clock += ms; },
    emit(name) { for (const fn of events.get(name) || []) fn(); },
    listenerCount() { return [...events.values()].reduce((n, set) => n + set.size, 0); },
  };
}

test('starts only explicitly and maps geographic displacement into meters at the configured scale', () => {
  const r = rig({ smoothingSeconds: 0 });
  assert.equal(r.controller.getPosition(1), null); assert.equal(r.timers.size, 0);
  assert.equal(r.start({ worldUnitsPerMeter: 2 }), true);
  assert.equal(r.controller.getStatus().phase, 'waiting');
  assert.equal(r.controller.getStatus().locked, true);
  r.fix(); close(r.controller.getPosition(1), vector(10, 2, 20));
  r.advance(2000); r.fix(0, 2);
  close(r.controller.getPosition(1), vector(10, 2, 16));
  r.advance(2000); r.fix(2, 2);
  close(r.controller.getPosition(1), vector(14, 2, 16));
  r.controller.dispose();
});

test('calibrates the geographic direction once, independent of subsequent camera rotation', () => {
  const r = rig({ smoothingSeconds: 0 });
  const camera = new THREE.PerspectiveCamera(); camera.rotation.y = -Math.PI / 2;
  const anchor = vector(10, 2, 20);
  r.start({ anchorPosition: anchor, headingDegrees: 90, worldYaw: camera.rotation.y });
  anchor.set(999, 999, 999); r.fix();
  for (const yaw of [0, 1.2, Math.PI]) {
    camera.rotation.y = yaw;
    r.advance(2000); r.fix(2 + yaw * 2, 0);
    close(r.controller.getPosition(1), vector(12 + yaw * 2, 2, 20));
  }
  const status = r.controller.getStatus();
  assert.equal('quaternion' in status, false);
  const position = r.controller.getPosition(); position.set(0, 0, 0);
  close(r.controller.getPosition(), vector(12 + Math.PI * 2, 2, 20));
  r.controller.dispose();
});

test('east-facing physical calibration can map east to virtual forward', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start({ headingDegrees: 90 }); r.fix();
  r.advance(2000); r.fix(2, 0);
  close(r.controller.getPosition(1), vector(10, 2, 18)); r.controller.dispose();
});

test('stationary jitter is suppressed while consecutive small steps accumulate', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix(0, 0, { accuracy_m: 5 });
  for (let i = 0; i < 20; i++) {
    r.advance(1000); r.fix(Math.sin(i) * 1.5, Math.cos(i) * 1.5, { accuracy_m: 5 });
    close(r.controller.getPosition(1), vector(10, 2, 20));
  }
  for (let i = 1; i <= 4; i++) { r.advance(1000); r.fix(0, i, { accuracy_m: 5 }); }
  close(r.controller.getPosition(1), vector(10, 2, 16));
  r.controller.dispose();
});

test('smooths new GPS targets continuously without overshoot and freezes the displayed position on loss', () => {
  const r = rig(); r.start(); r.fix(); r.advance(2000); r.fix(0, 3);
  const first = r.controller.getPosition(1 / 60);
  assert.ok(first.z < 20 && first.z > 17);
  let previous = first.z;
  for (let i = 0; i < 120; i++) {
    const current = r.controller.getPosition(1 / 60);
    assert.ok(current.z <= previous && current.z >= 17); previous = current.z;
  }
  const frozen = r.controller.getPosition(); r.controller.fail({ code: 1 });
  close(r.controller.getPosition(10), frozen);
  assert.equal(r.controller.getStatus().needsReanchor, true);
  r.controller.dispose();
});

test('rejects malformed, cached, duplicate, future, and out-of-order fixes without changing the anchor', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start();
  for (const malformed of [null, undefined, {}]) assert.equal(r.controller.receiveFix(malformed), false);
  for (const bad of [{ lat: 90 }, { lon: Infinity }, { accuracy_m: '1' }, { accuracy_m: -1 },
    { timestamp_ms: NOW - 1 }, { timestamp_ms: NOW - 5001 }, { timestamp_ms: NOW + 1001 }]) {
    assert.equal(r.fix(0, 0, bad), false);
  }
  assert.equal(r.controller.getStatus().phase, 'waiting'); assert.equal(r.fix(), true);
  assert.equal(r.fix(50), false);
  r.advance(2000); assert.equal(r.fix(0, 2), true);
  assert.equal(r.fix(50, 0, { timestamp_ms: NOW + 1000 }), false);
  close(r.controller.getPosition(1), vector(10, 2, 18)); r.controller.dispose();
});

test('waits for useful startup accuracy and resumes after a temporary accuracy drop without reanchoring', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start();
  assert.equal(r.fix(0, 0, { accuracy_m: 80 }), false);
  assert.equal(r.controller.getStatus().enabled, true);
  assert.equal(r.controller.getStatus().phase, 'accuracy');
  r.advance(1000); assert.equal(r.fix(), true);
  r.advance(1000); assert.equal(r.fix(3, 0, { accuracy_m: 21 }), false);
  assert.equal(r.controller.getStatus().enabled, true);
  assert.equal(r.controller.getStatus().locked, true);
  assert.equal(r.controller.getStatus().needsReanchor, false);
  close(r.controller.getPosition(1), vector(10, 2, 20));
  r.advance(1000); assert.equal(r.fix(3), true);
  close(r.controller.getPosition(1), vector(13, 2, 20));
  assert.equal(r.controller.getStatus().phase, 'tracking'); r.controller.dispose();
});

test('accuracy holds freeze interpolation and retain its pending target for a fresh good fix', () => {
  const r = rig(); r.start(); r.fix(); r.advance(2000); r.fix(0, 3);
  const partiallyMoved = r.controller.getPosition(1 / 60);
  assert.ok(partiallyMoved.z > 17 && partiallyMoved.z < 20);
  r.advance(1000); r.fix(100, 0, { accuracy_m: 80 });
  for (let i = 0; i < 10; i++) close(r.controller.getPosition(1), partiallyMoved);
  r.advance(1000); assert.equal(r.fix(0, 3), true);
  for (let i = 0; i < 30; i++) r.controller.getPosition(1);
  close(r.controller.getPosition(), vector(10, 2, 17)); r.controller.dispose();
});

test('poor accuracy cannot extend the last good fix deadline indefinitely', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix();
  const timer = [...r.timers.values()][0];
  assert.equal(timer.delay, 20000);
  for (let i = 0; i < 3; i++) {
    r.advance(5000); assert.equal(r.fix(0, 10, { accuracy_m: 80 }), false);
    assert.equal(r.controller.getStatus().enabled, true);
    assert.equal([...r.timers.values()][0], timer);
  }
  r.advance(5001); assert.equal(r.fix(0, 10), false);
  assert.equal(r.controller.getStatus().phase, 'timeout');
  assert.equal(r.controller.getStatus().needsReanchor, true);
  close(r.controller.getPosition(1), vector(10, 2, 20)); r.controller.dispose();
});

test('temporary location errors hold and recover within the same bounded freshness window', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix();
  const timer = [...r.timers.values()][0];
  for (const code of [2, 3]) {
    r.advance(5000); r.controller.fail({ code });
    assert.equal(r.controller.getStatus().enabled, true);
    assert.equal(r.controller.getStatus().phase, 'error');
    assert.equal(r.controller.getStatus().needsReanchor, false);
    assert.equal([...r.timers.values()][0], timer);
    close(r.controller.getPosition(1), vector(10, 2, 20));
  }
  r.advance(2000); assert.equal(r.fix(0, 3), true);
  close(r.controller.getPosition(1), vector(10, 2, 17));
  r.advance(20001); r.controller.fail({ code: 2 });
  assert.equal(r.controller.getStatus().phase, 'timeout');
  assert.equal(r.controller.getStatus().enabled, false); r.controller.dispose();
});

test('diagnostics distinguish sub-deadband displacement from no sensor movement', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix(0, 0, { accuracy_m: 10 });
  assert.equal(r.controller.getStatus().deadbandMeters, 7);
  assert.equal(r.controller.getStatus().observedDisplacementMeters, 0);
  assert.equal(r.controller.getStatus().pendingMovementMeters, 0);
  r.advance(3000); r.fix(0, 3, { accuracy_m: 10 });
  let status = r.controller.getStatus();
  assert.equal(status.displacementMeters, 0);
  assert.ok(Math.abs(status.observedDisplacementMeters - 3) < 1e-6);
  assert.ok(Math.abs(status.pendingMovementMeters - 3) < 1e-6);
  close(r.controller.getPosition(1), vector(10, 2, 20));
  r.advance(5000); r.fix(0, 8, { accuracy_m: 10 });
  status = r.controller.getStatus();
  assert.ok(Math.abs(status.observedDisplacementMeters - 8) < 1e-6);
  assert.equal(status.pendingMovementMeters, 0);
  close(r.controller.getPosition(1), vector(10, 2, 12));
  r.controller.stop(); status = r.controller.getStatus();
  assert.equal(status.deadbandMeters, null); assert.equal(status.observedDisplacementMeters, 0);
  assert.equal(status.pendingMovementMeters, 0); r.controller.dispose();
});

test('implausible GPS jumps freeze without moving or automatically recovering', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix(); r.advance(1000);
  assert.equal(r.fix(100), false);
  assert.equal(r.controller.getStatus().phase, 'jump');
  close(r.controller.getPosition(1), vector(10, 2, 20));
  r.advance(1000); assert.equal(r.fix(2), false);
  r.start({ anchorPosition: vector(10, 2, 20) }); r.fix(100);
  close(r.controller.getPosition(1), vector(10, 2, 20));
  r.advance(2000); r.fix(102);
  close(r.controller.getPosition(1), vector(12, 2, 20)); r.controller.dispose();
});

test('stale data freezes even if browser timers are delayed and a fresh callback then arrives', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix();
  r.advance(20001); assert.equal(r.fix(2), false);
  assert.equal(r.controller.getStatus().phase, 'timeout');
  close(r.controller.getPosition(1), vector(10, 2, 20));
  r.start(); r.advance(20001);
  assert.equal(r.controller.getStatus().phase, 'timeout');
  assert.equal(r.controller.getStatus().needsReanchor, true); r.controller.dispose();
});

test('timers enforce startup timeout and old session timers cannot freeze a new session', () => {
  const r = rig(); r.start(); const old = [...r.timers.values()][0];
  r.start(); old.fn(); assert.equal(r.controller.getStatus().enabled, true);
  [...r.timers.values()][0].fn(); assert.equal(r.controller.getStatus().phase, 'timeout');
  r.controller.dispose(); assert.equal(r.timers.size, 0);
});

test('fresh but pre-reanchor fixes cannot become the origin of a new session', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start(); r.fix();
  r.advance(1000); r.start({ anchorPosition: vector(15, 2, 25) });
  assert.equal(r.fix(0, 0, { timestamp_ms: NOW + 500 }), false);
  assert.equal(r.controller.getStatus().phase, 'waiting');
  assert.equal(r.fix(100, 0), true);
  close(r.controller.getPosition(1), vector(15, 2, 25));
  r.advance(2000); r.fix(102, 0);
  close(r.controller.getPosition(1), vector(17, 2, 25)); r.controller.dispose();
});

test('background requires an explicit reanchor; stop releases translation and dispose removes listeners', () => {
  const r = rig(); r.start(); r.fix();
  r.doc.visibilityState = 'hidden'; r.emit('visibilitychange');
  assert.equal(r.controller.getStatus().phase, 'background'); assert.equal(r.start(), false);
  r.doc.visibilityState = 'visible'; r.emit('visibilitychange');
  assert.equal(r.controller.getStatus().enabled, false);
  r.advance(1000); assert.equal(r.fix(3), false);
  assert.equal(r.start(), true); r.fix(); r.emit('pagehide');
  assert.equal(r.controller.getStatus().needsReanchor, true);
  r.controller.stop('changed'); assert.equal(r.controller.getStatus().locked, false);
  assert.equal(r.controller.getPosition(1), null);
  r.controller.dispose(); assert.equal(r.listenerCount(), 0); assert.equal(r.timers.size, 0);
  assert.equal(r.start(), false);
});

test('denial is explicit and invalid scale or calibration cannot start tracking', () => {
  const r = rig();
  for (const worldUnitsPerMeter of [0, -1, NaN, 10001, '1']) assert.equal(r.start({ worldUnitsPerMeter }), false);
  for (const overrides of [{ headingDegrees: null }, { worldYaw: NaN }, { anchorPosition: vector(Infinity, 0, 0) }]) {
    assert.equal(r.start(overrides), false); assert.equal(r.controller.getStatus().locked, false);
  }
  r.start(); r.controller.fail({ code: 1 });
  assert.equal(r.controller.getStatus().phase, 'denied'); assert.equal(r.controller.getStatus().locked, false);
  r.start(); r.fix(); r.controller.fail({ code: 1 });
  assert.equal(r.controller.getStatus().locked, true); r.controller.dispose();
});

test('automatic timeout recovery anchors at the displayed position and preserves direction and scale', () => {
  const r = rig(); r.start({ automatic: true, worldUnitsPerMeter: 2, headingDegrees: 90 }); r.fix();
  r.advance(2000); r.fix(3, 0);
  const held = r.controller.getPosition(1 / 60);
  assert.ok(held.z < 20 && held.z > 14);
  r.advance(20001); assert.equal(r.fix(500, 0), false);
  assert.equal(r.controller.getStatus().phase, 'timeout');
  assert.equal(r.controller.getStatus().automatic, true);
  assert.equal(r.controller.getStatus().needsReanchor, false);
  close(r.controller.getPosition(1), held);
  r.advance(2000); assert.equal(r.fix(502, 0), true);
  close(r.controller.getPosition(1), held);
  r.advance(2000); assert.equal(r.fix(504, 0), true);
  for (let i = 0; i < 60; i++) r.controller.getPosition(1);
  close(r.controller.getPosition(), held.clone().add(vector(0, 0, -4)));
  r.controller.dispose();
});

test('automatic recovery requires distinct consistent accurate fixes and never applies a location jump', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start({ automatic: true }); r.fix();
  r.advance(1000); assert.equal(r.fix(100), false);
  assert.equal(r.controller.getStatus().phase, 'jump');
  const held = r.controller.getPosition();
  r.advance(1000); assert.equal(r.fix(100), false);
  assert.equal(r.fix(101), false); // Duplicate timestamp cannot count as stability.
  r.advance(1000); assert.equal(r.fix(1000), false); // A second jump resets stability.
  r.advance(1000); assert.equal(r.fix(1001, 0, { accuracy_m: 80 }), false);
  r.advance(1000); assert.equal(r.fix(1002), false); // Noisy fix reset the candidate.
  r.advance(500); assert.equal(r.fix(1002.5), false);
  close(r.controller.getPosition(1), held);
  r.advance(500); assert.equal(r.fix(1003), true);
  close(r.controller.getPosition(1), held);
  r.advance(2000); assert.equal(r.fix(1005), true);
  close(r.controller.getPosition(1), held.clone().add(vector(2, 0, 0)));
  r.controller.dispose();
});

test('automatic background recovery ignores cached fixes and movement while hidden', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start({ automatic: true }); r.fix();
  r.advance(1000); r.doc.visibilityState = 'hidden'; r.emit('visibilitychange');
  r.advance(1000); assert.equal(r.fix(100), false);
  r.doc.visibilityState = 'visible'; r.emit('visibilitychange');
  assert.equal(r.fix(100, 0, { timestamp_ms: NOW }), false);
  assert.equal(r.fix(100), false);
  r.advance(1000); r.doc.visibilityState = 'hidden'; r.emit('pagehide');
  r.doc.visibilityState = 'visible'; assert.equal(r.fix(101), false);
  r.advance(1000); assert.equal(r.fix(102), true);
  close(r.controller.getPosition(1), vector(10, 2, 20));
  r.controller.dispose();
});

test('automatic walking can recover from poor startup accuracy without a settings reset', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start({ automatic: true });
  r.fix(0, 0, { accuracy_m: 100 }); r.advance(20001);
  assert.equal(r.fix(100, 0, { accuracy_m: 100 }), false);
  assert.equal(r.controller.getStatus().phase, 'timeout');
  r.advance(1000); assert.equal(r.fix(100), false);
  r.advance(1000); assert.equal(r.fix(101), true);
  close(r.controller.getPosition(1), vector(10, 2, 20));
  assert.equal(r.controller.getStatus().phase, 'tracking'); r.controller.dispose();
});

test('denied permission and explicit stop end automatic recovery without retrying', () => {
  const r = rig(); r.start({ automatic: true }); r.fix();
  r.advance(20001); r.controller.getStatus(); r.controller.fail({ code: 1 });
  assert.equal(r.controller.getStatus().phase, 'denied');
  assert.equal(r.controller.getStatus().automatic, false);
  for (let i = 0; i < 3; i++) { r.advance(1000); assert.equal(r.fix(i), false); }
  r.start({ automatic: true }); r.fix(); r.controller.stop();
  assert.equal(r.controller.getStatus().automatic, false);
  for (let i = 0; i < 3; i++) { r.advance(1000); assert.equal(r.fix(i), false); }
  assert.equal(r.controller.getPosition(), null); r.controller.dispose();
});

test('longitude wrapping follows a short walk across the date line', () => {
  const r = rig({ smoothingSeconds: 0 }); r.start();
  r.fix(0, 0, { lon: 179.99999 }); r.advance(2000);
  r.fix(0, 0, { lon: -179.99999 });
  close(r.controller.getPosition(1), vector(10 + 0.00002 * DEGREE_METERS, 2, 20));
  r.controller.dispose();
});
