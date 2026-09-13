import * as THREE from 'three';
import { panoramaHeading } from './panorama.js';

// Image coordinates start at the top left; the sphere's texture UVs start at the bottom left.
export function panoramaPoint(point, metadata = {}) {
  const bearing = ((point[0] - 0.5) * 360 + panoramaHeading(metadata)) * Math.PI / 180;
  const pitch = (0.5 - point[1]) * Math.PI;
  return new THREE.Vector3(Math.sin(bearing) * Math.cos(pitch), Math.sin(pitch),
    -Math.cos(bearing) * Math.cos(pitch)).multiplyScalar(50);
}

export function projectHotspot(position, camera) {
  const view = position.clone().applyMatrix4(camera.matrixWorldInverse);
  if (view.z >= 0) return null;
  view.applyMatrix4(camera.projectionMatrix);
  if (Math.abs(view.x) > 1 || Math.abs(view.y) > 1 || Math.abs(view.z) > 1) return null;
  return { x: (view.x + 1) * 50, y: (1 - view.y) * 50 };
}

export function createPanoramaHotspots({ document, api, schedule = setTimeout, cancel = clearTimeout }) {
  const $ = (id) => document.getElementById(id);
  const layer = $('street-hotspot-layer'), card = $('street-hotspot-card'), hint = $('street-hotspot-hint');
  let scene = null, epoch = 0, request = null, explanation = null, timer = null, dots = [], revision = '', active = null;
  let retryable = false;

  function close() {
    explanation?.abort(); explanation = null; active = null; card.hidden = true;
    for (const dot of dots) dot.button.setAttribute('aria-pressed', 'false');
  }
  function clear() {
    ++epoch; request?.abort(); request = null; cancel(timer); timer = null; close();
    scene = null; dots = []; revision = ''; retryable = false;
    layer.replaceChildren(); layer.hidden = true; hint.hidden = true; hint.disabled = true;
  }
  async function explain(item, button) {
    if (!scene) return;
    close(); active = item.id; button.setAttribute('aria-pressed', 'true');
    const generation = epoch, currentRevision = item.revision || revision;
    const controller = new AbortController(); explanation = controller;
    card.hidden = false;
    $('street-hotspot-kicker').textContent = `Around ${scene.year}`;
    $('street-hotspot-title').textContent = item.label;
    $('street-hotspot-body').textContent = 'Asking the historian about this region…';
    $('street-hotspot-note').hidden = true;
    try {
      const data = await api(`/world-jobs/${scene.jobId}/explain`, { method: 'POST',
        body: { hotspot_id: item.id, revision: currentRevision }, signal: controller.signal });
      if (generation !== epoch || controller.signal.aborted || active !== item.id) return;
      $('street-hotspot-title').textContent = data.label || item.label;
      const body = $('street-hotspot-body'); body.replaceChildren();
      for (const [key, label] of [['distinctive', 'Look closely'], ['significance', 'Why it matters'], ['past', 'Then'], ['present', 'Now']]) {
        if (typeof data[key] !== 'string' || !data[key].trim()) continue;
        const section = document.createElement('p'), title = document.createElement('strong'), prose = document.createElement('span');
        title.textContent = label; prose.textContent = data[key]; section.append(title, prose); body.append(section);
      }
      const note = $('street-hotspot-note');
      note.textContent = typeof data.uncertainty === 'string' ? data.uncertainty : '';
      note.hidden = !note.textContent;
    } catch (error) {
      if (generation !== epoch || controller.signal.aborted) return;
      $('street-hotspot-body').textContent = error.message || 'Could not reach the explanation service. Tap the dot to retry.';
    }
  }
  async function load(generation, method) {
    const controller = new AbortController(); request = controller;
    if (method === 'POST') {
      retryable = false; hint.disabled = true; hint.hidden = false;
      hint.textContent = 'Finding street details…';
    }
    try {
      const data = await api(`/world-jobs/${scene.jobId}/hotspots`, { method, signal: controller.signal });
      if (generation !== epoch || controller.signal.aborted) return;
      if (revision !== data.revision) {
        const items = !data.fallback && Array.isArray(data.items) ? data.items : [];
        const previous = new Map(dots.map((dot) => [dot.item.id, dot]));
        const selected = previous.get(active)?.item, nextSelected = items.find((item) => item.id === active);
        if (active && JSON.stringify(selected) !== JSON.stringify(nextSelected)) close();
        revision = data.revision; dots = [];
        for (const item of items) {
          if (!Array.isArray(item.point) || item.point.length !== 2
              || !item.point.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) continue;
          let dot = previous.get(item.id);
          if (!dot) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'street-hotspot';
            const label = document.createElement('span'); button.append(label);
            dot = { button, label, item };
            button.addEventListener('click', () => { void explain(dot.item, button); });
          }
          dot.item = item; dot.position = panoramaPoint(item.point, scene.metadata);
          dot.label.textContent = item.label;
          dot.button.setAttribute('aria-label', `Ask about ${item.label}`);
          dot.button.setAttribute('aria-pressed', String(active === item.id));
          dot.button.hidden = true; dots.push(dot);
        }
        layer.replaceChildren(...dots.map((dot) => dot.button));
      }
      layer.hidden = !dots.length; hint.hidden = false;
      const pending = data.provisional || data.status === 'detecting';
      const progress = data.progress;
      const progressLabel = Number.isInteger(progress?.completed) && Number.isInteger(progress?.total)
        && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total
        ? ` (${progress.completed}/${progress.total})` : '';
      retryable = !pending && (data.retryable === true || data.fallback === true);
      hint.disabled = !retryable;
      hint.textContent = pending ? `Finding street details…${progressLabel}`
        : data.status === 'partial' ? 'Some details are ready. Tap to retry the rest.'
          : data.status === 'error' || data.fallback ? 'Could not identify street details. Tap to retry.'
            : !dots.length ? 'No clear objects found. Tap to try again.'
              : 'Tap a white dot to ask about that place.';
      update();
      if (pending) timer = schedule(() => { void load(generation, 'GET'); }, 1500);
    } catch (error) {
      if (generation !== epoch || controller.signal.aborted) return;
      retryable = true; hint.disabled = false; hint.hidden = false;
      hint.textContent = 'White dots are unavailable. Tap here to retry.';
    }
  }
  function setScene(next) {
    if (scene?.key === next?.key) return;
    clear();
    if (!next) return;
    scene = next; void load(epoch, 'POST');
  }
  function update() {
    if (!scene) return;
    scene.camera.updateMatrixWorld(true);
    for (const { button, position } of dots) {
      const projected = projectHotspot(position, scene.camera); button.hidden = !projected;
      if (projected) { button.style.left = `${projected.x}%`; button.style.top = `${projected.y}%`; }
    }
  }
  $('street-hotspot-close').addEventListener('click', close);
  card.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  hint.addEventListener('click', () => {
    if (!scene || !retryable) return;
    request?.abort(); cancel(timer); void load(epoch, 'POST');
  });
  clear();
  return { setScene, update, clear };
}
