import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createMotionController, createPoseAnchor, transformPose, validateMotionPacket } from '../web/world/motion.js';

const SESSION = 'native-session-unit-test-001';
const vector = (...values) => new THREE.Vector3(...values);
const rotation = (yaw = 0, pitch = 0, roll = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
const close = (a, b) => assert.ok(a.distanceTo(b) < 1e-9, `${a.toArray()} != ${b.toArray()}`);
const sameRotation = (a, b) => assert.ok(1 - Math.abs(a.dot(b)) < 1e-9);
function packet(overrides = {}) {
  return { version: 1, sessionId: SESSION, sequence: 1, timestampMs: 1800000000000,
    state: 'tracking', position: [0, 1.6, 0], quaternion: [0, 0, 0, 1], ...overrides };
}
function rig(options = {}) {
  let clock = 1800000000000, counter = 0, sessionCounter = 0;
  const events = new Map(), timers = new Map(), sent = [], changes = [];
  const addEventListener = (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); };
  const removeEventListener = (name, fn) => events.get(name)?.delete(fn);
  const win = { addEventListener, removeEventListener,
    setTimeout(fn, delay) { timers.set(++counter, { fn, delay }); return counter; }, clearTimeout(id) { timers.delete(id); },
    CenturyMotion: options.noBridge ? undefined : { version: 1, platform: 'ios', postMessage(json) { sent.push(JSON.parse(json)); } } };
  const doc = { visibilityState: 'visible', addEventListener, removeEventListener };
  const controller = createMotionController({ window: win, document: doc, now: () => clock,
    sessionIdFactory: () => `${SESSION}-${++sessionCounter}`, onChange: (status) => changes.push(status), ...options });
  const sessionId = () => sent.findLast((message) => message.action === 'start')?.sessionId;
  return { controller, sent, changes, timers, doc,
    start(overrides = {}) { return controller.start({ worldUnitsPerMeter: 1, anchorPosition: vector(10, 2, 20), anchorQuaternion: rotation(), ...overrides }); },
    send(overrides = {}) { const detail = packet({ sessionId: sessionId(), timestampMs: clock, ...overrides }); for (const fn of events.get('century:motion') || []) fn({ detail }); },
    advance(ms) { clock += ms; },
    fireTimeout() { const current = [...timers.values()].at(-1); current?.fn(); },
    emit(name) { for (const fn of events.get(name) || []) fn(); },
    listenerCount() { return [...events.values()].reduce((n, set) => n + set.size, 0); },
  };
}

test('in-place rotation changes orientation without moving the position', () => {
  const native = { position: vector(5, 1.6, -4), quaternion: rotation() };
  const view = { position: vector(10, 20, 30), quaternion: rotation(-Math.PI / 2) };
  const anchor = createPoseAnchor(native, view, 2);
  for (const angle of [0, .2, Math.PI / 2, Math.PI]) {
    const result = transformPose({ position: native.position, quaternion: rotation(angle) }, anchor);
    close(result.position, view.position);
    sameRotation(result.quaternion, anchor.yaw.clone().multiply(rotation(angle)));
  }
});

test('one meter forward maps to calibrated world units under yaw-only anchoring', () => {
  const native = { position: vector(5, 1.6, -4), quaternion: rotation() };
  const view = { position: vector(10, 20, 30), quaternion: rotation(-Math.PI / 2) };
  const anchor = createPoseAnchor(native, view, 2);
  const result = transformPose({ position: vector(5, 1.6, -5), quaternion: rotation() }, anchor);
  close(result.position, vector(12, 20, 30));
});

test('walking while looking sideways does not rotate the translation direction', () => {
  const origin = { position: vector(0, 1.6, 0), quaternion: rotation() };
  const anchor = createPoseAnchor(origin, { position: vector(0, 0, 0), quaternion: rotation() }, 1);
  const forward = transformPose({ position: vector(0, 1.6, -1), quaternion: rotation(-Math.PI / 2) }, anchor);
  close(forward.position, vector(0, 0, -1));
  close(vector(0, 0, -1).applyQuaternion(forward.quaternion), vector(1, 0, 0));
});

test('anchor preserves gravity and native pitch and roll without imposing virtual pitch', () => {
  const physical = { position: vector(0, 1.6, 0), quaternion: rotation(.3, .2, -.1) };
  const virtual = { position: vector(0, 0, 0), quaternion: rotation(-.7, -.4, .4) };
  const anchor = createPoseAnchor(physical, virtual, 1);
  close(vector(0, 1, 0).applyQuaternion(anchor.yaw), vector(0, 1, 0));
  sameRotation(transformPose(physical, anchor).quaternion, anchor.yaw.clone().multiply(physical.quaternion));
  assert.equal(createPoseAnchor(physical, virtual, 0), null);
  assert.equal(createPoseAnchor(physical, virtual, NaN), null);
});

test('packet validation rejects wrong session, replays, old/future clocks and invalid poses', () => {
  const checks = { sessionId: SESSION, sequence: 0, timestampMs: 1799999999990, now: 1800000000000 };
  assert.ok(validateMotionPacket(packet(), checks));
  for (const bad of [{ version: 2 }, { sessionId: 'wrong-session-name' }, { sequence: 0 }, { sequence: 1.5 },
    { timestampMs: 1799999998000 }, { timestampMs: 1800000001000 }, { quaternion: [0, 0, 0, 0] },
    { quaternion: [0, 0, 0, 2] }, { position: [NaN, 0, 0] }, { position: [0, 0] }, { state: 'imagined' }]) {
    assert.equal(validateMotionPacket(packet(bad), checks), null, JSON.stringify(bad));
  }
});

test('ordinary browser cannot start native tracking and construction sends no commands', () => {
  const view = rig({ noBridge: true });
  assert.equal(view.sent.length, 0);
  assert.equal(view.start(), false);
  assert.equal(view.controller.getStatus().locked, false);
  assert.match(view.controller.getStatus().message, /native app/);
  view.controller.dispose();
});

test('controller starts explicitly, waits for reliable first pose then moves one meter', () => {
  const view = rig();
  assert.equal(view.sent.length, 0);
  assert.equal(view.start(), true);
  assert.equal(view.controller.getStatus().phase, 'waiting');
  view.send({ state: 'limited' });
  assert.equal(view.controller.getPose(), null);
  view.send({ sequence: 2 });
  close(view.controller.getPose().position, vector(10, 2, 20));
  for (let i = 1; i <= 10; i++) { view.advance(100); view.send({ sequence: i + 2, position: [0, 1.6, -i / 10] }); }
  close(view.controller.getPose().position, vector(10, 2, 19));
  assert.equal(view.sent.filter((message) => message.action === 'start').length, 1);
  view.controller.dispose();
});

test('tracking loss freezes, ignores recovered packets, and requires a new explicit anchor', () => {
  const view = rig(); view.start(); view.send();
  const previousSession = view.sent[0].sessionId;
  view.send({ sequence: 2, state: 'limited' });
  assert.equal(view.controller.getStatus().needsReanchor, true);
  assert.equal(view.controller.getStatus().locked, true);
  assert.equal(view.sent.at(-1).action, 'stop');
  view.send({ sequence: 3, position: [3, 1.6, 0] });
  close(view.controller.getPose().position, vector(10, 2, 20));
  view.start({ anchorPosition: vector(10, 2, 20) });
  assert.notEqual(view.sent.at(-1).sessionId, previousSession);
  view.send({ sequence: 1, position: [20, 3, -30] });
  close(view.controller.getPose().position, vector(10, 2, 20));
  view.controller.dispose();
});

test('stale data and timer timeout freeze rather than extrapolating movement', () => {
  const view = rig(); view.start(); view.send(); view.advance(1001);
  assert.equal(view.controller.getPose().position.z, 20);
  assert.equal(view.controller.getStatus().phase, 'timeout');
  assert.equal(view.sent.at(-1).action, 'stop');
  view.start(); view.fireTimeout();
  assert.equal(view.controller.getStatus().phase, 'timeout');
  assert.equal(view.controller.getPose(), null);
  view.controller.dispose();
});

test('background stops camera and never automatically resumes or applies hidden poses', () => {
  const view = rig(); view.start(); view.send();
  view.doc.visibilityState = 'hidden'; view.emit('visibilitychange');
  assert.equal(view.controller.getStatus().phase, 'background');
  view.send({ sequence: 2, position: [1, 1.6, 0] });
  close(view.controller.getPose().position, vector(10, 2, 20));
  view.doc.visibilityState = 'visible'; view.emit('visibilitychange');
  assert.equal(view.sent.filter((message) => message.action === 'start').length, 1);
  assert.equal(view.controller.getStatus().needsReanchor, true);
  view.controller.dispose(); assert.equal(view.listenerCount(), 0);
});

test('relocalization jump freezes and out-of-order packets never replace current pose', () => {
  const view = rig(); view.start(); view.send();
  view.send({ sequence: 1, position: [5, 1.6, 0] });
  assert.equal(view.controller.getStatus().phase, 'tracking');
  view.send({ sequence: 2, position: [5, 1.6, 0] });
  assert.equal(view.controller.getStatus().phase, 'lost');
  close(view.controller.getPose().position, vector(10, 2, 20));
  view.controller.dispose();
});

test('camera denied and unsupported are explicit, stop unlocks manual controls', () => {
  const view = rig(); view.start(); view.send({ state: 'denied' });
  assert.equal(view.controller.getStatus().phase, 'denied');
  assert.equal(view.controller.getStatus().locked, false);
  view.start(); view.send(); view.controller.stop('changed');
  assert.equal(view.controller.getStatus().locked, false);
  assert.equal(view.controller.getPose(), null);
  assert.match(view.controller.getStatus().message, /world changed/);
  view.controller.dispose();
});
