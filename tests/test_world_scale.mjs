import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { captureScalePoint, measureWorldUnitsPerMeter, createScaleCalibration } from '../web/world/scale.js';

test('a known two-meter span sets units per real meter, independent of rotation', () => {
  const a = new THREE.Vector3(1, 2, 3), b = new THREE.Vector3(7, 2, 3);
  const result = measureWorldUnitsPerMeter(a, b, 2);
  assert.equal(result.worldUnitsPerMeter, 3);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.7, -0.8));
  const moved = measureWorldUnitsPerMeter(a.clone().applyQuaternion(rotation), b.clone().applyQuaternion(rotation), 2);
  assert.ok(Math.abs(moved.worldUnitsPerMeter - 3) < 1e-10);
  assert.equal(result.source, 'user_measured_reference');
});

test('calibration rejects absent points, coincident points, invalid distance and extreme scale', () => {
  const a = new THREE.Vector3(), b = new THREE.Vector3(1, 0, 0);
  for (const meters of [0, -1, NaN, Infinity, 0.00001, 1000000]) {
    assert.throws(() => measureWorldUnitsPerMeter(a, b, meters));
  }
  assert.throws(() => measureWorldUnitsPerMeter(a, a, 1));
  assert.throws(() => measureWorldUnitsPerMeter(undefined, b, 1));
});

test('center picking returns real transformed scene coordinates, not distance along view', () => {
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 100);
  const group = new THREE.Group(); group.position.set(3, 0, -10); group.scale.setScalar(2);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial()); group.add(mesh);
  camera.position.set(3, 0, 0);
  const first = captureScalePoint({ camera, current: group });
  assert.ok(first.distanceTo(new THREE.Vector3(3, 0, -10)) < 1e-8);
  camera.position.x = 5;
  const second = captureScalePoint({ camera, current: group });
  assert.ok(second.distanceTo(new THREE.Vector3(5, 0, -10)) < 1e-8);
  assert.equal(measureWorldUnitsPerMeter(first, second, 2).worldUnitsPerMeter, 1);
  mesh.geometry.dispose(); mesh.material.dispose();
});

test('no surface in the scene fails explicitly rather than inventing a calibration depth', () => {
  const camera = new THREE.PerspectiveCamera();
  assert.throws(() => captureScalePoint({ camera, current: new THREE.Group() }), /surface/);
});

function calibrationUI() {
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.value = ''; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(name, callback) { this.handlers[name] = callback; }
    click() { this.handlers.click?.(); }
    focus() {}
    remove() {}
  }
  const viewport = new Element(), applied = [];
  const document = { createElement: () => new Element(), getElementById: () => viewport };
  const camera = new THREE.PerspectiveCamera(65, 1, .05, 100), scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
  mesh.position.z = -10; scene.add(mesh);
  const engine = { camera, scene, current: mesh };
  let sceneKey = 1, closed = 0;
  const ui = createScaleCalibration({ getEngine: () => engine, getSceneKey: () => sceneKey,
    onApply: (value) => applied.push(value), onClose: () => { closed++; }, document });
  const overlay = viewport.children[0], panel = overlay.children[1];
  const [status, pick, distanceLabel, apply, reset, cancel] = panel.children;
  return { ui, engine, overlay, status, pick, distance: distanceLabel.children[0], apply, reset, cancel, applied,
    closed: () => closed, changeScene: () => { sceneKey++; } };
}

test('two-point interaction applies measured scale and removes temporary markers', () => {
  const view = calibrationUI();
  assert.equal(view.overlay.hidden, true); assert.equal(view.engine.scene.children.length, 1);
  view.ui.start(); view.pick.click();
  assert.equal(view.engine.scene.children.length, 2);
  view.engine.camera.position.x = 3; view.pick.click();
  view.distance.value = '1.5'; view.apply.click();
  assert.equal(view.applied[0].worldUnitsPerMeter, 2);
  assert.equal(view.closed(), 1); assert.equal(view.ui.isActive(), false);
  assert.equal(view.engine.scene.children.length, 1);
});

test('invalid input remains editable and a changed scene cancels old calibration', () => {
  const view = calibrationUI(); view.ui.start(); view.pick.click();
  view.engine.camera.position.x = 2; view.pick.click();
  view.distance.value = '0'; view.apply.click();
  assert.equal(view.applied.length, 0); assert.equal(view.ui.isActive(), true);
  assert.match(view.status.textContent, /real distance/);
  view.changeScene(); view.distance.value = '2'; view.apply.click();
  assert.equal(view.applied.length, 0); assert.equal(view.ui.isActive(), false);
  assert.equal(view.engine.scene.children.length, 1);
  assert.equal(view.closed(), 0);
});
