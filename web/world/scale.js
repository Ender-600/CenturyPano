import * as THREE from 'three';

const finitePoint = (point) => point && ['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis]));

/** A user-measured reference, not independent proof of the generated geometry. */
export function measureWorldUnitsPerMeter(pointA, pointB, realMeters) {
  if (!finitePoint(pointA) || !finitePoint(pointB) || !Number.isFinite(realMeters) || realMeters <= 0) {
    throw new Error('Enter the real distance between the two measurement points in meters.');
  }
  const distance = new THREE.Vector3().copy(pointA).distanceTo(pointB);
  if (distance < 0.0001 || !Number.isFinite(distance)) throw new Error('The measurement points are too close. Please select them again.');
  const worldUnitsPerMeter = distance / realMeters;
  if (worldUnitsPerMeter < 0.001 || worldUnitsPerMeter > 1000) throw new Error('The scale is out of range. Check the selected points and distance.');
  return { worldUnitsPerMeter, worldDistance: distance, realMeters, source: 'user_measured_reference' };
}

/** Spark implements THREE.Raycaster on the actual loaded splats, in world space. */
export function captureScalePoint(engine) {
  if (!engine?.camera || !engine.current) throw new Error('First load a generated 3D world.');
  engine.camera.updateMatrixWorld(true);
  engine.current.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  raycaster.near = Math.max(0.001, engine.camera.near || 0.001);
  raycaster.far = engine.camera.far || 2000;
  raycaster.setFromCamera(new THREE.Vector2(0, 0), engine.camera);
  const hit = raycaster.intersectObject(engine.current, true).find((item) => finitePoint(item.point)
    && Number.isFinite(item.distance) && item.distance >= raycaster.near && item.distance <= raycaster.far);
  if (!hit) throw new Error('No measurable surface at the crosshair. Aim at a building or the ground, then capture a point.');
  return hit.point.clone();
}

/** User-operated two-point picker; never measures or starts tracking on its own. */
export function createScaleCalibration({ getEngine, getSceneKey, onApply, onClose = () => {}, document: doc = document }) {
  let engine = null, sceneKey = null, points = [], markers = [], active = false;
  const overlay = doc.createElement('section');
  overlay.className = 'scale-calibration'; overlay.hidden = true;
  overlay.setAttribute('aria-label', 'Two-point scale calibration');
  const crosshair = doc.createElement('span'); crosshair.className = 'scale-crosshair'; crosshair.textContent = '+';
  crosshair.setAttribute('aria-hidden', 'true');
  const panel = doc.createElement('div'); panel.className = 'scale-panel';
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const pick = doc.createElement('button'); pick.type = 'button';
  const distanceLabel = doc.createElement('label'); distanceLabel.textContent = 'Real distance between points (meters)';
  const distance = doc.createElement('input'); distance.type = 'number'; distance.min = '0.001'; distance.step = 'any';
  distance.inputMode = 'decimal'; distanceLabel.append(distance);
  const apply = doc.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply measured scale';
  const reset = doc.createElement('button'); reset.type = 'button'; reset.textContent = 'Select points again';
  const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel measurement';
  panel.append(status, pick, distanceLabel, apply, reset, cancel); overlay.append(crosshair, panel);
  doc.getElementById('viewport').append(overlay);

  const clearMarkers = () => {
    for (const marker of markers) { marker.removeFromParent(); marker.geometry.dispose(); marker.material.dispose(); }
    markers = [];
  };
  const close = (notify = true) => {
    active = false; overlay.hidden = true; clearMarkers(); points = []; engine = null; sceneKey = null;
    if (notify) onClose();
  };
  const assertScene = () => {
    if (!active || engine !== getEngine() || sceneKey !== getSceneKey()) {
      close(false); throw new Error('The scene changed. Please restart the measurement.');
    }
  };
  const resetPoints = () => {
    clearMarkers(); points = []; distance.value = '';
    pick.hidden = false; pick.textContent = 'Capture first point'; distanceLabel.hidden = apply.hidden = true;
    status.textContent = 'Drag the view to aim the crosshair at one end of a known distance, then capture the first point. Stand still while measuring.';
  };
  pick.addEventListener('click', () => {
    try {
      assertScene();
      const point = captureScalePoint(engine);
      if (points.length && points[0].distanceTo(point) < 0.0001) throw new Error('Move the crosshair to the other end, then capture the second point.');
      points.push(point);
      const radius = Math.max(0.002, point.distanceTo(engine.camera.position) * 0.006);
      const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xe4b85f, depthTest: false, depthWrite: false }));
      marker.position.copy(point); marker.renderOrder = 1000; engine.scene.add(marker); markers.push(marker);
      if (points.length === 1) {
        pick.textContent = 'Capture second point';
        status.textContent = 'First point captured. Drag the view to aim the crosshair at the other end of the same reference.';
      } else {
        pick.hidden = true; distanceLabel.hidden = apply.hidden = false;
        status.textContent = `Distance between model points: ${points[0].distanceTo(points[1]).toFixed(3)} units. Enter the measured or known real distance.`;
        distance.focus();
      }
    } catch (error) { status.textContent = error.message; }
  });
  apply.addEventListener('click', () => {
    try {
      assertScene();
      const result = measureWorldUnitsPerMeter(points[0], points[1], Number(distance.value));
      onApply(result); close();
    } catch (error) { status.textContent = error.message; }
  });
  reset.addEventListener('click', resetPoints);
  cancel.addEventListener('click', () => close());
  return {
    start() {
      close(false); engine = getEngine(); sceneKey = getSceneKey();
      if (!engine?.current) throw new Error('First load a generated 3D world.');
      active = true; resetPoints(); overlay.hidden = false;
    },
    cancel: close,
    isActive: () => active,
    dispose() { close(false); overlay.remove(); },
  };
}
