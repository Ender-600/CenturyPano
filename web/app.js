'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const screens = ['capture', 'preview', 'result'];
  const legacyYears = { '1900s': 1905, '1920s': 1925, '1950s': 1955, '1970s': 1975 };
  const defaultTitle = document.title;
  const motionDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const state = {
    screen: 'capture', file: null, fileURL: null, targetYear: 1920,
    minYear: 1800, maxYear: new Date().getFullYear(), yearEdited: false, yearDraft: null, expectedYear: null,
    imageWidth: 0, imageHeight: 0, location: null, locationSource: null,
    manualPlace: false, locationPromise: null, locationRevision: 0,
    offset: 0, renderWidth: 0, renderHeight: 0, wrap: false,
    manifest: null, jobId: null, generation: 0, pollTimer: null,
    geometryKey: null, originalImage: null, loadedTiles: new Set(),
    finalLoaded: false, revealed: false, pastPercent: 0, health: null,
    gyro: false, gyroTarget: 0, gyroSeen: false,
    gyroPending: false, gyroRequest: 0, gyroHeading: null, gyroSignal: false,
    drag: null,
    loadingFile: 0, offlineSaved: false, revealing: false,
    viewMode: 'past', clean: false, submitting: false, loadingSource: false,
    viewRevision: 0, viewportWidth: 0, cachePending: false, fileOrigin: null,
    activeHotspot: null, hotspotKey: '', explaining: false, hotspotHintShown: false,
    activeWeather: null, weatherRevision: 0,
  };

  function text(id, value) { $(id).textContent = value; }
  function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function assetURL(path) { if (!path) return ''; return path.startsWith('/') ? path : '/' + path; }
  function showToast(message, duration = 5500) {
    text('toast', message); $('toast').hidden = false;
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { $('toast').hidden = true; }, duration);
  }
  function showScreen(screen) {
    closeOptions();
    state.screen = screen;
    screens.forEach((name) => { $(name + '-screen').hidden = name !== screen; });
    document.body.dataset.screen = screen;
    if (screen === 'preview') document.title = `${state.targetYear} · CENTURY PANO`;
    resetMotionOrigin();
    syncChrome();
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(resizeViewport);
  }
  function stopJourney() {
    state.generation++; clearTimeout(state.pollTimer); resetMotionOrigin();
    state.loadingFile++;
    state.loadingSource = false;
    if (state.drag) {
      const { target, pointerId } = state.drag;
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    }
    document.querySelectorAll('.dragging').forEach((element) => element.classList.remove('dragging'));
    state.drag = null; state.revealing = false;
    state.clean = false;
    setClean(false, false);
    document.body.classList.remove('revealing');
  }
  function goHome() {
    stopJourney(); state.viewMode = 'past'; state.offset = 0; state.renderWidth = 0; state.wrap = false;
    state.yearDraft = null; document.title = defaultTitle;
    clearHotspots();
    showScreen('capture');
    if (location.search) history.replaceState(null, '', location.pathname);
  }

  function closeOptions() { if ($('options-dialog').open) { $('options-dialog').close(); resetMotionOrigin(); } }
  function setClean(enabled, focus = true) {
    state.clean = enabled;
    document.body.classList.toggle('clean', enabled);
    document.querySelectorAll('.chrome').forEach((element) => { element.inert = enabled; });
    $('slider-handle').inert = enabled;
    $('restore-button').hidden = !enabled;
    if (focus) (enabled ? $('restore-button') : $('clean-button')).focus({ preventScroll: true });
  }
  function syncChrome() {
    const result = state.screen === 'result', preview = state.screen === 'preview';
    const failed = result && (state.manifest?.status === 'error' || state.yearMismatch);
    const original = state.viewMode === 'present';
    const available = result && (!!state.loadedTiles.size || state.finalLoaded);
    const busy = state.submitting || state.loadingSource;
    const displayYear = result ? yearOf(state.manifest) ?? state.expectedYear : state.targetYear;
    document.querySelectorAll('[data-year]').forEach((button) => {
      const year = Number(button.dataset.year);
      const active = !original && year === displayYear;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = busy || year < state.minYear || year > state.maxYear;
    });
    syncYearControls();
    $('year-input').disabled = busy; $('year-range').disabled = busy; $('year-picker-button').disabled = busy;
    $('present-button').classList.toggle('active', original);
    $('present-button').setAttribute('aria-pressed', String(original));
    $('compare-button').disabled = !available;
    $('compare-button').setAttribute('aria-pressed', String(state.viewMode === 'compare'));
    $('compare-button').title = available ? 'Drag the divider to compare' : 'Ready once the view is generated';
    $('slider-handle').hidden = !result || state.viewMode !== 'compare';
    document.querySelectorAll('.viewport-label').forEach((label) => { label.hidden = !result || state.viewMode !== 'compare'; });
    $('generate-button').hidden = !failed && (!preview || original);
    $('generate-button').disabled = busy;
    $('generate-button').innerHTML = `${failed ? 'Preview this photo again' : state.submitting ? 'Submitting…' : `Step into ${state.targetYear}`}<svg><use href="#i-arrow"/></svg>`;
    const showWeatherOptIn = preview && !original && !failed;
    $('weather-opt-in').hidden = !showWeatherOptIn;
    $('weather-enabled').disabled = busy;
    $('album-button').disabled = busy;
    $('capture-button').disabled = busy;
    // Shooting a panorama is the product; it belongs on the first screen rather
    // than behind a menu. Once a photo is loaded, Generate takes the same slot.
    const landing = state.screen === 'capture';
    $('shoot-button').hidden = !landing;
    $('shoot-button').disabled = busy;
    text('album-button-label', landing ? 'Use a photo instead' : 'Another panorama');
    $('photo-settings').hidden = !preview;
    $('result-actions').hidden = !result;
    $('journey-info').hidden = !result;
    $('retake-button').hidden = !preview;
    $('new-journey-button').hidden = !result;
    text('window-year', original ? 'Today' : displayYear ?? '—');
    $('year-picker-button').setAttribute('aria-label', `Choose a specific year. Currently ${original ? 'today' : displayYear ?? 'to be confirmed'}.`);
    $('window-year-suffix').hidden = original;
    text('window-place', result ? placeName(state.manifest?.place) : preview ? $('place-input').value.trim() || 'your viewpoint' : 'Pittsburgh');
    const caption = state.submitting ? 'Submitting your journey.' : state.loadingSource ? 'Opening this viewpoint.' :
      original ? 'This is now.' : state.viewMode === 'compare' ? 'One swipe, between then and now.' :
        preview ? 'Keep the view, choose a year.' : result ? 'The same place, another year.' : 'Your phone, as a window onto time.';
    text('window-caption', caption);
    text('provider-note', state.screen === 'capture' ? 'Concept image · capture this place to begin' : preview ?
      'Original preview · generate to begin' : isDemo(state.manifest || {}) ? 'Engineering sample · local grading' : 'Imagined reconstruction · not a historical photo');
    const filter = state.targetYear < 1920 ? 'sepia(.95) saturate(.4)' : state.targetYear < 1950 ? 'sepia(.58) saturate(.65)' : state.targetYear < 1970 ? 'sepia(.22) saturate(.82)' : 'sepia(.16) saturate(.9) contrast(.92)';
    $('hero-past').style.setProperty('--hero-filter', filter);
    $('hero-past').style.opacity = original ? '0' : '1';
  }
  function setView(mode) {
    state.viewMode = mode; state.viewRevision++;
    if (state.screen === 'result') setPastPercent(mode === 'present' ? 0 : mode === 'compare' ? 50 : 100);
    syncChrome();
  }
  $('menu-button').addEventListener('click', () => { syncChrome(); $('options-dialog').showModal(); });
  $('year-picker-button').addEventListener('click', () => {
    state.yearDraft = null; syncChrome(); $('options-dialog').showModal(); $('year-input').focus();
  });
  $('close-options').addEventListener('click', closeOptions);
  $('options-dialog').addEventListener('click', (event) => {
    if (event.target !== $('options-dialog')) return;
    const rect = $('options-dialog').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeOptions();
  });
  $('clean-button').addEventListener('click', () => setClean(true));
  $('restore-button').addEventListener('click', () => setClean(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.clean) setClean(false); });
  $('present-button').addEventListener('click', () => setView('present'));
  $('compare-button').addEventListener('click', () => { if (!$('compare-button').disabled) setView(state.viewMode === 'compare' ? 'past' : 'compare'); });
  function connectionStatus() {
    const offline = !navigator.onLine;
    $('connection-status').classList.toggle('offline', offline);
    $('connection-status').lastElementChild.textContent = offline ? 'Offline · the archive still works' : state.health?.provider === 'demo' ? 'Local demo mode' : state.health?.configured ? 'Ready' : 'Connecting…';
  }
  async function checkHealth() {
    try {
      const response = await fetch('/health');
      if (response.ok) {
        state.health = await response.json();
        const min = Number(state.health.min_year), max = Number(state.health.max_year);
        if (Number.isInteger(min) && Number.isInteger(max) && min <= max) {
          state.minYear = min; state.maxYear = max;
        }
        if (state.screen !== 'result' && !state.submitting && !state.loadingSource && !state.yearEdited) {
          setTargetYear(state.health.default_year ?? state.targetYear);
        }
        if (typeof state.health.weather_enabled === 'boolean') {
          $('weather-enabled').checked = state.health.weather_enabled;
        }
      }
    } catch { /* Replay remains available when the live service is offline. */ }
    connectionStatus();
    syncChrome();
  }

  // In-app panorama capture. The system camera's panorama mode is not reachable
  // from a web page, so the sweep is built here: the phone reports where it is
  // pointing, and CenturyCapture lays each frame's centre column onto a cylinder
  // at the heading it belongs to. Falls back to the file picker wherever the
  // camera or the orientation sensor is unavailable.
  const capture = { session: null, stream: null, listener: null, timer: 0, frame: 0, target: 120 };

  function captureProgress(progress) {
    const degrees = Math.round(progress.degrees);
    text('capture-degrees', `${degrees}° captured`);
    $('capture-progress').setAttribute('aria-valuenow', String(degrees));
    // One bar, two spans, both on a fixed track whose middle is the heading the
    // capture started at. The dim span is the ground captured so far: it begins
    // as one field of view in the centre and grows outward, never shrinking. The
    // bright span is the lens right now, and it lives inside the dim one -- at an
    // edge the two move together, which is when a turn adds to the panorama; in
    // the middle it slides back over what is already captured.
    const percent = (fraction) => `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(2)}%`;
    const region = $('capture-progress-fill'), lens = $('capture-cursor');
    region.style.left = percent(progress.region.start);
    region.style.width = percent(progress.region.end - progress.region.start);
    lens.style.left = percent(progress.lens.start);
    lens.style.width = percent(progress.lens.end - progress.lens.start);
    $('capture-progress').classList.toggle('capture-cursor-live', progress.edge !== null);
    text('capture-facing', progress.edge === 'both' ? 'turn either way to widen the shot'
      : progress.edge === 'right' ? 'at the leading edge — keep turning'
      : progress.edge === 'left' ? 'at the other edge — keep turning this way'
      : 'looking back over what you have');
    text('capture-target', progress.useful ? 'wide enough — turn further for more'
      : `keep going to about ${capture.target}°`);
    $('capture-done').disabled = !progress.useful;
  }

  function closeCapture() {
    if (capture.frame) {
      const video = $('capture-video');
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(capture.frame);
      else cancelAnimationFrame(capture.frame);
    }
    if (capture.listener) window.removeEventListener('deviceorientation', capture.listener);
    if (capture.timer) clearTimeout(capture.timer);
    if (capture.stream) for (const track of capture.stream.getTracks()) track.stop();
    const video = $('capture-video');
    video.srcObject = null;
    capture.listener = null; capture.stream = null; capture.session = null; capture.timer = 0;
    capture.frame = 0;
    $('capture-overlay').hidden = true;
  }

  async function firstFrame(video) {
    if (video.videoWidth) return true;
    return new Promise((resolve) => {
      const done = () => { video.removeEventListener('loadedmetadata', done); resolve(!!video.videoWidth); };
      video.addEventListener('loadedmetadata', done);
      setTimeout(done, 3000);
    });
  }

  async function startCapture() {
    const engine = window.CenturyCapture;
    if (!engine || !engine.supported()) {
      showToast(window.isSecureContext ? 'This browser cannot open the camera. Choose a panorama instead.'
        : 'Capturing needs HTTPS. Choose a panorama instead.');
      $('album-input').click(); return;
    }
    // iOS grants motion access only from inside the tap that asked for it.
    if (!(await engine.requestOrientationAccess())) {
      showToast('Capturing needs motion access. Allow it in your browser site settings, or choose a panorama.');
      $('album-input').click(); return;
    }
    try {
      capture.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch {
      showToast('The camera is unavailable. Choose a panorama instead.');
      $('album-input').click(); return;
    }
    const video = $('capture-video');
    video.srcObject = capture.stream;
    $('capture-overlay').hidden = false;
    try { await video.play(); } catch { /* autoplay is allowed for a muted stream */ }
    if (!(await firstFrame(video))) { closeCapture(); showToast('The camera did not start. Please try again.'); return; }
    try {
      capture.session = engine.start({ video, heading: CenturyMotion.headingFromOrientation, onProgress: captureProgress });
    } catch { closeCapture(); showToast('The camera did not start. Please try again.'); return; }
    captureProgress(capture.session.progress());
    // The sensor says where the phone points; the camera says when a new frame
    // exists. Only the camera may trigger a strip, or one frame gets pasted
    // across every heading the phone passed through while it was on screen.
    capture.listener = (event) => capture.session && capture.session.record(event);
    window.addEventListener('deviceorientation', capture.listener);
    // requestVideoFrameCallback fires once per delivered frame, which is exactly
    // the clock a strip should follow. Without it, requestAnimationFrame runs at
    // display rate -- around twice the camera's -- so it is throttled to roughly
    // a frame interval, or every other strip would repeat a frame.
    const paced = !video.requestVideoFrameCallback;
    let lastDraw = 0;
    const onFrame = (now, metadata) => {
      if (!capture.session) return;
      if (!paced || now - lastDraw >= 30) {
        lastDraw = now;
        capture.session.draw(metadata ? metadata.mediaTime : undefined);
      }
      queueFrame();
    };
    const queueFrame = () => {
      if (!capture.session) return;
      capture.frame = paced
        ? requestAnimationFrame((now) => onFrame(now, null))
        : video.requestVideoFrameCallback(onFrame);
    };
    queueFrame();
    // Without a heading there is nowhere to put the strips, so say so rather
    // than leaving the viewfinder running and nothing happening.
    capture.timer = setTimeout(() => {
      // Coverage is a whole field of view the moment one frame lands, so it can
      // no longer stand in for "the sensor is silent". Count the readings.
      if (capture.session && capture.session.readings() === 0) {
        closeCapture();
        showToast('No orientation readings arrived, so the sweep cannot be tracked. Choose a panorama instead.', 8000);
        $('album-input').click();
      }
    }, engine.ORIENTATION_TIMEOUT_MS + 1500);
  }

  async function finishCapture() {
    if (!capture.session) { closeCapture(); return; }
    const session = capture.session;
    const swept = Math.round(session.stop().degrees);
    let blob = null;
    try { blob = await session.toBlob(); } catch { /* reported below */ }
    closeCapture();
    if (!blob) { showToast('That panorama could not be saved. Please try again.'); return; }
    const file = new File([blob], `capture-${swept}deg.jpg`, { type: 'image/jpeg' });
    showToast(`Captured about ${swept}° of sweep.`, 2600);
    acceptFile(file);
  }

  $('capture-button').addEventListener('click', () => { closeOptions(); startCapture(); });
  $('shoot-button').addEventListener('click', () => { closeOptions(); startCapture(); });
  $('capture-done').addEventListener('click', finishCapture);
  $('capture-cancel').addEventListener('click', () => { closeCapture(); showToast('Capture cancelled.', 1800); });
  $('album-button').addEventListener('click', () => { closeOptions(); $('album-input').click(); });
  $('camera-input').addEventListener('change', (event) => acceptFile(event.target.files[0]));
  $('album-input').addEventListener('change', (event) => acceptFile(event.target.files[0]));
  $('retake-button').addEventListener('click', goHome);
  $('new-journey-button').addEventListener('click', goHome);
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); goHome(); });
  $('place-input').addEventListener('input', () => {
    state.manualPlace = true;
    text('location-note', $('place-input').value.trim() ? 'A city you type overrides the photo GPS and device location, and gives only city-level context. Add a state or country to pin it down.' : 'With no city, the photo GPS is used first. You can also use your device location.');
    syncChrome();
  });
  function yearOf(manifest) {
    return manifest?.target_year ?? manifest?.anchor_year ?? legacyYears[manifest?.decade] ?? null;
  }
  function syncYearControls() {
    const value = state.yearDraft ?? state.targetYear;
    for (const id of ['year-range', 'year-input']) { $(id).min = state.minYear; $(id).max = state.maxYear; }
    $('year-input').value = value;
    const year = Number(value);
    $('year-range').value = Number.isInteger(year) && year >= state.minYear && year <= state.maxYear ? year : state.targetYear;
    $('year-range').setAttribute('aria-valuetext', `${$('year-range').value}, read as 1 July`);
    text('year-min', state.minYear); text('year-max', state.maxYear);
  }
  function setTargetYear(value, edited = false) {
    const year = Number(value);
    if (!Number.isInteger(year)) return false;
    state.targetYear = Math.max(state.minYear, Math.min(state.maxYear, year));
    if (state.screen === 'preview') document.title = `${state.targetYear} · CENTURY PANO`;
    state.yearEdited ||= edited; state.yearDraft = null;
    syncChrome(); return true;
  }
  async function selectYear(value) {
    if (state.submitting || state.loadingSource) return;
    const year = Number(value);
    if (!String(value).trim() || !Number.isInteger(year)) { state.yearDraft = null; syncChrome(); return; }
    const selected = Math.max(state.minYear, Math.min(state.maxYear, year));
    state.yearDraft = null;
    if (state.screen === 'result' && (selected !== yearOf(state.manifest) || state.manifest?.status === 'error' || state.yearMismatch)) {
      await editJourney(selected); return;
    }
    setTargetYear(selected, true); setView('past');
  }
  $('year-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-year]');
    if (button) return selectYear(button.dataset.year);
  });
  $('weather-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-weather]');
    if (button) switchWeather(button.dataset.weather);
  });
  $('year-range').addEventListener('input', (event) => {
    if (state.screen === 'result') { state.yearDraft = event.target.value; syncYearControls(); }
    else setTargetYear(event.target.value, true);
  });
  $('year-range').addEventListener('change', (event) => selectYear(event.target.value));
  $('year-input').addEventListener('input', (event) => {
    state.yearDraft = event.target.value;
    const year = Number(event.target.value);
    if (!event.target.value || !Number.isInteger(year) || year < state.minYear || year > state.maxYear) return;
    if (state.screen === 'result') syncYearControls();
    else setTargetYear(year, true);
  });
  $('year-input').addEventListener('change', (event) => selectYear(event.target.value));

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('That image could not be read'));
      image.decoding = 'async'; image.src = url;
    });
  }
  async function acceptFile(file) {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) { showToast('That photo is over 40 MB. Please choose a smaller panorama.'); return; }
    if (!(/^image\/(jpeg|png|heic|heif|heic-sequence|heif-sequence)$/.test(file.type) || (!file.type && /\.(heic|heif|jpe?g|png)$/i.test(file.name)))) { showToast('Please choose a JPEG, PNG or HEIC panorama.'); return; }
    let request = ++state.loadingFile;
    state.loadingSource = true; syncChrome();
    let url = null;
    try {
      url = URL.createObjectURL(file); let image;
      try { image = await loadImage(url); }
      catch {
        URL.revokeObjectURL(url);
        showToast('Converting the photo, one moment…');
        const form = new FormData(); form.append('image', file);
        const response = await fetch('/preview', { method: 'POST', body: form });
        if (!response.ok) throw new Error('This browser cannot preview that photo. Try a JPEG or PNG.');
        url = URL.createObjectURL(await response.blob()); image = await loadImage(url);
      }
      if (request !== state.loadingFile) { URL.revokeObjectURL(url); return; }
      stopJourney();
      request = state.loadingFile;
      if (state.fileURL) URL.revokeObjectURL(state.fileURL);
      state.file = file; state.fileURL = url; state.imageWidth = image.naturalWidth; state.imageHeight = image.naturalHeight;
      state.fileOrigin = null; state.viewMode = 'past'; state.renderWidth = 0;
      state.location = null; state.locationSource = null; state.manualPlace = false; state.locationPromise = null;
      state.offset = 0; state.wrap = false;
      $('preview-image').src = url; $('place-input').value = '';
      $('is-360').checked = Math.abs(state.imageWidth / state.imageHeight - 2) < 0.1;
      const narrow = state.imageWidth / state.imageHeight < 2;
      $('image-warning').hidden = !narrow;
      text('image-warning', 'This photo looks narrow. You can still continue, though a wide panorama opens up much further.');
      text('location-note', 'Reading the photo location… you can also type the city yourself.');
      showScreen('preview');
      if (location.search) history.replaceState(null, '', location.pathname);
      requestAnimationFrame(() => { resizeViewport(); state.offset = Math.max(0, (state.renderWidth - $('preview-window').clientWidth) / 2); resetMotionOrigin(); render(); });
      if (narrow) showToast('Opened. A wide panorama gives a much broader view.');
      state.locationPromise = locate(file, request);
    } catch (error) {
      if (url && url !== state.fileURL) URL.revokeObjectURL(url);
      if (request === state.loadingFile) showToast(error.message || 'That photo could not be read. Please choose another.');
    } finally {
      if (request === state.loadingFile) { state.loadingSource = false; syncChrome(); }
      $('camera-input').value = ''; $('album-input').value = '';
    }
  }

  async function editJourney(targetYear) {
    const request = ++state.loadingFile, jobId = state.jobId, manifest = state.manifest;
    const sourceWrap = manifest?.geometry?.wrap ?? manifest?.source?.is_360 ?? $('is-360').checked;
    const heading = state.renderWidth ? (state.offset + $('pano-viewport').clientWidth / 2) / state.renderWidth : .5;
    state.loadingSource = true; syncChrome();
    let newURL = null;
    try {
      let file = state.file, url = state.fileURL;
      const recovered = !file || state.fileOrigin !== jobId;
      if (recovered) {
        const response = await fetch(`/jobs/${encodeURIComponent(jobId)}/preview`);
        if (!response.ok) throw new Error('This journey\'s working image is not ready yet. Try again shortly.');
        const blob = await response.blob();
        file = new File([blob], `century-${jobId}.jpg`, { type: 'image/jpeg' });
        newURL = URL.createObjectURL(file); url = newURL;
      }
      const image = await loadImage(url);
      if (request !== state.loadingFile || state.jobId !== jobId) { if (newURL) URL.revokeObjectURL(newURL); return; }
      stopJourney();
      if (newURL && state.fileURL) URL.revokeObjectURL(state.fileURL);
      state.file = file; state.fileURL = url; state.fileOrigin = null;
      state.targetYear = targetYear; state.yearEdited = true; state.yearDraft = null; state.viewMode = 'past'; state.wrap = false;
      state.imageWidth = image.naturalWidth; state.imageHeight = image.naturalHeight;
      state.renderWidth = 0;
      $('preview-image').src = url;
      restoreJourneyLocation(manifest?.place, recovered);
      $('is-360').checked = !!sourceWrap;
      $('image-warning').hidden = !recovered;
      text('image-warning', 'Reusing the archived working image. It may already be cropped or scaled.');
      showScreen('preview');
      history.replaceState(null, '', location.pathname);
      requestAnimationFrame(() => { resizeViewport(); state.offset = constrainOffset(heading * state.renderWidth - $('preview-window').clientWidth / 2); resetMotionOrigin(); render(); });
      showToast(recovered ? 'Archived working image opened. Generate to explore another year.' : 'Your original is kept. Generate to explore another year.');
    } catch (error) {
      if (newURL && newURL !== state.fileURL) URL.revokeObjectURL(newURL);
      if (request === state.loadingFile) showToast(error.message || 'That original viewpoint could not be read. Try again shortly.');
    } finally {
      if (request === state.loadingFile) { state.loadingSource = false; syncChrome(); }
    }
  }

  // A small, bounds-checked JPEG EXIF GPS reader keeps the app usable without a CDN.
  // HEIC GPS is read from the original upload by the server before conversion.
  async function readExifGPS(file) {
    try {
      const buffer = await file.slice(0, 512 * 1024).arrayBuffer();
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
      let p = 2;
      while (p + 4 < view.byteLength) {
        if (view.getUint8(p) !== 0xff) return null;
        const marker = view.getUint8(p + 1), size = view.getUint16(p + 2);
        if (size < 2) return null;
        if (marker === 0xe1 && p + 10 < view.byteLength && view.getUint32(p + 4) === 0x45786966) {
          const base = p + 10, little = view.getUint16(base) === 0x4949;
          const u16 = (x) => view.getUint16(x, little), u32 = (x) => view.getUint32(x, little);
          if (u16(base + 2) !== 42) return null;
          const entries = (offset) => {
            const count = u16(offset), result = new Map();
            if (count > 200 || offset + 2 + count * 12 > view.byteLength) return result;
            for (let n = 0; n < count; n++) { const entry = offset + 2 + n * 12; result.set(u16(entry), entry); }
            return result;
          };
          const ifd = entries(base + u32(base + 4)); const gpsEntry = ifd.get(0x8825);
          if (!gpsEntry) return null;
          const gps = entries(base + u32(gpsEntry + 8));
          const coordinate = (tag, refTag) => {
            const entry = gps.get(tag), ref = gps.get(refTag);
            if (!entry || !ref || u16(entry + 2) !== 5 || u32(entry + 4) < 3) return null;
            const start = base + u32(entry + 8);
            let degrees = 0;
            for (let n = 0; n < 3; n++) { const denominator = u32(start + n * 8 + 4); if (!denominator) return null; degrees += u32(start + n * 8) / denominator / (60 ** n); }
            const cardinal = String.fromCharCode(view.getUint8(ref + 8));
            return ['S', 'W'].includes(cardinal) ? -degrees : degrees;
          };
          const lat = coordinate(2, 1), lon = coordinate(4, 3);
          return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
        }
        if (marker === 0xda || marker === 0xd9) break;
        p += size + 2;
      }
    } catch { /* Missing, truncated, or unsupported EXIF is non-blocking. */ }
    return null;
  }
  async function locate(file, request, useDevice = false) {
    const revision = ++state.locationRevision;
    const current = () => request === state.loadingFile && revision === state.locationRevision;
    // The photo can have been taken far from the phone's present location.
    const exif = await readExifGPS(file);
    if (!current()) return;
    const geo = exif ? null : await new Promise((resolve) => {
      if (!useDevice || !navigator.geolocation) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), 5200);
      navigator.geolocation.getCurrentPosition((position) => { clearTimeout(timer); resolve({ lat: position.coords.latitude, lon: position.coords.longitude }); }, () => { clearTimeout(timer); resolve(null); }, { timeout: 5000, maximumAge: 120000, enableHighAccuracy: false });
    });
    if (!current()) return;
    const coordinates = exif || geo;
    if (!coordinates) {
      if (!state.manualPlace) text('location-note', useDevice ? 'No location. The server still reads the photo GPS, and you can type the city yourself.' : 'The browser found no location in the photo. The server still tries the photo GPS; you can type a city or use your location.');
      return;
    }
    state.location = coordinates; state.locationSource = exif ? 'exif' : 'geolocation';
    if (state.manualPlace) return;
    // Coordinates are ready for generation; resolving a display name need not
    // delay the upload when the location service is slow or unavailable.
    resolveDetectedLocation(coordinates, !!exif, current);
  }
  async function resolveDetectedLocation(coordinates, exif, current) {
    try {
      const response = await fetch('/location/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(coordinates) });
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json(); const city = result.place || result;
      if (!current() || state.manualPlace) return;
      $('place-input').value = city.name || '';
      text('location-note', `${exif ? 'Photo GPS' : 'Device location (the server prefers photo GPS)'} · ${city.name || 'located'}${city.cc ? ', ' + city.cc : ''}. You can override this, and your device may not be where the photo was taken.`);
      syncChrome();
    } catch {
      if (current() && !state.manualPlace) text('location-note', 'Coordinates found. They guide the local history, and you can override them with a city.');
    }
  }
  $('locate-button').addEventListener('click', () => {
    if (!state.file || state.screen !== 'preview' || state.submitting) return;
    state.manualPlace = false; $('place-input').value = '';
    text('location-note', 'Reading the photo GPS first, then your location…');
    state.locationPromise = locate(state.file, state.loadingFile, true);
  });
  function restoreJourneyLocation(place, recovered = false) {
    state.locationPromise = null;
    if (!place && !recovered) return; // An unfinished live job still has its original input state.
    if (!place) {
      state.location = null; state.locationSource = null; state.manualPlace = false;
      $('place-input').value = '';
      text('location-note', 'No location recorded. Type a city or use your device location.');
      return;
    }
    const name = placeName(place) === 'Unknown city' ? '' : placeName(place);
    const coordinates = typeof place === 'object' && Number.isFinite(place.lat) && Number.isFinite(place.lon)
      ? { lat: place.lat, lon: place.lon } : null;
    state.manualPlace = place.source === 'manual' || (!coordinates && !!name);
    state.location = coordinates;
    // A replay working JPEG has no EXIF. Send saved coordinates explicitly;
    // the backend still gives any EXIF in the original upload precedence.
    state.locationSource = coordinates ? 'geolocation' : null;
    $('place-input').value = state.manualPlace && typeof place === 'object'
      ? [name, place.admin1, place.cc].filter(Boolean).join(', ') : name;
    text('location-note', coordinates && !state.manualPlace ? 'Reusing this photo\'s coordinates. Type a city to override.' : state.manualPlace ? 'Reusing this journey\'s city. You can edit it and add a state or country.' : 'No location recorded. Type a city or use your device location.');
  }

  function activeViewport() { return state.screen === 'capture' ? $('capture-screen') : state.screen === 'preview' ? $('preview-window') : $('pano-viewport'); }
  function constrainOffset(value) {
    if (state.wrap && state.renderWidth > 0) return ((value % state.renderWidth) + state.renderWidth) % state.renderWidth;
    return Math.max(0, Math.min(Math.max(0, state.renderWidth - activeViewport().clientWidth), value));
  }
  function resizeViewport() {
    const viewport = activeViewport(), oldWidth = state.renderWidth;
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    // When the result screen is opened, there may not be a rendered canvas yet.
    // Use the hand-off heading instead of briefly centering the new viewport;
    // otherwise a wide panorama can visibly jump before its geometry arrives.
    const fraction = oldWidth > 0 ? (state.offset + (state.viewportWidth || viewport.clientWidth) / 2) / oldWidth :
      state.screen === 'result' && Number.isFinite(state.initialHeading) ? state.initialHeading : 0.5;
    state.viewportWidth = viewport.clientWidth;
    const geometry = state.screen === 'result' && state.manifest?.geometry;
    const hero = state.screen === 'capture';
    const width = hero ? $('hero-image').naturalWidth || 1536 : geometry?.W || state.imageWidth || viewport.clientWidth;
    const height = hero ? $('hero-image').naturalHeight || 1024 : geometry?.H || state.imageHeight || viewport.clientHeight;
    const scale = Math.max(viewport.clientHeight / height, viewport.clientWidth / width) * (hero ? 1.08 : 1);
    state.renderWidth = width * scale; state.renderHeight = height * scale;
    state.offset = constrainOffset(fraction * state.renderWidth - viewport.clientWidth / 2);
    if (state.gyro) resetMotionOrigin();
    if (hero) {
      $('hero-image').style.width = state.renderWidth + 'px'; $('hero-image').style.height = state.renderHeight + 'px';
    } else if (state.screen === 'preview') {
      $('preview-image').style.width = state.renderWidth + 'px'; $('preview-image').style.height = state.renderHeight + 'px';
    } else {
      for (const canvas of [$('original-canvas'), $('past-canvas')]) {
        canvas.style.width = state.renderWidth * (state.wrap ? 2 : 1) + 'px'; canvas.style.height = state.renderHeight + 'px';
      }
      const layer = $('hotspot-layer');
      layer.style.width = state.renderWidth * (state.wrap ? 2 : 1) + 'px';
      layer.style.height = state.renderHeight + 'px';
    }
    render();
  }
  function render() {
    const y = (activeViewport().clientHeight - state.renderHeight) / 2;
    const transform = `translate3d(${-state.offset}px,${y}px,0)`;
    if (state.screen === 'capture') $('hero-image').style.transform = transform;
    else if (state.screen === 'preview') $('preview-image').style.transform = transform;
    else {
      $('original-layer').style.transform = transform; $('past-layer').style.transform = transform;
      $('past-clip').style.clipPath = `inset(0 0 0 ${100 - state.pastPercent}%)`;
      const x = (100 - state.pastPercent) / 100 * $('pano-viewport').clientWidth;
      $('slider-handle').style.left = `${100 - state.pastPercent}%`;
      const grip = $('slider-handle').firstElementChild;
      const extra = x < 25 ? 25 - x : x > $('pano-viewport').clientWidth - 25 ? $('pano-viewport').clientWidth - 25 - x : 0;
      grip.style.marginLeft = extra + 'px';
    }
  }
  function frame() {
    if (state.velocity && !state.drag && !state.revealing) {
      state.velocity *= .94;
      if (Math.abs(state.velocity) < .2) state.velocity = 0;
      else {
        const next = state.offset + state.velocity;
        const clamped = constrainOffset(next);
        if (!state.wrap && clamped !== next) state.velocity = 0;   // hit the edge: stop, don't bounce
        state.offset = clamped; render();
        if (state.gyro) resetMotionOrigin();
      }
    }
    if (state.gyro && !state.drag && !state.revealing && !state.velocity && !document.hidden && !$('options-dialog').open && !$('replay-dialog').open) {
      if (state.wrap) {
        let delta = state.gyroTarget - state.offset;
        delta = ((delta + state.renderWidth * 1.5) % state.renderWidth) - state.renderWidth / 2;
        state.offset = constrainOffset(state.offset + delta * 0.15);
      } else { state.offset += (constrainOffset(state.gyroTarget) - state.offset) * 0.15; }
      render();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  function setPastPercent(value) {
    state.pastPercent = Math.max(0, Math.min(100, value));
    $('slider-handle').setAttribute('aria-valuenow', String(Math.round(state.pastPercent)));
    $('slider-handle').setAttribute('aria-valuetext', `${Math.round(state.pastPercent)}% of the past revealed`);
    syncHotspotVisibility();
    render();
  }
  function sliderAt(clientX) {
    const bounds = $('pano-viewport').getBoundingClientRect();
    setPastPercent(100 - (clientX - bounds.left) / bounds.width * 100);
  }
  function installPan(viewport) {
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || state.revealing) return;
      const handle = event.target.closest('#slider-handle');
      if (!handle && event.target.closest('button, a, input, select, textarea, #hotspot-card')) return;
      $('gesture-hint').hidden = true;
      state.velocity = 0;
      state.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: state.offset, slider: !!handle,
        target: viewport, axis: null, lastX: event.clientX, lastT: performance.now(), velocity: 0, t0: performance.now() };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
      if (handle) { event.preventDefault(); sliderAt(event.clientX); }
    });
    viewport.addEventListener('pointermove', (event) => {
      const drag = state.drag; if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.slider) { event.preventDefault(); sliderAt(event.clientX); return; }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      // Decide the gesture axis once, after a short dead zone, then keep it. Re-deciding on
      // every move made diagonal drags flicker between panning and page scrolling.
      if (!drag.axis && Math.hypot(dx, dy) >= 8) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') {
        if (event.cancelable) event.preventDefault();
        const now = performance.now(), dt = Math.max(1, now - drag.lastT);
        const instant = (event.clientX - drag.lastX) / dt * 16;      // px per 60 Hz frame
        drag.velocity = drag.velocity * .6 + instant * .4;
        drag.lastX = event.clientX; drag.lastT = now;
        state.offset = constrainOffset(drag.offset - dx); render();
      }
    });
    const endDrag = (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) return;
      const drag = state.drag;
      const moved = Math.hypot((event.clientX ?? drag.lastX) - drag.x, (event.clientY ?? drag.y) - drag.y);
      const tapped = !drag.slider && !drag.axis && moved < 8 && performance.now() - drag.t0 < 450;
      if (drag.axis === 'x' && !drag.slider && performance.now() - drag.lastT < 80) {
        // Flick: carry the last measured speed into the inertia loop in frame().
        state.velocity = -drag.velocity;
      }
      if (state.gyro) resetMotionOrigin();
      state.drag = null; viewport.classList.remove('dragging');
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      if (tapped && viewport.id === 'pano-viewport') handleHotspotTap(event.clientX, event.clientY);
    };
    viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag); viewport.addEventListener('lostpointercapture', endDrag);
    // Safari needs a non-passive touch listener to keep horizontal pano gestures local.
    let touchStart = null;
    viewport.addEventListener('touchstart', (event) => { if (event.touches.length === 1) touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }, { passive: true });
    viewport.addEventListener('touchmove', (event) => {
      if (!touchStart || !event.touches.length) return;
      const dx = event.touches[0].clientX - touchStart.x, dy = event.touches[0].clientY - touchStart.y;
      if (state.drag?.slider || Math.abs(dx) > Math.abs(dy)) { if (event.cancelable) event.preventDefault(); }
    }, { passive: false });
    viewport.addEventListener('touchend', () => { touchStart = null; }, { passive: true });
    viewport.addEventListener('keydown', (event) => {
      if (event.target.closest('#slider-handle')) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const delta = viewport.clientWidth * (event.shiftKey ? 0.5 : 0.1);
      state.offset = constrainOffset(event.key === 'Home' ? 0 : event.key === 'End' ? state.renderWidth : state.offset + (event.key === 'ArrowLeft' ? -delta : delta));
      if (state.gyro) resetMotionOrigin();
      render();
    });
  }
  installPan($('capture-screen')); installPan($('preview-window')); installPan($('pano-viewport'));
  $('slider-handle').addEventListener('keydown', (event) => {
    const delta = event.shiftKey ? 20 : 5;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    setPastPercent(event.key === 'Home' ? 0 : event.key === 'End' ? 100 : state.pastPercent + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? delta : -delta));
  });
  new ResizeObserver(resizeViewport).observe($('pano-viewport'));
  new ResizeObserver(resizeViewport).observe($('preview-window'));
  new ResizeObserver(resizeViewport).observe($('capture-screen'));
  $('hero-image').addEventListener('load', resizeViewport);
  window.addEventListener('resize', resizeViewport);

  $('generate-button').addEventListener('click', async () => {
    if (state.screen === 'result' && (state.manifest?.status === 'error' || state.yearMismatch)) { await editJourney(state.expectedYear ?? state.targetYear); return; }
    if (!state.file || state.screen !== 'preview' || state.submitting || state.loadingSource) return;
    if (!$('year-input').checkValidity()) {
      if (!$('options-dialog').open) $('options-dialog').showModal();
      $('year-input').reportValidity(); return;
    }
    const generation = state.generation, file = state.file, targetYear = state.targetYear;
    const heading = state.renderWidth ? ((state.offset + $('preview-window').clientWidth / 2) / state.renderWidth) : 0.5;
    const wrap = $('is-360').checked;
    state.submitting = true; syncChrome();
    try {
      if (!navigator.onLine) throw new Error('You are offline. Open the archive to revisit a saved journey.');
      if (!state.manualPlace || !$('place-input').value.trim()) await state.locationPromise;
      if (generation !== state.generation || state.file !== file || state.screen !== 'preview') return;
      const place = $('place-input').value.trim();
      const form = new FormData(); form.append('image', file); form.append('target_year', String(targetYear));
      form.append('heading', String(Math.max(0, Math.min(1, heading)))); form.append('is_360', String(wrap));
      form.append('weather_enabled', String(!!$('weather-enabled').checked));
      if (state.location) { form.append('lat', String(state.location.lat)); form.append('lon', String(state.location.lon)); }
      if (state.manualPlace && place) form.append('place', place);
      const response = await fetch('/jobs', { method: 'POST', body: form });
      if (!response.ok) {
        let detail = await response.text();
        try { const body = JSON.parse(detail); detail = typeof body.detail === 'string' ? body.detail : body.message; } catch { /* The API also returns plain, readable error messages. */ }
        throw new Error(detail || `The request failed (${response.status}). Please try again shortly.`);
      }
      const job = await response.json();
      if (!job.job_id) throw new Error('The service returned no journey id. Please try again.');
      rememberJob({ job_id: job.job_id, target_year: targetYear, anchor_year: targetYear, place: place || 'Unknown city', status: 'running', provider: state.health?.provider });
      if (generation !== state.generation || state.file !== file || state.screen !== 'preview') {
        showToast('Journey submitted. You can follow it from the archive.');
        return;
      }
      state.targetYear = targetYear;
      // The request heading is intentionally captured at submit time for tile
      // prioritisation. The user may keep turning the phone while the request
      // is queued, though, so hand the viewer's current position to the result
      // screen instead of snapping back to that older request heading.
      const displayHeading = state.renderWidth ?
        (state.offset + $('preview-window').clientWidth / 2) / state.renderWidth : heading;
      await startJob(job.job_id, false, displayHeading, targetYear);
    } catch (error) {
      if (generation === state.generation) showToast(error.message || 'Connection failed. Your photo is kept, so you can try again.', 8000);
    } finally { state.submitting = false; syncChrome(); }
  });

  async function startJob(jobId, replay = false, heading = 0.5, targetYear = null) {
    stopJourney();
    const generation = state.generation;
    if (replay) {
      state.file = null; state.fileOrigin = null;
      if (state.fileURL) URL.revokeObjectURL(state.fileURL);
      state.fileURL = null; state.imageWidth = 0; state.imageHeight = 0;
    } else state.fileOrigin = jobId;
    state.jobId = jobId; state.manifest = null; state.geometryKey = null;
    state.viewingReplay = replay;
    state.expectedYear = replay ? null : targetYear;
    state.yearMismatch = false; state.yearDraft = null;
    state.loadedTiles = new Set(); state.originalImage = null; state.finalLoaded = false;
    state.revealed = false; state.pastPercent = 100; state.offlineSaved = false; state.cachePending = false;
    state.viewMode = 'past'; state.viewRevision++; state.receiptStatus = null; state.renderWidth = 0;
    state.initialHeading = heading; state.wrap = false; state.offset = 0;
    state.activeWeather = null; state.weatherRevision++;
    clearHotspots(); state.hotspotHintShown = false;
    $('generation-overlay').hidden = false; $('progress-strip').hidden = false;
    text('generation-title', replay ? 'Revisiting this moment' : 'Slowing time down');
    text('generation-detail', replay ? 'Opening the saved panorama…' : 'Reading your panorama…');
    text('progress-text', 'Ready'); text('progress-count', '0 / 0'); $('progress-fill').style.width = '0%';
    $('download-button').hidden = true; $('metrics-panel').hidden = true; $('historical-context').hidden = true; $('place-warning').hidden = true;
    $('metrics-toggle').setAttribute('aria-expanded', 'false');
    $('replay-badge').hidden = !replay; text('result-mode', '');
    text('result-place', ''); text('result-subtitle', 'An older view, opening up in front of you.');
    text('result-year', targetYear ?? '—'); text('reveal-year', targetYear ?? '—');
    $('past-label').innerHTML = `${escapeHTML(targetYear ?? 'pending')} <span>REIMAGINED</span>`;
    document.title = `${targetYear ?? 'Loading'} · CENTURY PANO`;
    for (const canvas of [$('original-canvas'), $('past-canvas')]) { canvas.width = 1; canvas.height = 1; }
    showScreen('result');
    history.replaceState(null, '', `?replay=${encodeURIComponent(jobId)}`);
    if (!replay && state.fileURL) {
      try {
        const image = await loadImage(state.fileURL);
        if (generation !== state.generation) return;
        for (const canvas of [$('original-canvas'), $('past-canvas')]) {
          canvas.width = Math.min(image.naturalWidth, 6000); canvas.height = Math.round(canvas.width / image.naturalWidth * image.naturalHeight);
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        }
      } catch { /* Server preview will replace the temporary image. */ }
    }
    if (generation !== state.generation) return;
    resizeViewport();
    pollManifest(generation);
  }
  function duplicateCanvas(canvas, width, height) {
    if (state.wrap) canvas.getContext('2d').drawImage(canvas, 0, 0, width, height, width, 0, width, height);
  }
  async function prepareGeometry(manifest, generation) {
    const geometry = manifest.geometry;
    if (!geometry?.W || !geometry?.H) return false;
    const key = `${manifest.job_id}:${geometry.W}:${geometry.H}:${geometry.wrap}`;
    if (key === state.geometryKey && state.originalImage) return true;
    const image = await loadImage(`/jobs/${encodeURIComponent(manifest.job_id)}/preview`);
    if (generation !== state.generation) return false;
    state.wrap = !!geometry.wrap; state.geometryKey = key; state.originalImage = image;
    state.loadedTiles.clear();
    for (const canvas of [$('original-canvas'), $('past-canvas')]) {
      canvas.width = geometry.W * (state.wrap ? 2 : 1); canvas.height = geometry.H;
      canvas.getContext('2d').drawImage(image, 0, 0, geometry.W, geometry.H);
      duplicateCanvas(canvas, geometry.W, geometry.H);
    }
    resizeViewport();
    state.offset = constrainOffset(state.initialHeading * state.renderWidth - $('pano-viewport').clientWidth / 2);
    resetMotionOrigin();
    state.gyroTarget = state.offset; render(); return true;
  }
  function placeName(place) { return typeof place === 'string' ? place : place?.name || 'Unknown city'; }
  function isDemo(manifest) { return !!manifest.demo || manifest.provider === 'demo' || manifest.tiles?.some((tile) => tile.provider === 'demo'); }
  function weatherBlock(manifest) { return manifest?.weather || null; }
  function weatherVariants(manifest) {
    const weather = weatherBlock(manifest);
    if (!weather?.enabled) return [];
    const ids = weather.ids || Object.keys(weather.variants || {});
    return ids.map((id) => ({ id, ...(weather.variants?.[id] || { id, label: id }) }));
  }
  function activeVariant(manifest) {
    const weather = weatherBlock(manifest);
    if (!weather?.enabled) return null;
    const id = state.activeWeather || weather.active || weather.ids?.[0];
    return id ? { id, ...(weather.variants?.[id] || {}) } : null;
  }
  function viewTiles(manifest) {
    const variant = activeVariant(manifest);
    return variant?.tiles || manifest.tiles || [];
  }
  function viewResultPath(manifest) {
    const variant = activeVariant(manifest);
    if (variant?.result?.path) return assetURL(variant.result.path);
    return `/jobs/${encodeURIComponent(manifest.job_id)}/result`;
  }
  function renderWeatherOptions(manifest) {
    const host = $('weather-options');
    const variants = weatherVariants(manifest);
    const icons = { clear: 'i-sun', rain: 'i-rain', snow: 'i-snow' };
    if (state.screen !== 'result' || variants.length < 2) {
      host.hidden = true; host.innerHTML = ''; return;
    }
    const active = state.activeWeather || weatherBlock(manifest)?.active || variants[0].id;
    host.hidden = false;
    host.innerHTML = variants.map((variant) => {
      const pressed = variant.id === active;
      const label = escapeHTML(variant.label || variant.id);
      const icon = icons[variant.id] || 'i-sun';
      const ready = ['done', 'done_partial'].includes(variant.status) || (variant.tiles || []).some((tile) => tile.status === 'done');
      return `<button type="button" data-weather="${escapeHTML(variant.id)}" aria-label="${label}" title="${label}" aria-pressed="${pressed}" class="${pressed ? 'active' : ''}" ${ready ? '' : 'disabled'}><svg aria-hidden="true"><use href="#${icon}"/></svg></button>`;
    }).join('');
  }
  async function switchWeather(weatherId) {
    if (!state.manifest || state.activeWeather === weatherId) return;
    const variant = state.manifest.weather?.variants?.[weatherId];
    if (!variant) return;
    state.activeWeather = weatherId;
    state.weatherRevision++;
    const revision = state.weatherRevision;
    state.loadedTiles = new Set();
    state.finalLoaded = false;
    const geometry = state.manifest.geometry;
    if (geometry) {
      const ctx = $('past-canvas').getContext('2d');
      ctx.clearRect(0, 0, $('past-canvas').width, $('past-canvas').height);
    }
    renderWeatherOptions(state.manifest);
    const generation = state.generation;
    const tiles = variant.tiles || [];
    await Promise.all(tiles.filter((tile) => tile.status === 'done').map(async (tile) => {
      try {
        const image = await loadImage(tile.path ? assetURL(tile.path) : `/jobs/${encodeURIComponent(state.manifest.job_id)}/tiles/${tile.i}`);
        if (generation !== state.generation || revision !== state.weatherRevision) return;
        const ctx = $('past-canvas').getContext('2d');
        ctx.drawImage(image, tile.x, 0, geometry.tile_w || 1024, geometry.H);
        if (state.wrap && tile.x + (geometry.tile_w || 1024) > geometry.W) {
          ctx.drawImage(image, tile.x - geometry.W, 0, geometry.tile_w || 1024, geometry.H);
        }
        state.loadedTiles.add(tile.i);
        duplicateCanvas($('past-canvas'), geometry.W, geometry.H);
      } catch { /* Missing weather tiles retry on the next poll. */ }
    }));
    if (generation !== state.generation || revision !== state.weatherRevision) return;
    if (variant.result?.status === 'done') {
      try {
        const image = await loadImage(viewResultPath(state.manifest));
        if (generation !== state.generation || revision !== state.weatherRevision) return;
        const ctx = $('past-canvas').getContext('2d');
        ctx.drawImage(image, 0, 0, geometry.W, geometry.H);
        duplicateCanvas($('past-canvas'), geometry.W, geometry.H);
        state.finalLoaded = true;
        $('download-button').href = viewResultPath(state.manifest);
        $('download-button').hidden = false;
      } catch { /* Keep progressive tiles if the stitched result is not ready. */ }
    }
    render();
    syncChrome();
  }
  function renderHistoricalContext(manifest) {
    const context = manifest.constraints?.historical_context;
    const panel = $('historical-context'); panel.hidden = false;
    if (!context) {
      panel.innerHTML = '<h3>Historical context</h3><p>No site history was recorded for this journey. The view is an imagined reconstruction, and its buildings and land use are unverified.</p>';
      return;
    }
    const fallback = context.evidence_basis === 'fallback';
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(context.reference_date || '');
    const reference = date ? `${Number(date[3])} ${['January','February','March','April','May','June','July','August','September','October','November','December'][Number(date[2]) - 1]} ${date[1]}` : `1 July ${context.target_year ?? yearOf(manifest) ?? 'the chosen year'}`;
    const siteLabels = { undeveloped: 'undeveloped', agricultural: 'agricultural', built: 'built up', mixed: 'mixed use', unknown: 'not established' };
    const list = (heading, values) => Array.isArray(values) && values.length ? `<div class="history-section"><h4>${heading}</h4><ul>${values.map((value) => `<li>${escapeHTML(value)}</li>`).join('')}</ul></div>` : '';
    panel.innerHTML = `<div class="history-heading"><h3>Estimated historical context</h3><span>${escapeHTML(reference)} · reference date</span></div>`
      + `<p class="history-status">${fallback ? 'Site history not established · conservative estimate' : 'Estimated from model knowledge · not checked against sources'}</p>`
      + `<p>${escapeHTML(context.period_summary || 'The context for this site in the target year has not been established.')}</p>`
      + `<p><strong>Estimated land use: ${escapeHTML(siteLabels[context.site_state] || siteLabels.unknown)}</strong>${context.site_history ? `<br>${escapeHTML(context.site_history)}` : ''}</p>`
      + list('Local context', context.local_context)
      + list('Basis for the reconstruction', context.reconstruction_changes)
      + namesList(context.name_dates)
      + list('Still unverified', context.uncertainties)
      + '<p class="history-footnote">The same site may once have been open land, farmland, or held different buildings. This panorama is not evidence that today\'s buildings stood in the chosen year; both the image and the context need checking against historical records.</p>';
  }
  function updateMetadata(manifest) {
    const demo = isDemo(manifest), replay = manifest.mode === 'replay' || state.viewingReplay;
    const year = yearOf(manifest);
    if (year !== null) state.targetYear = year;
    if (state.receiptStatus !== manifest.status) { rememberJob(manifest); state.receiptStatus = manifest.status; }
    const unrecognizedCity = manifest.place?.source === 'manual' && manifest.place?.prompt_safe === false;
    $('place-warning').hidden = !unrecognizedCity;
    if (unrecognizedCity) {
      const warning = 'That city was not recognised and was not used for the history. Add a state or country, or use the photo location.';
      text('place-warning', warning); text('location-note', warning);
    }
    text('result-place', placeName(manifest.place)); text('result-year', year ?? '—');
    text('reveal-year', year ?? '—');
    $('past-label').innerHTML = `${escapeHTML(year ?? 'pending')} <span>REIMAGINED</span>`;
    document.title = `${year ?? 'Year pending'} · ${placeName(manifest.place)} · CENTURY PANO`;
    $('replay-badge').hidden = !replay;
    text('result-mode', (demo ? 'Local demo · no AI called' : replay ? 'Archived journey · no generation call' : 'AI imagined reconstruction') + (manifest.scene?.is_outdoor === false ? ' · indoor scene, limited effect' : ''));
    text('result-note', demo ? 'The engineering sample and local grading exist to verify the flow. They do not represent AI reconstruction.' : 'The scene is estimated from the chosen year and the location, so buildings and land use may differ from today.');
    if (manifest.weather?.enabled && !state.activeWeather) {
      state.activeWeather = manifest.weather.active || manifest.weather.ids?.[0] || null;
    }
    const variants = weatherVariants(manifest);
    let done = 0, total = 0;
    if (variants.length) {
      const tileCount = manifest.geometry?.n || 0;
      total = tileCount * variants.length;
      for (const variant of variants) {
        done += (variant.tiles || []).filter((tile) => ['done', 'error'].includes(tile.status)).length;
      }
    } else {
      done = manifest.tiles?.filter((tile) => ['done', 'error'].includes(tile.status)).length || 0;
      total = manifest.geometry?.n || manifest.tiles?.length || 0;
    }
    $('progress-fill').style.width = `${total ? done / total * 100 : 0}%`;
    text('progress-count', `${done} / ${total || '—'} views`);
    const stage = manifest.stage;
    let progress = done ? 'Time is opening up. Drag to explore what is finished.' : stage === 'history' ? 'Working out the local history and how this site changed' : manifest.anchor?.status === 'running' ? 'Establishing one consistent era and light for the whole scene' : stage === 'preprocess' ? 'Preparing the panorama' : 'Reading the scene and the year you chose';
    if (manifest.status === 'done') progress = replay ? 'Archive opened · figures come from the original run' : 'Journey complete';
    if (manifest.status === 'done_partial') progress = 'Some views did not generate, and their originals were kept';
    if (manifest.status === 'error') progress = 'The journey stopped early';
    text('progress-text', progress); text('generation-detail', progress);
    if (done > 0) $('generation-overlay').hidden = true;
    $('progress-strip').hidden = state.finalLoaded && ['done', 'done_partial'].includes(manifest.status);
    renderWeatherOptions(manifest);
    syncChrome();
    renderHistoricalContext(manifest);
    renderMetrics(manifest);
    renderHotspots(manifest);
  }
  async function applyManifest(manifest, generation) {
    if (generation !== state.generation) return;
    state.manifest = manifest; updateMetadata(manifest);
    let ready = false;
    try { ready = await prepareGeometry(manifest, generation); } catch { /* Preview may not exist during preprocessing. */ }
    if (!ready || generation !== state.generation) return;
    renderHotspots(manifest);
    const geometry = manifest.geometry;
    const tiles = viewTiles(manifest);
    const arrivals = tiles.filter((tile) => ['done', 'error'].includes(tile.status) && !state.loadedTiles.has(tile.i));
    await Promise.all(arrivals.map(async (tile) => {
      try {
        if (tile.status === 'done') {
          const image = await loadImage(tile.path ? assetURL(tile.path) : `/jobs/${encodeURIComponent(manifest.job_id)}/tiles/${tile.i}`);
          if (generation !== state.generation || state.finalLoaded) return;
          const ctx = $('past-canvas').getContext('2d');
          ctx.drawImage(image, tile.x, 0, geometry.tile_w || 1024, geometry.H);
          if (state.wrap && tile.x + (geometry.tile_w || 1024) > geometry.W) {
            ctx.drawImage(image, tile.x - geometry.W, 0, geometry.tile_w || 1024, geometry.H);
          }
        } else {
          const ctx = $('past-canvas').getContext('2d'); ctx.fillStyle = 'rgba(132, 113, 69, 0.10)';
          ctx.fillRect(tile.x, 0, geometry.tile_w || 1024, geometry.H);
        }
        state.loadedTiles.add(tile.i);
        duplicateCanvas($('past-canvas'), geometry.W, geometry.H);
      } catch { /* Retry missing assets with the next manifest poll. */ }
    }));
    if (generation !== state.generation) return;
    syncChrome();
    const resultReady = activeVariant(manifest)?.result?.status === 'done' || manifest.result?.status === 'done';
    if (resultReady && !state.finalLoaded) {
      try {
        const image = await loadImage(viewResultPath(manifest));
        if (generation !== state.generation) return;
        const ctx = $('past-canvas').getContext('2d'); ctx.drawImage(image, 0, 0, geometry.W, geometry.H);
        duplicateCanvas($('past-canvas'), geometry.W, geometry.H);
        state.finalLoaded = true; $('generation-overlay').hidden = true;
        $('progress-strip').hidden = true;
        $('download-button').href = viewResultPath(manifest);
        $('download-button').hidden = false;
        text('result-subtitle', isDemo(manifest) ? 'Engineering sample. Drag the handle to compare then and now.' : 'Time has travelled far. The viewpoint never moved.');
        if (manifest.status === 'done_partial') showToast('Some areas could not be reconstructed, so their originals were kept.');
        syncChrome();
        await reveal(generation);
        if (generation === state.generation) cacheJourney(manifest);
      } catch { text('progress-text', 'Saving the result, almost there…'); }
    }
    render();
  }
  async function pollManifest(generation, failures = 0) {
    if (generation !== state.generation) return;
    try {
      const response = await fetch(`/jobs/${encodeURIComponent(state.jobId)}/manifest`, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? 'That journey does not exist, or this device has not saved it.' : 'Cannot reach the service right now');
      const manifest = await response.json();
      if (generation !== state.generation) return;
      if (state.expectedYear !== null && yearOf(manifest) !== null && yearOf(manifest) !== state.expectedYear) {
        state.yearMismatch = true;
        $('generation-overlay').hidden = false;
        text('generation-title', 'The year came back different');
        text('generation-detail', `You chose ${state.expectedYear}. Please generate again.`);
        text('progress-text', 'Stopped loading rather than show another year');
        syncChrome(); return;
      }
      await applyManifest(manifest, generation);
      if (generation !== state.generation) return;
      if (manifest.status === 'error') {
        $('generation-overlay').hidden = false;
        text('generation-title', 'This journey will have to wait');
        text('generation-detail', manifest.error || 'Generation did not finish. Go back and try again.');
        text('result-subtitle', 'Your photo is still here, so you can start over.');
        showToast(manifest.error || 'Generation failed. Start a new journey, or open the archive.', 9000);
        return;
      }
      if (['done', 'done_partial'].includes(manifest.status) && state.finalLoaded) {
        if (manifest.hotspots?.provisional) {
          state.pollTimer = setTimeout(() => pollManifest(generation, 0), 900);
          return;
        }
        return;
      }
      state.pollTimer = setTimeout(() => pollManifest(generation, 0), 500);
    } catch (error) {
      if (generation !== state.generation) return;
      text('progress-text', navigator.onLine ? 'Connection interrupted, retrying…' : 'Network is down, waiting to reconnect…');
      if (failures === 1) showToast(error.message || 'Connection lost. This continues on its own once the network is back.');
      if (failures > 10) {
        $('generation-overlay').hidden = false;
        text('generation-title', 'Your journey is waiting here');
        text('generation-detail', 'Cannot connect right now, retrying. You can also go back to the archive.');
      }
      state.pollTimer = setTimeout(() => pollManifest(generation, failures + 1), Math.min(5000, 1000 + failures * 500));
    }
  }
  async function reveal(generation) {
    if (state.revealed || generation !== state.generation) return;
    state.revealed = true;
    if (state.viewMode !== 'past' || state.clean || state.drag) return;
    const viewRevision = state.viewRevision;
    state.revealing = true; state.drag = null;
    const center = (state.offset + $('pano-viewport').clientWidth / 2) / state.renderWidth;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ease = (t) => (t < .5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    const sweep = (from, to, duration) => new Promise((resolve) => {
      if (!duration) { setPastPercent(to); resolve(); return; }
      const start = performance.now();
      function animate(now) {
        if (generation !== state.generation || viewRevision !== state.viewRevision) { resolve(); return; }
        const t = Math.min(1, (now - start) / duration);
        setPastPercent(from + (to - from) * ease(t));
        if (t < 1) requestAnimationFrame(animate); else resolve();
      }
      requestAnimationFrame(animate);
    });
    // The final canvas is drawn while the progressive past layer may still be
    // fully visible. Hide it in the same task before the first animation frame
    // so the reveal always starts on the original image, never on a one-frame
    // flash of the completed historical image.
    setPastPercent(0);
    document.body.classList.add('revealing'); resizeViewport();
    state.offset = constrainOffset(center * state.renderWidth - $('pano-viewport').clientWidth / 2); render();
    // Start from the present as a deliberate "before", hold, then sweep into the past.
    await sweep(state.pastPercent, 0, reduced ? 0 : 420);
    if (generation !== state.generation) return;
    await new Promise((resolve) => setTimeout(resolve, reduced ? 60 : 320));
    if (generation !== state.generation) return;
    await sweep(0, 100, reduced ? 0 : 1500);
    if (generation !== state.generation) return;
    document.body.classList.remove('revealing'); state.revealing = false;
    resizeViewport(); state.offset = constrainOffset(center * state.renderWidth - $('pano-viewport').clientWidth / 2);
    resetMotionOrigin();
    if (viewRevision === state.viewRevision) setPastPercent(100);
    syncChrome();
  }

  // Dated wordmarks. The removed ones are the checkable claim in the whole
  // reconstruction: a name carries a date, and the date decides whether the
  // lettering belongs in the chosen year.
  function namesList(entries) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const rows = entries.map((entry) => {
      const year = Number.isFinite(entry?.earliest_year) ? entry.earliest_year : null;
      const status = entry?.anachronistic ? `removed \u2014 not in use here before ${year}`
        : year ? `kept \u2014 in use by ${year}` : 'kept \u2014 date unknown';
      return `<li><strong>${escapeHTML(entry?.name ?? '')}</strong> \u00b7 ${escapeHTML(status)}`
        + (entry?.note ? `<br><small>${escapeHTML(entry.note)}</small>` : '') + '</li>';
    }).join('');
    return `<h4>Signage checked against the year</h4><ul>${rows}</ul>`;
  }
  function clearHotspots() {
    state.activeHotspot = null; state.hotspotKey = ''; state.explaining = false;
    const layer = $('hotspot-layer');
    layer.hidden = true; layer.innerHTML = '';
    $('hotspot-card').hidden = true;
    document.body.classList.remove('hotspots-ready');
  }
  function syncHotspotVisibility() {
    const show = state.screen === 'result' && state.viewMode !== 'present' && state.pastPercent >= 20
      && (state.manifest?.hotspots?.items?.length > 0);
    $('hotspot-layer').hidden = !show;
  }
  function hotspotMarkup(item, shift = 0) {
    const [x0, y0, x1, y1] = item.bbox || [0, 0, 0, 0];
    const [pointX, pointY] = item.point || [(x0 + x1) / 2, (y0 + y1) / 2];
    const leftPct = state.wrap ? ((pointX + shift) * 50).toFixed(3) : (pointX * 100).toFixed(3);
    return `<div class="hotspot" data-id="${escapeHTML(item.id)}" data-shift="${shift}" style="left:${leftPct}%;top:${(pointY * 100).toFixed(3)}%"><span class="hotspot-label">${escapeHTML(item.label)}</span></div>`;
  }
  function renderHotspots(manifest) {
    const items = manifest?.hotspots?.items || [];
    const key = `${manifest?.job_id || ''}:${state.wrap ? 'w' : 's'}:${items.map((item) => item.id).join(',')}:${manifest?.hotspots?.provisional ? 'p' : 'f'}`;
    if (!items.length) {
      if (manifest?.status && ['done', 'done_partial'].includes(manifest.status) && state.finalLoaded
          && !state.hotspotKey.endsWith(':requested')) {
        requestHotspots(manifest.job_id);
      } else if (key !== state.hotspotKey) {
        clearHotspots();
        state.hotspotKey = key;
      }
      return;
    }
    if (key === state.hotspotKey) {
      syncHotspotVisibility();
      return;
    }
    state.hotspotKey = key;
    const layer = $('hotspot-layer');
    let html = items.map((item) => hotspotMarkup(item, 0)).join('');
    if (state.wrap) html += items.map((item) => hotspotMarkup(item, 1)).join('');
    layer.innerHTML = html;
    layer.hidden = false;
    document.body.classList.add('hotspots-ready');
    syncHotspotVisibility();
    if (!state.hotspotHintShown && state.revealed) {
      state.hotspotHintShown = true;
      showToast('Tap a white dot to ask about that place.', 4200);
    }
  }
  async function requestHotspots(jobId) {
    if (!jobId) return;
    state.hotspotKey = `${jobId}:requested`;
    try {
      const response = await fetch(`/jobs/${encodeURIComponent(jobId)}/hotspots`, { method: 'POST' });
      if (!response.ok) { state.hotspotKey = ''; return; }
      const hotspots = await response.json();
      if (state.manifest?.job_id === jobId) {
        state.manifest.hotspots = hotspots;
        renderHotspots(state.manifest);
        if (hotspots.provisional) {
          state.pollTimer = setTimeout(() => pollManifest(state.generation, 0), 900);
        }
      }
    } catch { state.hotspotKey = ''; }
  }
  function panoramaPoint(clientX, clientY) {
    const bounds = $('pano-viewport').getBoundingClientRect();
    const y = (activeViewport().clientHeight - state.renderHeight) / 2;
    const localX = state.offset + (clientX - bounds.left);
    const localY = clientY - bounds.top - y;
    if (localY < 0 || localY > state.renderHeight || state.renderWidth <= 0 || state.renderHeight <= 0) return null;
    let xNorm = localX / state.renderWidth;
    if (state.wrap) xNorm = ((xNorm % 1) + 1) % 1;
    else if (xNorm < 0 || xNorm > 1) return null;
    return { x: xNorm, y: localY / state.renderHeight };
  }
  function hitTestHotspot(clientX, clientY) {
    const point = panoramaPoint(clientX, clientY);
    const items = state.manifest?.hotspots?.items || [];
    if (!point || !items.length || state.pastPercent < 35 || state.viewMode === 'present') return null;
    let best = null, bestDistance = Infinity;
    for (const item of items) {
      const [x0, y0, x1, y1] = item.bbox;
      const [hotspotX, hotspotY] = item.point || [(x0 + x1) / 2, (y0 + y1) / 2];
      let dx = Math.abs(point.x - hotspotX);
      if (state.wrap) dx = Math.min(dx, 1 - dx);
      const distance = Math.hypot(dx * state.renderWidth, (point.y - hotspotY) * state.renderHeight);
      // The visible dot stays subtle, while its touch target meets mobile accessibility guidance.
      if (distance <= 24 && distance < bestDistance) { best = item; bestDistance = distance; }
    }
    return best;
  }
  function closeHotspotCard() {
    state.activeHotspot = null; state.explaining = false;
    $('hotspot-card').hidden = true;
    $('hotspot-layer').querySelectorAll('.hotspot.active').forEach((node) => node.classList.remove('active'));
  }
  async function handleHotspotTap(clientX, clientY) {
    if (state.screen !== 'result' || !state.finalLoaded || state.revealing) return;
    const hotspot = hitTestHotspot(clientX, clientY);
    if (!hotspot) {
      if (!$('hotspot-card').hidden) closeHotspotCard();
      return;
    }
    state.activeHotspot = hotspot.id;
    $('hotspot-layer').querySelectorAll('.hotspot').forEach((node) => {
      node.classList.toggle('active', node.dataset.id === hotspot.id);
    });
    $('hotspot-card').hidden = false;
    text('hotspot-card-kicker', yearOf(state.manifest) ? `Around ${yearOf(state.manifest)}` : 'This place');
    text('hotspot-card-title', hotspot.label);
    text('hotspot-card-body', 'Asking the historian about this region…');
    $('hotspot-card-note').hidden = true;
    if (!state.jobId) {
      text('hotspot-card-body', 'This journey is not available for explanations.');
      return;
    }
    state.explaining = true;
    const generation = state.generation;
    try {
      const response = await fetch(`/jobs/${encodeURIComponent(state.jobId)}/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotspot_id: hotspot.id }),
      });
      if (generation !== state.generation || state.activeHotspot !== hotspot.id) return;
      if (!response.ok) {
        text('hotspot-card-body', await response.text() || 'The explanation could not be loaded.');
        return;
      }
      const data = await response.json();
      if (generation !== state.generation || state.activeHotspot !== hotspot.id) return;
      text('hotspot-card-title', data.label || hotspot.label);
      const sections = [];
      if (data.distinctive) sections.push(`<span>What stands out</span>${escapeHTML(data.distinctive)}`);
      if (data.significance) sections.push(`<span>Why it matters</span>${escapeHTML(data.significance)}`);
      if (data.past) sections.push(`<span>Then</span>${escapeHTML(data.past)}`);
      if (data.present) sections.push(`<span>Compared with today</span>${escapeHTML(data.present)}`);
      $('hotspot-card-body').innerHTML = sections.length
        ? sections.map((section) => `<span class="hotspot-card-section">${section}</span>`).join('')
        : 'No description was returned for this region.';
      if (data.uncertainty) {
        text('hotspot-card-note', data.uncertainty);
        $('hotspot-card-note').hidden = false;
      } else $('hotspot-card-note').hidden = true;
    } catch {
      if (generation === state.generation && state.activeHotspot === hotspot.id) {
        text('hotspot-card-body', 'Could not reach the explanation service.');
      }
    } finally {
      if (generation === state.generation) state.explaining = false;
    }
  }
  $('hotspot-card-close').addEventListener('click', closeHotspotCard);

  function metricNumber(value, suffix = ' s') { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) + suffix : '—'; }
  function renderMetrics(manifest) {
    const metrics = manifest.metrics || {}, seam = metrics.seam_err || {}, align = metrics.alignment || {};
    const whole = metrics.integrity || {};
    const cells = [
      ['First view', metricNumber(metrics.first_view_s), 'the first reconstructed view to finish'],
      ['Whole journey', metricNumber(metrics.total_s), 'wall-clock time for this run'],
      ['Seam difference · generated → final', `${metricNumber(seam.raw, '')} → ${metricNumber(seam.at_seam_cut ?? seam.after_color_match, '')}`,
        seam.at_seam_cut == null ? `after grading ${metricNumber(seam.after_color_match, '')}` :
          `graded ${metricNumber(seam.after_color_match, '')} · exposure matched ${metricNumber(seam.after_compensation, '')} · ${seam.carved_seams ?? 0} seams carved`],
      ['Speed-up vs serial', metricNumber(metrics.speedup, '×'), metrics.serial_baseline_s == null ? 'serial baseline not measured yet' : `serial baseline ${metricNumber(metrics.serial_baseline_s)}`],
      ['Pixel alignment · before / after', `${metricNumber(align.score_before, '')} / ${metricNumber(align.score_after, '')}`,
        align.mean_shift_px == null ? 'not measured yet' : `mean drift ${metricNumber(align.mean_shift_px, ' px')} · ${align.applied ?? 0} corrected`],
    ];
    if (whole.tested) {
      cells.push(['Broken tiles · detected / still broken',
        `${whole.splits_detected ?? 0} / ${whole.unresolved ?? 0}`,
        whole.splits_detected ? `${whole.retries ?? 0} regenerated · worst break ${metricNumber(whole.worst_step_de, '')}`
          : `all ${whole.tested} tiles came back as one picture`]);
    }
    $('metrics-panel').innerHTML = cells.map(([name, value, note]) => `<div class="metric"><span>${escapeHTML(name)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></div>`).join('') + `<p class="metrics-note">${isDemo(manifest) ? 'These figures come from the local demo pipeline and say nothing about the speed or quality of an AI service.' : 'Measured on this journey\'s actual run. A replay is not re-timed.'} A dash means not yet measured. Seam difference is a Lab distance, and lower means two tiles agree more closely; it says nothing about historical accuracy. The final figure is measured along the path we actually cut: where neighbouring tiles drew different objects we do not average them into a ghost, we cut along the one vertical line where they agree most.${manifest.scene?.fallback ? ' Scene parsing fell back to defaults.' : ''}${manifest.anchor?.status === 'skipped' ? ' No era reference was generated, so colour matching was skipped.' : ''}${manifest.scene?.is_outdoor === false ? ' This is an interior: the reconstruction only changes materials and furnishings, which reads more weakly than an outdoor street.' : ''} Pixel alignment is the correlation between the edge structure of the original and the generation, where 1 means they coincide exactly.${whole.unresolved ? ' One tile came back as two pictures joined along a hard vertical line, and asking again did not fix it, so that break is still in this panorama.' : ''}</p>`;
  }
  $('metrics-toggle').addEventListener('click', () => {
    const open = $('metrics-panel').hidden;
    $('metrics-panel').hidden = !open; $('metrics-toggle').setAttribute('aria-expanded', String(open));
    $('metrics-toggle').lastElementChild.textContent = open ? '−' : '+';
  });

  // A phone panorama does not record its sweep angle, but width/height is a good
  // proxy: a wider strip was swept further. Roughly 55° of sweep per unit of aspect.
  function panoFovDegrees() {
    if (state.wrap) return 360;
    const geometry = state.manifest?.geometry;
    const aspect = geometry?.W && geometry?.H ? geometry.W / geometry.H : state.imageWidth && state.imageHeight ? state.imageWidth / state.imageHeight : 3;
    return Math.max(90, Math.min(360, 55 * aspect)) * (state.gyroSensitivity || 1);
  }
  function resetMotionOrigin() {
    state.gyroHeading = null; state.gyroTarget = state.offset;
  }
  function motionPrompt(label, message = '') {
    clearTimeout(enableGyro.hideTimer);
    text('motion-label', label); $('motion-button').hidden = !motionDevice;
    $('gyro-hint').hidden = !message; text('gyro-hint', message);
    if (motionDevice) $('gesture-hint').hidden = true;
  }
  function disableGyro() {
    state.gyroRequest++; state.gyroPending = false; state.gyro = false; state.gyroSeen = false;
    resetMotionOrigin();
    window.removeEventListener('deviceorientation', onOrientation);
    clearTimeout(enableGyro.timer); clearTimeout(enableGyro.hideTimer);
    $('gyro-button').innerHTML = '<svg><use href="#i-gyro"/></svg>Follow my phone';
    $('gyro-button').disabled = false; $('motion-button').disabled = false;
    $('gyro-button').setAttribute('aria-pressed', 'false'); $('recenter-button').hidden = true;
    $('motion-button').hidden = true;
  }
  function gyroFallback(message) {
    disableGyro();
    motionPrompt('Tap to try motion again', message);
    showToast(message, 7000);
  }
  function onOrientation(event) {
    if (!state.gyro) return;
    if (Number.isFinite(event.alpha)) state.gyroSignal = true;
    const heading = CenturyMotion.headingFromOrientation(event);
    // Some phones initially emit null readings, or point their camera straight up.
    if (heading === null) { resetMotionOrigin(); return; }
    if (!state.gyroSeen) {
      state.gyroSeen = true; clearTimeout(enableGyro.timer);
      $('gyro-button').innerHTML = '<svg><use href="#i-check"/></svg>Following your phone';
      motionPrompt('On · turn the phone to explore');
      enableGyro.hideTimer = setTimeout(() => { $('motion-button').hidden = true; }, 2800);
    }
    if (state.drag || state.revealing || document.hidden || $('options-dialog').open || $('replay-dialog').open) {
      resetMotionOrigin(); return;
    }
    if (state.gyroHeading === null) { state.gyroHeading = heading; state.gyroTarget = state.offset; return; }
    const delta = CenturyMotion.shortestDelta(heading, state.gyroHeading);
    state.gyroHeading = heading;
    // Integrating short steps preserves a full turn without a jump at +/-180°.
    state.gyroTarget = constrainOffset(state.gyroTarget + delta * state.renderWidth / panoFovDegrees());
  }
  async function enableGyro() {
    if (state.gyroPending) return;
    const request = ++state.gyroRequest;
    try {
      if (!window.isSecureContext) { gyroFallback('Motion needs HTTPS. Open the phone preview link instead.'); return; }
      if (!window.DeviceOrientationEvent) { gyroFallback('This browser exposes no orientation sensor. Open it in Safari or Chrome on a phone.'); return; }
      state.gyroPending = true;
      $('gyro-button').disabled = true; $('motion-button').disabled = true;
      // Keep the permission call inside the original tap's user activation on iOS.
      if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await window.DeviceOrientationEvent.requestPermission();
        if (request !== state.gyroRequest) return;
        if (permission !== 'granted') { gyroFallback('Motion permission was refused. Allow motion and orientation access in your browser site settings, then retry.'); return; }
      }
      if (request !== state.gyroRequest) return;
      state.gyro = true; state.gyroSeen = false; state.gyroSignal = false; resetMotionOrigin();
      window.addEventListener('deviceorientation', onOrientation);
      $('gyro-button').innerHTML = '<svg><use href="#i-gyro"/></svg>Pause motion';
      $('gyro-button').setAttribute('aria-pressed', 'true'); $('recenter-button').hidden = false;
      motionPrompt('Hold the phone upright and turn gently');
      clearTimeout(enableGyro.timer);
      enableGyro.timer = setTimeout(() => {
        if (state.gyro && !state.gyroSeen) {
          motionPrompt(state.gyroSignal ? 'Hold the phone upright, facing forward' : 'No orientation received · tap to retry', state.gyroSignal ?
            'Hold the phone upright with the rear camera facing forward, then turn.' : 'Check your browser\'s motion and orientation permission. You can keep dragging instead.');
        }
      }, 6000);
    } catch { if (request === state.gyroRequest) gyroFallback('Motion could not start. Allow orientation access in Safari or Chrome on a phone and retry.'); }
    finally {
      if (request === state.gyroRequest) {
        state.gyroPending = false; $('gyro-button').disabled = false; $('motion-button').disabled = false;
      }
    }
  }
  $('motion-button').addEventListener('click', () => { if (!state.gyroSeen) enableGyro(); else $('motion-button').hidden = true; });
  $('gyro-button').addEventListener('click', () => {
    if (state.gyro) { disableGyro(); return; }
    closeOptions(); enableGyro();
  });
  $('recenter-button').addEventListener('click', () => { resetMotionOrigin(); showToast('Centred on where you are facing.', 2200); });
  document.addEventListener('visibilitychange', resetMotionOrigin);
  window.addEventListener('orientationchange', resetMotionOrigin);
  window.screen?.orientation?.addEventListener('change', resetMotionOrigin);

  function storedJourneys(key) {
    try {
      const entries = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.job_id === 'string') : [];
    } catch { return []; }
  }
  function localReplays() { return storedJourneys('century-replays'); }
  function rememberJob(manifest) {
    const entries = storedJourneys('century-recent-jobs');
    const previous = entries.find((entry) => entry.job_id === manifest.job_id);
    const coords = entryCoords(manifest);
    const entry = {
      ...previous, job_id: manifest.job_id, place: manifest.place, decade: manifest.decade,
      target_year: yearOf(manifest), anchor_year: manifest.anchor_year, provider: manifest.provider, demo: isDemo(manifest),
      status: manifest.status, metrics: manifest.metrics, saved_at: Date.now(),
      ...(coords ? { lat: coords.lat, lon: coords.lon } : {}),
    };
    try { localStorage.setItem('century-recent-jobs', JSON.stringify([entry, ...entries.filter((item) => item.job_id !== entry.job_id)].slice(0, 24))); }
    catch { /* Storage restrictions do not interrupt the active journey. */ }
  }
  function entryCoords(entry) {
    if (!entry) return null;
    if (Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) return { lat: Number(entry.lat), lon: Number(entry.lon) };
    const place = entry.place;
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) return { lat: Number(place.lat), lon: Number(place.lon) };
    return null;
  }
  function clusterArchivePlaces(entries) {
    const groups = new Map();
    entries.forEach((entry) => {
      const coords = entryCoords(entry);
      if (!coords) return;
      const label = placeName(entry.place);
      const key = label.casefold ? label.casefold() : String(label).toLowerCase();
      const group = groups.get(key) || { key, label, lat: 0, lon: 0, trips: [] };
      group.trips.push(entry);
      const n = group.trips.length;
      group.lat += (coords.lat - group.lat) / n;
      group.lon += (coords.lon - group.lon) / n;
      groups.set(key, group);
    });
    return [...groups.values()];
  }
  let archiveLeaflet = null;
  const archiveMarkers = new Map();
  function destroyArchiveLeaflet() {
    archiveMarkers.clear();
    if (archiveLeaflet) {
      archiveLeaflet.remove();
      archiveLeaflet = null;
    }
    const host = $('archive-leaflet');
    if (host) host.innerHTML = '';
  }
  function closeArchivePlace() {
    const panel = $('archive-place-panel');
    panel.hidden = true;
    $('archive-place-trips').innerHTML = '';
    archiveMarkers.forEach((marker) => {
      const el = marker.getElement?.();
      el?.classList.remove('is-active');
    });
  }
  function openArchivePlace(group, dialog) {
    const panel = $('archive-place-panel');
    panel.hidden = false;
    text('archive-place-title', group.label);
    const trips = $('archive-place-trips');
    trips.innerHTML = '';
    group.trips.forEach((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'archive-place-trip';
      const pending = entry.status === 'running';
      const year = yearOf(entry) ?? 'Journey';
      button.innerHTML = `<img src="/jobs/${encodeURIComponent(entry.job_id)}/${pending ? 'preview' : 'result'}" alt=""><span><strong>${escapeHTML(year)}</strong><small>${pending ? 'In progress' : 'Open this scene'}</small></span>`;
      button.querySelector('img')?.addEventListener('error', (event) => { event.target.hidden = true; }, { once: true });
      button.addEventListener('click', () => { dialog.close(); startJob(entry.job_id, true); });
      trips.appendChild(button);
    });
    archiveMarkers.forEach((marker, key) => {
      const el = marker.getElement?.();
      if (!el) return;
      el.classList.toggle('is-active', key === group.key);
    });
  }
  function renderArchiveMap(entries, dialog) {
    const section = $('archive-map');
    const empty = $('archive-map-empty');
    const places = clusterArchivePlaces(entries);
    section.hidden = false;
    closeArchivePlace();
    empty.hidden = places.length > 0;
    if (typeof L === 'undefined') {
      empty.hidden = false;
      text('archive-map-empty', 'Map library unavailable. Use the journey list below.');
      destroyArchiveLeaflet();
      return;
    }
    if (!archiveLeaflet) {
      archiveLeaflet = L.map('archive-leaflet', {
        zoomControl: false, attributionControl: true, scrollWheelZoom: false,
      }).setView([20, 0], 1);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(archiveLeaflet);
      L.control.zoom({ position: 'topright' }).addTo(archiveLeaflet);
    } else {
      archiveMarkers.forEach((marker) => archiveLeaflet.removeLayer(marker));
      archiveMarkers.clear();
    }
    if (!places.length) {
      archiveLeaflet.setView([20, 0], 1);
      setTimeout(() => archiveLeaflet.invalidateSize(), 50);
      return;
    }
    const bounds = L.latLngBounds([]);
    places.forEach((group) => {
      const mark = group.trips.length > 1 ? String(group.trips.length) : String(yearOf(group.trips[0]) ?? '·').slice(-2);
      const icon = L.divIcon({
        className: 'archive-pin-icon',
        html: `<span>${escapeHTML(mark)}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      });
      const marker = L.marker([group.lat, group.lon], { icon, keyboard: true, title: group.label });
      marker.on('click', () => openArchivePlace(group, dialog));
      marker.addTo(archiveLeaflet);
      archiveMarkers.set(group.key, marker);
      bounds.extend([group.lat, group.lon]);
    });
    if (places.length === 1) archiveLeaflet.setView([places[0].lat, places[0].lon], 5);
    else archiveLeaflet.fitBounds(bounds.pad(0.35), { maxZoom: 5 });
    setTimeout(() => archiveLeaflet.invalidateSize(), 50);
  }
  async function cacheJourney(manifest) {
    if (state.offlineSaved || state.cachePending || !navigator.serviceWorker) return;
    state.cachePending = true;
    const jobId = manifest.job_id;
    try {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker unavailable')), 10000)),
      ]);
      const urls = [
        `/jobs/${manifest.job_id}/manifest`, `/jobs/${manifest.job_id}/preview`,
        `/jobs/${manifest.job_id}/result`,
        ...(manifest.tiles || []).filter((tile) => tile.status === 'done').map((tile) => tile.path ? assetURL(tile.path) : `/jobs/${manifest.job_id}/tiles/${tile.i}`),
      ];
      for (const variant of weatherVariants(manifest)) {
        if (variant.result?.path) urls.push(assetURL(variant.result.path));
        for (const tile of variant.tiles || []) {
          if (tile.status === 'done' && tile.path) urls.push(assetURL(tile.path));
        }
      }
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); if (state.jobId === jobId) state.cachePending = false; }, 15000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout); channel.port1.close();
        if (state.jobId === jobId) state.cachePending = false;
        if (!event.data?.ok) return;
        const coords = entryCoords(manifest);
        const entry = {
          job_id: manifest.job_id, place: manifest.place, target_year: yearOf(manifest), decade: manifest.decade,
          anchor_year: manifest.anchor_year, metrics: manifest.metrics, provider: manifest.provider, demo: isDemo(manifest), mode: 'replay',
          ...(coords ? { lat: coords.lat, lon: coords.lon } : {}),
        };
        const replays = localReplays().filter((replay) => replay.job_id !== entry.job_id);
        replays.unshift(entry);
        try { localStorage.setItem('century-replays', JSON.stringify(replays.slice(0, 12))); } catch { /* Quota restriction does not affect the current viewer. */ }
        if (state.jobId === manifest.job_id) {
          state.offlineSaved = true;
          text('progress-text', 'Journey saved · revisit it from the archive even offline');
        }
      };
      (navigator.serviceWorker.controller || registration.active)?.postMessage({ type: 'CACHE_JOURNEY', urls, jobId: manifest.job_id }, [channel.port2]);
    } catch { if (state.jobId === jobId) state.cachePending = false; }
  }
  async function openReplays() {
    closeOptions();
    const dialog = $('replay-dialog'); if (!dialog.open) dialog.showModal();
    $('replay-list').innerHTML = '<p class="empty-state">Opening the archive…</p>';
    $('archive-map').hidden = true;
    destroyArchiveLeaflet();
    closeArchivePlace();
    let entries = [];
    try {
      const response = await fetch('/replays');
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json(); entries = Array.isArray(body) ? body : body.replays || [];
    } catch { /* Merge confirmed device caches below. */ }
    const device = localReplays();
    const map = new Map([...storedJourneys('century-recent-jobs'), ...device, ...entries].map((entry) => [entry.job_id, entry]));
    entries = [...map.values()];
    if (!entries.length) {
      $('archive-map').hidden = true;
      destroyArchiveLeaflet();
      $('replay-list').innerHTML = '<p class="empty-state">No saved journeys yet.<br>Finish one online and you can revisit it here offline.</p>';
      return;
    }
    renderArchiveMap(entries, dialog);
    $('replay-list').innerHTML = '';
    entries.forEach((entry) => {
      const button = document.createElement('button'); button.className = 'replay-card';
      const demo = isDemo(entry), cached = device.some((item) => item.job_id === entry.job_id);
      const pending = entry.status === 'running';
      const status = pending ? 'In progress · tap to follow it' : entry.status === 'error' ? 'This journey did not finish · see details' : demo ? 'Engineering sample · local grading' : 'A finished reconstruction';
      button.innerHTML = `<img src="/jobs/${encodeURIComponent(entry.job_id)}/${pending ? 'preview' : 'result'}" alt="Panorama thumbnail of ${escapeHTML(placeName(entry.place))}"><span class="replay-card-content"><strong>${escapeHTML(yearOf(entry) ?? 'Journey')}</strong><span>${escapeHTML(placeName(entry.place))}</span><small>${status}${cached ? ' · saved on this device' : ''}</small></span><span>↗</span>`;
      button.querySelector('img').addEventListener('error', (event) => { event.target.hidden = true; }, { once: true });
      button.addEventListener('click', () => { dialog.close(); startJob(entry.job_id, true); });
      $('replay-list').appendChild(button);
    });
  }
  $('sample-button').addEventListener('click', openReplays); $('nav-replays').addEventListener('click', openReplays);
  $('close-replays').addEventListener('click', () => { closeArchivePlace(); $('replay-dialog').close(); });
  $('archive-place-close').addEventListener('click', closeArchivePlace);
  $('replay-dialog').addEventListener('click', (event) => { if (event.target === $('replay-dialog')) { const rect = $('replay-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { closeArchivePlace(); $('replay-dialog').close(); } } });
  window.addEventListener('offline', connectionStatus);
  window.addEventListener('online', () => { checkHealth(); if (state.finalLoaded && state.manifest) cacheJourney(state.manifest); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* HTTPS or localhost is needed for offline mode. */ });
  checkHealth();
  showScreen('capture');
  if (motionDevice) {
    if (window.isSecureContext && window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission !== 'function') enableGyro();
    else motionPrompt('Tap to look around by turning');
  }
  setTimeout(() => { $('gesture-hint').hidden = true; }, 5000);
  const replayId = new URLSearchParams(location.search).get('replay');
  if (replayId && /^[a-zA-Z0-9_-]{1,100}$/.test(replayId)) startJob(replayId, true);
})();
