import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { panoramaPoint, projectHotspot } from '../web/world/hotspots.js';
import {
  cameraBearing, createPanoramaMesh, normalizeHeading, panoramaHeading,
  PanoramaLookControls, setCameraBearing,
} from '../web/world/panorama.js';

const near = (actual, expected, tolerance = 1e-5) => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be near ${expected}`);
};
const headingNear = (actual, expected) => near(((actual - expected + 540) % 360) - 180, 0);

class Element {
  constructor() {
    this.clientHeight = 600;
    this.listeners = new Map();
    this.captured = [];
    this.focused = [];
  }
  addEventListener(name, callback, options) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Map());
    this.listeners.get(name).set(callback, options);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  setPointerCapture(pointerId) { this.captured.push(pointerId); }
  focus(options) { this.focused.push(options); }
  emit(name, values = {}) {
    const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const callback of this.listeners.get(name)?.keys() || []) callback(event);
    return event;
  }
  get listenerCount() {
    return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0);
  }
}

function viewer(t, { heading = 0, pitch = 0, fov = 60 } = {}) {
  const camera = new THREE.PerspectiveCamera(fov, 2 / 3, 0.1, 100);
  camera.position.set(3, 1.6, -7);
  setCameraBearing(camera, heading, pitch);
  const element = new Element(), calls = { manual: 0, change: 0 };
  const controls = new PanoramaLookControls(camera, element, {
    onManualInteraction: () => calls.manual++, onChange: () => calls.change++,
  });
  controls.enabled = true;
  t.after(() => controls.dispose());
  return { camera, element, controls, calls };
}

// Inspect the real Three.js vertex/UV mapping rather than repeating the
// renderer's rotation formula: this catches a 180-degree offset or mirror.
function directionAtUV(mesh, u, v) {
  const uv = mesh.geometry.getAttribute('uv'), positions = mesh.geometry.getAttribute('position');
  let best = -1, error = Infinity;
  for (let index = 0; index < uv.count; index++) {
    const distance = Math.hypot(uv.getX(index) - u, uv.getY(index) - v);
    if (distance < error) { best = index; error = distance; }
  }
  assert.ok(error < 1e-6, `sphere should contain requested UV ${u}, ${v}`);
  mesh.updateMatrixWorld(true);
  return new THREE.Vector3().fromBufferAttribute(positions, best)
    .transformDirection(mesh.matrixWorld);
}

const compassOf = (direction) => normalizeHeading(THREE.MathUtils.radToDeg(Math.atan2(direction.x, -direction.z)));
function disposeMesh(mesh) {
  mesh.material.map.dispose(); mesh.material.dispose(); mesh.geometry.dispose();
}

test('source panorama centre faces its heading, pixels to the right turn clockwise, and image top stays up', (t) => {
  const sourceHeading = 264.05194;
  const mesh = createPanoramaMesh({ naturalWidth: 3328, naturalHeight: 1664 }, { heading: sourceHeading });
  t.after(() => disposeMesh(mesh));
  headingNear(compassOf(directionAtUV(mesh, 0.5, 0.5)), sourceHeading);
  headingNear(compassOf(directionAtUV(mesh, 0.75, 0.5)), sourceHeading + 90);
  headingNear(compassOf(directionAtUV(mesh, 0.25, 0.5)), sourceHeading - 90);
  headingNear(compassOf(directionAtUV(mesh, 0, 0.5)), sourceHeading + 180);
  assert.equal(mesh.material.map.flipY, true, 'HTML image top must map to texture v=1');
  const upper = directionAtUV(mesh, 0.5, 0.75), lower = directionAtUV(mesh, 0.5, 0.25);
  near(upper.y, Math.SQRT1_2); near(lower.y, -Math.SQRT1_2);
  headingNear(compassOf(upper), sourceHeading);
  near(directionAtUV(mesh, 0.5, 0.5).y, 0);
});

test('white dot directions match actual sphere UVs across the seam, elevations and source headings', (t) => {
  for (const heading of [0, 91, 264.05194]) {
    const mesh = createPanoramaMesh({ width: 2048, height: 1024 }, { heading });
    t.after(() => disposeMesh(mesh));
    for (const [x, y] of [[0, .5], [1, .5], [.25, .25], [.5, .5], [.75, .75]]) {
      const expected = directionAtUV(mesh, x, 1 - y);
      assert.ok(panoramaPoint([x, y], { heading }).normalize().distanceTo(expected) < 1e-6);
    }
  }
});

test('white dots follow camera yaw, pitch, roll and zoom and hide behind the camera', () => {
  const camera = new THREE.PerspectiveCamera(65, 2, .05, 2000);
  setCameraBearing(camera, 90, 30); camera.rotateZ(.35); camera.updateMatrixWorld(true);
  const centre = panoramaPoint([.5, 1 / 3], { heading: 90 });
  let dot = projectHotspot(centre, camera);
  near(dot.x, 50); near(dot.y, 50);
  assert.equal(projectHotspot(centre.clone().negate(), camera), null);
  const right = new THREE.Vector3(5, 0, -50).applyQuaternion(camera.quaternion);
  dot = projectHotspot(right, camera); assert.ok(dot.x > 50); near(dot.y, 50);
  camera.fov = 35; camera.updateProjectionMatrix();
  assert.ok(projectHotspot(right, camera).x > dot.x);
  setCameraBearing(camera, 270); camera.updateMatrixWorld(true);
  assert.equal(projectHotspot(centre, camera), null);
});

test('missing or nonnumeric source heading defaults to north; valid headings wrap', (t) => {
  for (const metadata of [undefined, {}, { heading: null }, { heading: '264' }, { heading: NaN }, { heading: Infinity }]) {
    assert.equal(panoramaHeading(metadata), 0);
    const mesh = createPanoramaMesh({ width: 2000, height: 1000 }, metadata);
    t.after(() => disposeMesh(mesh));
    headingNear(compassOf(directionAtUV(mesh, 0.5, 0.5)), 0);
  }
  assert.equal(panoramaHeading({ heading: 720 + 24 }), 24);
  assert.equal(panoramaHeading({ heading: -96 }), 264);
});

test('flat or incomplete images are rejected instead of being stretched into a panorama', () => {
  for (const image of [{ width: 1920, height: 1080 }, { width: 1000, height: 1000 }, { width: 0, height: 0 }, {}]) {
    assert.throws(() => createPanoramaMesh(image), /2:1/);
  }
});

test('camera bearing agrees with cardinal world directions, wraps heading, and bounds elevation', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 1.6, -7);
  for (const [heading, vector] of [[0, [0, 0, -1]], [90, [1, 0, 0]], [180, [0, 0, 1]], [270, [-1, 0, 0]]]) {
    setCameraBearing(camera, heading);
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(...vector)) < 1e-9);
  }
  for (const [heading, pitch, expectedHeading, expectedPitch] of [
    [264.05194, 30, 264.05194, 30], [721, -30, 1, -30], [-2, 0, 358, 0],
    [355, 100, 355, 85], [5, -100, 5, -85],
  ]) {
    setCameraBearing(camera, heading, pitch);
    const bearing = cameraBearing(camera);
    headingNear(bearing.heading, expectedHeading); near(bearing.pitch, expectedPitch);
  }
  assert.deepEqual(camera.position.toArray(), [3, 1.6, -7]);
});

test('dragging changes only camera direction, follows the panorama, and clamps vertical look', (t) => {
  const { camera, element, calls } = viewer(t, { heading: 10 });
  assert.ok(element.emit('pointerdown', { clientX: 100, clientY: 100 }).defaultPrevented);
  element.emit('pointermove', { clientX: 200, clientY: 150 });
  headingNear(cameraBearing(camera).heading, 0); near(cameraBearing(camera).pitch, 5);
  element.emit('pointermove', { clientX: 200, clientY: 3000 });
  near(cameraBearing(camera).pitch, 85);
  element.emit('pointermove', { clientX: 200, clientY: -3000 });
  near(cameraBearing(camera).pitch, -85);
  assert.deepEqual(camera.position.toArray(), [3, 1.6, -7]);
  assert.equal(calls.manual, 1); assert.equal(calls.change, 3);
  assert.deepEqual(element.captured, [1]);
  assert.deepEqual(element.focused, [{ preventScroll: true }]);
});

test('arrow keys rotate across north and elevate the view without moving the camera', (t) => {
  const { camera, element, calls } = viewer(t, { heading: 358, pitch: 83 });
  assert.ok(element.emit('keydown', { key: 'ArrowRight' }).defaultPrevented);
  headingNear(cameraBearing(camera).heading, 2);
  element.emit('keydown', { key: 'ArrowUp' }); near(cameraBearing(camera).pitch, 85);
  element.emit('keydown', { key: 'ArrowLeft' }); headingNear(cameraBearing(camera).heading, 358);
  element.emit('keydown', { key: 'ArrowDown' }); near(cameraBearing(camera).pitch, 81);
  assert.equal(element.emit('keydown', { key: 'w' }).defaultPrevented, false);
  assert.deepEqual(camera.position.toArray(), [3, 1.6, -7]);
  assert.equal(calls.manual, 4); assert.equal(calls.change, 4);
});

test('wheel zoom changes perspective projection and stays within a usable field of view', (t) => {
  const { camera, element } = viewer(t, { heading: 264, pitch: 20 });
  const projection = camera.projectionMatrix.clone(), rotation = camera.quaternion.clone();
  assert.ok(element.emit('wheel', { deltaY: -500 }).defaultPrevented);
  near(camera.fov, 45);
  assert.equal(camera.projectionMatrix.equals(projection), false);
  element.emit('wheel', { deltaY: -10000 }); near(camera.fov, 35);
  element.emit('wheel', { deltaY: 10000 }); near(camera.fov, 90);
  assert.ok(camera.quaternion.equals(rotation));
  assert.deepEqual(camera.position.toArray(), [3, 1.6, -7]);
  const [options] = element.listeners.get('wheel').values();
  assert.equal(options.passive, false);
});

test('two-finger pinch zooms without rotating, including limits, then returns to single-finger look', (t) => {
  const { camera, element, controls, calls } = viewer(t, { heading: 264, pitch: 20, fov: 80 });
  const rotation = camera.quaternion.clone(), projection = camera.projectionMatrix.clone();
  element.emit('pointerdown', { pointerId: 1, clientX: 100 });
  element.emit('pointerdown', { pointerId: 2, clientX: 200 });
  element.emit('pointermove', { pointerId: 2, clientX: 260 }); near(camera.fov, 50);
  assert.ok(camera.quaternion.equals(rotation));
  assert.equal(camera.projectionMatrix.equals(projection), false);
  element.emit('pointermove', { pointerId: 2, clientX: 140 }); near(camera.fov, 90);
  element.emit('pointermove', { pointerId: 2, clientX: 900 }); near(camera.fov, 35);
  element.emit('pointerup', { pointerId: 2 });
  assert.equal(controls.pointers.size, 1);
  element.emit('pointermove', { pointerId: 1, clientX: 160 });
  headingNear(cameraBearing(camera).heading, 260.5);
  assert.deepEqual(camera.position.toArray(), [3, 1.6, -7]);
  assert.equal(calls.manual, 2);
});

test('released and cancelled pointers cannot keep dragging the scene', (t) => {
  const { camera, element, controls } = viewer(t);
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    element.emit('pointerdown', { clientX: 100 });
    element.emit(eventName);
    assert.equal(controls.pointers.size, 0);
    const rotation = camera.quaternion.clone();
    element.emit('pointermove', { clientX: 900 });
    assert.ok(camera.quaternion.equals(rotation));
  }
});

test('disabled controls and secondary mouse buttons leave the scene and browser events alone', (t) => {
  const { camera, element, controls, calls } = viewer(t);
  controls.enabled = false;
  const rotation = camera.quaternion.clone(), projection = camera.projectionMatrix.clone();
  for (const [type, event] of [
    ['pointerdown', { clientX: 100 }], ['pointermove', { clientX: 200 }],
    ['wheel', { deltaY: 1000 }], ['keydown', { key: 'ArrowLeft' }],
  ]) assert.equal(element.emit(type, event).defaultPrevented, false);
  controls.enabled = true;
  assert.equal(element.emit('pointerdown', { button: 2 }).defaultPrevented, false);
  assert.equal(controls.pointers.size, 0);
  assert.ok(camera.quaternion.equals(rotation));
  assert.ok(camera.projectionMatrix.equals(projection));
  assert.deepEqual(calls, { manual: 0, change: 0 });
  assert.deepEqual(element.captured, []);
});

test('disposing active controls clears pointer state and removes every event listener', (t) => {
  const { camera, element, controls } = viewer(t);
  element.emit('pointerdown', { clientX: 100 });
  assert.ok(element.listenerCount > 0);
  assert.equal(controls.pointers.size, 1);
  controls.dispose();
  assert.equal(controls.pointers.size, 0);
  assert.equal(element.listenerCount, 0);
  const rotation = camera.quaternion.clone();
  element.emit('pointermove', { clientX: 200 });
  element.emit('keydown', { key: 'ArrowRight' });
  element.emit('wheel', { deltaY: 1000 });
  assert.ok(camera.quaternion.equals(rotation)); near(camera.fov, 60);
});
