import { createYearWheel } from './world/year-wheel.js';

const MODES = ['camera', 'photo', 'streetview', 'world'];
export function modeFromURL(search = '') {
  const query = new URLSearchParams(search);
  if (MODES.includes(query.get('mode'))) return query.get('mode');
  if (/^[a-f0-9]{32}$/.test(query.get('world') || '')) return 'world';
  if (/^[a-zA-Z0-9_-]{1,100}$/.test(query.get('replay') || '')) return 'photo';
  return 'camera';
}

/** The viewers keep their own jobs and canvases; tab changes only change visibility. */
export function createModeHost({ window, document, photo, wheelFactory = createYearWheel }) {
  const $ = (id) => document.getElementById(id);
  const initial = photo.getState();
  let mode = modeFromURL(window.location.search), year = initial.year || 1926;
  let minYear = initial.min || 1800, maxYear = initial.max || new Date().getFullYear();
  let frame = null, childReady = false, updatingYear = false, yearEdited = false;
  let cameraPan = null;
  const tabs = [...document.querySelectorAll('.mode-tabs [data-mode]')];
  const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const suppliedAccess = hash.get('access') || '';
  const access = /^[A-Za-z0-9_-]{24,128}$/.test(suppliedAccess) ? suppliedAccess : '';
  if (hash.has('access')) {
    hash.delete('access');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash.size ? `#${hash}` : ''}`);
  }
  const cameraWheel = wheelFactory({ element: $('camera-year-wheel'), input: $('camera-wheel-year'), min: minYear, max: maxYear,
    onChange: (value) => { if (mode === 'camera') setYear(value); } });
  const photoWheel = wheelFactory({ element: $('photo-year-wheel'), input: $('photo-wheel-year'), min: minYear, max: maxYear,
    onChange: (value) => { if (mode !== 'photo') return; setYear(value, { updatePhoto: false }); void photo.selectYear(value); } });
  function syncWheels() {
    if ($('camera-wheel-year').value !== String(year)) cameraWheel.setValue(year);
    if ($('photo-wheel-year').value !== String(year)) photoWheel.setValue(year);
  }

  function updateURL() {
    const query = new URLSearchParams(window.location.search);
    if (mode === 'camera' && !query.has('replay') && !query.has('world')) query.delete('mode'); else query.set('mode', mode);
    window.history.replaceState(null, '', `${window.location.pathname}${query.size ? `?${query}` : ''}${window.location.hash || ''}`);
  }
  function sendState() {
    if (!childReady || !frame?.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'century:host-state', active: mode === 'streetview' || mode === 'world', mode, year,
      ...(access ? { access } : {}) }, window.location.origin);
  }
  function ensureFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.id = 'world-viewer'; frame.title = 'Historical Street View and immersive worlds';
    frame.allow = 'geolocation; accelerometer; gyroscope; magnetometer; camera; fullscreen';
    frame.referrerPolicy = 'same-origin';
    const query = new URLSearchParams({ embedded: '1' });
    if (window.CenturyAccess?.sessionRequired) query.set('session', '1');
    const saved = new URLSearchParams(window.location.search).get('world');
    if (/^[a-f0-9]{32}$/.test(saved || '')) query.set('world', saved);
    frame.src = `/world/?${query}`;
    $('world-mode-panel').appendChild(frame);
  }
  function setMode(next, { focus = false, url = true } = {}) {
    if (!MODES.includes(next)) return false;
    mode = next;
    const world = mode === 'streetview' || mode === 'world';
    document.body.dataset.mode = mode;
    $('camera-mode-panel').hidden = mode !== 'camera';
    $('main').hidden = mode !== 'photo';
    $('world-mode-panel').hidden = !world;
    $('world-mode-panel').setAttribute('aria-labelledby', `tab-${mode === 'world' ? 'world' : 'streetview'}`);
    tabs.forEach((tab) => {
      const active = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus({ preventScroll: true });
    });
    photo.setActive(!world, mode);
    cameraPan?.resetHeading();
    if (world) ensureFrame();
    if (url) updateURL();
    sendState();
    syncWheels();
    return true;
  }
  function setYear(value, { updatePhoto = true, edited = true, notifyChild = true } = {}) {
    const selected = Number(value);
    if (!Number.isInteger(selected) || selected < minYear || selected > maxYear) return false;
    year = selected; yearEdited ||= edited;
    syncWheels();
    $('camera-era-filter').style.setProperty('--camera-era', year < 1920 ? 'sepia(.75) saturate(.6)' : year < 1950 ? 'sepia(.4) saturate(.8)' : 'sepia(.1)');
    if (updatePhoto && !updatingYear) {
      updatingYear = true;
      try { photo.setTargetYear(year); } finally { updatingYear = false; }
    }
    if (notifyChild) sendState();
    return true;
  }
  const host = {
    setMode, setYear,
    onCameraHeading: (heading) => { if (mode === 'camera') cameraPan?.onHeading(heading); },
    resetCameraHeading: () => cameraPan?.resetHeading(),
    onMotionState({ enabled, pending, label }) {
      $('camera-motion').setAttribute('aria-pressed', String(!!enabled));
      $('camera-motion').disabled = !!pending;
      $('camera-motion-label').textContent = label || 'Follow my phone';
      $('camera-gesture-hint').hidden = !!enabled;
    },
    getState: () => ({ mode, year, childReady }),
    onPhotoState(change) {
      if (updatingYear) return;
      if (change.reason === 'year') setYear(change.year, { updatePhoto: false });
      if (change.reason === 'default-year' && !yearEdited) setYear(change.year, { updatePhoto: false, edited: false });
      if (change.reason === 'screen') {
        if (change.screen === 'capture') setMode('camera');
        else if (change.activate && (mode === 'camera' || mode === 'photo')) setMode('photo');
      }
    },
    syncPhotoControls(controls) {
      if (Number.isInteger(controls.min) && Number.isInteger(controls.max) && (minYear !== controls.min || maxYear !== controls.max)) {
        minYear = controls.min; maxYear = controls.max;
        cameraWheel.setRange(minYear, maxYear); photoWheel.setRange(minYear, maxYear);
        setYear(Math.min(maxYear, Math.max(minYear, year)), { updatePhoto: false, edited: false });
      }
      photoWheel.setDisabled(!!controls.disabled);
      if ($('photo-wheel-year').value !== String(year)) photoWheel.setValue(year);
      $('photo-target-caption').hidden = !controls.displayedYear || controls.displayedYear === year;
      $('photo-year-wheel').setAttribute('aria-description', controls.displayedYear && controls.displayedYear !== year
        ? `Selected year ${year}. The panorama currently displayed is from ${controls.displayedYear}.` : `Selected year ${year}.`);
    },
  };
  window.CenturyModes = host;
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
    tab.addEventListener('keydown', (event) => {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
      if (next === null) return;
      event.preventDefault(); setMode(tabs[next].dataset.mode, { focus: true });
    });
  });
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.type === 'century:world-ready') { childReady = true; $('world-loading').hidden = true; sendState(); return; }
    if (data.type === 'century:world-state' && Object.prototype.hasOwnProperty.call(data, 'jobId')
        && (data.jobId === null || /^[a-f0-9]{32}$/.test(data.jobId))) {
      const query = new URLSearchParams(window.location.search);
      if (data.jobId === null) query.delete('world'); else query.set('world', data.jobId);
      query.set('mode', mode);
      window.history.replaceState(null, '', `${window.location.pathname}${query.size ? `?${query}` : ''}${window.location.hash || ''}`);
    }
    if (mode !== 'streetview' && mode !== 'world') return;
    if (data.type === 'century:request-mode' && ['streetview', 'world'].includes(data.mode)) { setMode(data.mode); return; }
    if (data.type !== 'century:world-state') return;
    if (Number.isInteger(data.year)) setYear(data.year, { notifyChild: false });
  });
  window.addEventListener('popstate', () => setMode(modeFromURL(window.location.search), { url: false }));
  window.addEventListener('pagehide', () => {
    if (frame?.contentWindow && childReady) frame.contentWindow.postMessage({ type: 'century:host-state', active: false, mode, year }, window.location.origin);
    photo.setActive(false);
  });
  window.addEventListener('pageshow', () => { photo.setActive(mode === 'photo' || mode === 'camera', mode); sendState(); });
  for (const id of ['camera-shoot', 'photo-empty-capture']) $(id).addEventListener('click', () => { cameraWheel.commit(); void photo.capture(); });
  for (const id of ['camera-upload', 'photo-empty-upload']) $(id).addEventListener('click', () => photo.upload());
  for (const id of ['camera-archive', 'photo-empty-archive']) $(id).addEventListener('click', () => photo.archive());
  $('camera-options').addEventListener('click', () => photo.options());
  $('camera-motion').addEventListener('click', () => { cameraPan?.resetHeading(); void photo.toggleMotion(); });
  document.querySelector('[data-camera-home]').addEventListener('click', (event) => { event.preventDefault(); setMode('camera'); });
  cameraPan = installCameraPan($('camera-viewport'), $('camera-hero'), window.CenturyMotion);
  if (photo.getMotionState) host.onMotionState(photo.getMotionState());
  setYear(year, { edited: false }); setMode(mode, { url: false });
  return host;
}

function installCameraPan(viewport, image, motion) {
  let position = 50, drag = null, previousHeading = null;
  const paint = () => { image.style.objectPosition = `${position}% center`; };
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, start: position }; previousHeading = null;
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    position = Math.max(0, Math.min(100, drag.start - (event.clientX - drag.x) / Math.max(1, viewport.clientWidth) * 100)); paint();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(type, () => { drag = null; previousHeading = null; });
  viewport.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); position = event.key === 'Home' ? 0 : event.key === 'End' ? 100 : Math.max(0, Math.min(100, position + (event.key === 'ArrowLeft' ? -10 : 10))); paint();
    previousHeading = null;
  });
  return {
    resetHeading() { previousHeading = null; },
    onHeading(heading) {
      if (!Number.isFinite(heading) || drag) { previousHeading = null; return; }
      if (previousHeading !== null && motion?.shortestDelta) {
        const delta = motion.shortestDelta(heading, previousHeading);
        if (Number.isFinite(delta)) { position = Math.max(0, Math.min(100, position + delta * 100 / 120)); paint(); }
      }
      previousHeading = heading;
    },
  };
}

if (globalThis.document && globalThis.window?.CenturyPhoto) createModeHost({ window, document, photo: window.CenturyPhoto });
