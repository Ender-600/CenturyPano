'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const screens = ['capture', 'preview', 'result'];
  const legacyYears = { '1900s': 1905, '1920s': 1925, '1950s': 1955, '1970s': 1975 };
  const defaultTitle = document.title;
  const state = {
    screen: 'capture', file: null, fileURL: null, targetYear: 1925,
    minYear: 1800, maxYear: new Date().getFullYear(), yearEdited: false,
    imageWidth: 0, imageHeight: 0, location: null, locationSource: null,
    manualPlace: false, locationPromise: null,
    offset: 0, renderWidth: 0, renderHeight: 0, wrap: false,
    manifest: null, jobId: null, generation: 0, pollTimer: null,
    geometryKey: null, originalImage: null, loadedTiles: new Set(),
    finalLoaded: false, revealed: false, pastPercent: 0, health: null,
    gyro: false, alpha0: null, gyroBase: 0, gyroTarget: 0, gyroSeen: false,
    drag: null, audioContext: null, audioBuffers: new Map(), sound: true,
    loadingFile: 0, offlineSaved: false, revealing: false,
  };

  function text(id, value) { $(id).textContent = value; }
  function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function assetURL(path) { if (!path) return ''; return path.startsWith('/') ? path : '/' + path; }
  function showToast(message, duration = 5500) {
    text('toast', message); $('toast').hidden = false;
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { $('toast').hidden = true; }, duration);
  }
  function showScreen(screen) {
    state.screen = screen;
    screens.forEach((name) => { $(name + '-screen').hidden = name !== screen; });
    document.body.dataset.screen = screen;
    window.scrollTo({ top: 0, behavior: 'instant' });
    requestAnimationFrame(resizeViewport);
  }
  function stopJourney() {
    state.generation++; clearTimeout(state.pollTimer); disableGyro();
    state.drag = null; state.revealing = false;
    document.body.classList.remove('revealing');
  }
  function goHome() {
    stopJourney(); showScreen('capture');
    document.title = defaultTitle;
    if (location.search) history.replaceState(null, '', location.pathname);
  }
  function connectionStatus() {
    const offline = !navigator.onLine;
    $('connection-status').classList.toggle('offline', offline);
    $('connection-status').lastElementChild.textContent = offline ? '离线 · 已存档可用' : state.health?.provider === 'demo' ? '本地演示模式' : state.health?.configured ? '准备探索' : '服务连接中';
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
        setTargetYear(!state.yearEdited ? (state.health.default_year ?? state.targetYear) : state.targetYear);
      }
    } catch { /* Replay remains available when the live service is offline. */ }
    connectionStatus();
    text('provider-note', state.health?.provider === 'demo' ? '本地效果演示 · 未调用 AI' : '想象重建，非历史影像');
  }

  $('capture-button').addEventListener('click', () => $('camera-input').click());
  $('album-button').addEventListener('click', () => $('album-input').click());
  $('camera-input').addEventListener('change', (event) => acceptFile(event.target.files[0]));
  $('album-input').addEventListener('change', (event) => acceptFile(event.target.files[0]));
  $('retake-button').addEventListener('click', goHome);
  $('new-journey-button').addEventListener('click', goHome);
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); goHome(); });
  $('place-input').addEventListener('input', () => {
    state.manualPlace = true;
    text('location-note', $('place-input').value.trim() ? '手填城市会覆盖照片 GPS 和设备定位，仅提供城市级背景；可补充州和国家以准确识别。' : '未填写城市时，优先使用照片 GPS；没有照片 GPS 时使用设备定位。');
  });
  function yearOf(manifest) {
    return manifest.target_year ?? manifest.anchor_year ?? legacyYears[manifest.decade] ?? null;
  }
  function setTargetYear(value, edited = false) {
    const year = Number(value);
    if (!Number.isInteger(year)) return false;
    state.targetYear = Math.max(state.minYear, Math.min(state.maxYear, year));
    state.yearEdited ||= edited;
    for (const id of ['year-range', 'year-input']) {
      $(id).min = state.minYear; $(id).max = state.maxYear; $(id).value = state.targetYear;
    }
    $('year-range').setAttribute('aria-valuetext', `${state.targetYear} 年，以 7 月 1 日为参考`);
    text('year-min', state.minYear); text('year-max', state.maxYear);
    document.querySelectorAll('[data-year]').forEach((item) => {
      const active = Number(item.dataset.year) === state.targetYear;
      item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
      item.disabled = Number(item.dataset.year) < state.minYear || Number(item.dataset.year) > state.maxYear;
    });
    text('generate-button', `走进 ${state.targetYear} 年`);
    $('generate-button').insertAdjacentHTML('beforeend', '<svg><use href="#i-arrow"/></svg>');
    return true;
  }
  $('year-range').addEventListener('input', (event) => setTargetYear(event.target.value, true));
  $('year-input').addEventListener('input', (event) => {
    const year = Number(event.target.value);
    if (event.target.value && Number.isInteger(year) && year >= state.minYear && year <= state.maxYear) setTargetYear(year, true);
  });
  $('year-input').addEventListener('change', (event) => {
    if (!event.target.value || !setTargetYear(event.target.value, true)) setTargetYear(state.targetYear);
  });
  $('year-options').addEventListener('click', (event) => {
    const button = event.target.closest('[data-year]');
    if (!button) return;
    setTargetYear(button.dataset.year, true);
  });

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('影像暂时无法读取'));
      image.decoding = 'async'; image.src = url;
    });
  }
  async function acceptFile(file) {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) { showToast('照片大于 40 MB，请选择小一些的全景。'); return; }
    if (!(/^image\/(jpeg|png|heic|heif|heic-sequence|heif-sequence)$/.test(file.type) || (!file.type && /\.(heic|heif|jpe?g|png)$/i.test(file.name)))) { showToast('请选择 JPEG、PNG 或 HEIC 全景照片。'); return; }
    const request = ++state.loadingFile;
    $('capture-button').disabled = true; $('album-button').disabled = true;
    try {
      let url = URL.createObjectURL(file), image;
      try { image = await loadImage(url); }
      catch {
        URL.revokeObjectURL(url);
        showToast('正在转换照片格式，稍等片刻…');
        const form = new FormData(); form.append('image', file);
        const response = await fetch('/preview', { method: 'POST', body: form });
        if (!response.ok) throw new Error('浏览器无法预览这张照片，请选择 JPEG / PNG 格式后重试。');
        url = URL.createObjectURL(await response.blob()); image = await loadImage(url);
      }
      if (request !== state.loadingFile) { URL.revokeObjectURL(url); return; }
      stopJourney();
      if (state.fileURL) URL.revokeObjectURL(state.fileURL);
      state.file = file; state.fileURL = url; state.imageWidth = image.naturalWidth; state.imageHeight = image.naturalHeight;
      state.location = null; state.locationSource = null; state.manualPlace = false;
      state.offset = 0; state.wrap = false;
      $('preview-image').src = url; $('place-input').value = '';
      $('is-360').checked = Math.abs(state.imageWidth / state.imageHeight - 2) < 0.1;
      const narrow = state.imageWidth / state.imageHeight < 2;
      $('image-warning').hidden = !narrow;
      text('image-warning', '这张照片看起来较窄。仍然可以继续，横向全景会带来更开阔的体验。');
      text('location-note', '正在读取照片位置… 也可以手动填写拍摄城市。');
      showScreen('preview');
      requestAnimationFrame(() => { resizeViewport(); state.offset = Math.max(0, (state.renderWidth - $('preview-window').clientWidth) / 2); render(); });
      state.locationPromise = locate(file, request);
    } catch (error) { showToast(error.message || '照片读取失败，请重新选择。'); }
    finally { $('capture-button').disabled = false; $('album-button').disabled = false; $('camera-input').value = ''; $('album-input').value = ''; }
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
  async function locate(file, request) {
    // The photo describes a place that may be far from the device's current location.
    const exif = await readExifGPS(file);
    if (request !== state.loadingFile) return;
    const geo = exif ? null : await new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), 5200);
      navigator.geolocation.getCurrentPosition((position) => { clearTimeout(timer); resolve({ lat: position.coords.latitude, lon: position.coords.longitude }); }, () => { clearTimeout(timer); resolve(null); }, { timeout: 5000, maximumAge: 120000, enableHighAccuracy: false });
    });
    if (request !== state.loadingFile) return;
    const coordinates = exif || geo;
    if (!coordinates) {
      if (!state.manualPlace) text('location-note', '浏览器未读取到位置；服务器会尝试照片 GPS，也可以手动填写拍摄城市。');
      return;
    }
    state.location = coordinates; state.locationSource = exif ? 'exif' : 'geolocation';
    if (state.manualPlace) return;
    resolveDetectedLocation(coordinates, !!exif, request);
  }
  async function resolveDetectedLocation(coordinates, photoGPS, request) {
    try {
      const response = await fetch('/location/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(coordinates) });
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json(); const city = result.place || result;
      if (request !== state.loadingFile || state.manualPlace) return;
      $('place-input').value = city.name || '';
      text('location-note', `${photoGPS ? '照片 GPS' : '设备定位（照片 GPS 由服务器优先读取）'} · ${city.name || '已定位'}${city.cc ? '，' + city.cc : ''}。可手动覆盖；设备位置可能与拍摄地不同。`);
    } catch {
      if (request === state.loadingFile && !state.manualPlace) text('location-note', '已获取坐标，将用于推测当地历史背景；可手动填写拍摄城市覆盖。');
    }
  }

  function activeViewport() { return state.screen === 'preview' ? $('preview-window') : $('pano-viewport'); }
  function constrainOffset(value) {
    if (state.wrap && state.renderWidth > 0) return ((value % state.renderWidth) + state.renderWidth) % state.renderWidth;
    return Math.max(0, Math.min(Math.max(0, state.renderWidth - activeViewport().clientWidth), value));
  }
  function resizeViewport() {
    if (!['preview', 'result'].includes(state.screen)) return;
    const viewport = activeViewport(), oldWidth = state.renderWidth;
    const fraction = oldWidth > 0 ? (state.offset + viewport.clientWidth / 2) / oldWidth : 0.5;
    const geometry = state.screen === 'result' && state.manifest?.geometry;
    const width = geometry?.W || state.imageWidth || viewport.clientWidth;
    const height = geometry?.H || state.imageHeight || viewport.clientHeight;
    const scale = Math.max(viewport.clientHeight / height, viewport.clientWidth / width);
    state.renderWidth = width * scale; state.renderHeight = height * scale;
    state.offset = constrainOffset(fraction * state.renderWidth - viewport.clientWidth / 2);
    if (state.gyro && oldWidth !== state.renderWidth) {
      state.alpha0 = null; state.gyroBase = state.offset; state.gyroTarget = state.offset;
    }
    if (state.screen === 'preview') {
      $('preview-image').style.width = state.renderWidth + 'px'; $('preview-image').style.height = state.renderHeight + 'px';
    } else {
      for (const canvas of [$('original-canvas'), $('past-canvas')]) {
        canvas.style.width = state.renderWidth * (state.wrap ? 2 : 1) + 'px'; canvas.style.height = state.renderHeight + 'px';
      }
    }
    render();
  }
  function render() {
    if (state.screen === 'capture') return;
    const y = (activeViewport().clientHeight - state.renderHeight) / 2;
    const transform = `translate3d(${-state.offset}px,${y}px,0)`;
    if (state.screen === 'preview') $('preview-image').style.transform = transform;
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
    if (state.gyro && state.screen === 'result' && !state.drag && !state.revealing) {
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
    $('slider-handle').setAttribute('aria-valuetext', `过去影像 ${Math.round(state.pastPercent)}%`);
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
      state.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: state.offset, slider: !!handle, target: viewport };
      viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging');
      if (handle) { event.preventDefault(); sliderAt(event.clientX); }
    });
    viewport.addEventListener('pointermove', (event) => {
      const drag = state.drag; if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.slider) { event.preventDefault(); sliderAt(event.clientX); return; }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (event.cancelable) event.preventDefault();
        state.offset = constrainOffset(drag.offset - dx); render();
      }
    });
    const endDrag = (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) return;
      if (state.gyro && !state.drag.slider) { state.alpha0 = null; state.gyroBase = state.offset; state.gyroTarget = state.offset; }
      state.drag = null; viewport.classList.remove('dragging');
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag);
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
      if (state.gyro) { state.alpha0 = null; state.gyroBase = state.offset; state.gyroTarget = state.offset; }
      render();
    });
  }
  installPan($('preview-window')); installPan($('pano-viewport'));
  $('slider-handle').addEventListener('keydown', (event) => {
    const delta = event.shiftKey ? 20 : 5;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    setPastPercent(event.key === 'Home' ? 0 : event.key === 'End' ? 100 : state.pastPercent + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? delta : -delta));
  });
  new ResizeObserver(resizeViewport).observe($('pano-viewport'));
  new ResizeObserver(resizeViewport).observe($('preview-window'));
  window.addEventListener('resize', resizeViewport);

  async function unlockAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      if (!state.audioContext) state.audioContext = new AudioContext();
      await state.audioContext.resume();
      const source = state.audioContext.createBufferSource();
      source.buffer = state.audioContext.createBuffer(1, 1, 22050); source.connect(state.audioContext.destination); source.start();
    } catch { /* Audio is optional if the browser denies playback. */ }
  }
  async function getAudio(jobId) {
    if (!state.audioContext) return null;
    if (state.audioBuffers.has(jobId)) return state.audioBuffers.get(jobId);
    try {
      const response = await fetch(`/jobs/${encodeURIComponent(jobId)}/audio`);
      if (!response.ok) return null;
      const buffer = await state.audioContext.decodeAudioData(await response.arrayBuffer());
      state.audioBuffers.set(jobId, buffer); return buffer;
    } catch { return null; }
  }
  async function playAudio() {
    if (!state.sound || !state.audioContext || !state.jobId) return;
    const buffer = await getAudio(state.jobId);
    if (!buffer || state.audioContext.state !== 'running') return;
    const source = state.audioContext.createBufferSource(), gain = state.audioContext.createGain();
    source.buffer = buffer; source.connect(gain); gain.connect(state.audioContext.destination);
    const t = state.audioContext.currentTime;
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.32, t + 0.15);
    gain.gain.setValueAtTime(0.32, t + 1.6); gain.gain.linearRampToValueAtTime(0, t + 2);
    source.start(t, 0, Math.min(2, buffer.duration));
  }
  $('audio-button').addEventListener('click', async () => { await unlockAudio(); await playAudio(); });

  $('generate-button').addEventListener('click', async () => {
    if (!state.file || $('generate-button').disabled) return;
    if (!$('year-input').checkValidity()) { $('year-input').reportValidity(); return; }
    unlockAudio();
    const button = $('generate-button'); button.disabled = true;
    const file = state.file, targetYear = state.targetYear;
    const heading = state.renderWidth ? ((state.offset + $('preview-window').clientWidth / 2) / state.renderWidth) : 0.5;
    try {
      if (!navigator.onLine) throw new Error('目前处于离线状态，请打开时光档案，重访已保存的旅程。');
      if (!state.manualPlace || !$('place-input').value.trim()) await state.locationPromise;
      if (file !== state.file || state.screen !== 'preview') return;
      const form = new FormData(); form.append('image', file); form.append('target_year', String(targetYear));
      form.append('heading', String(Math.max(0, Math.min(1, heading)))); form.append('is_360', String($('is-360').checked));
      if (state.location && state.locationSource === 'geolocation') { form.append('lat', String(state.location.lat)); form.append('lon', String(state.location.lon)); }
      if (state.manualPlace) { const place = $('place-input').value.trim(); if (place) form.append('place', place); }
      const response = await fetch('/jobs', { method: 'POST', body: form });
      if (!response.ok) {
        let detail = await response.text();
        try { const body = JSON.parse(detail); detail = typeof body.detail === 'string' ? body.detail : body.message; } catch { /* The API also returns plain, readable error messages. */ }
        throw new Error(detail || `生成请求暂时失败 (${response.status})，请稍后重试。`);
      }
      const job = await response.json();
      if (!job.job_id) throw new Error('服务未返回旅程编号，请重试。');
      if (file !== state.file || state.screen !== 'preview') return;
      await startJob(job.job_id, false, heading, targetYear);
    } catch (error) { showToast(error.message || '连接失败，照片已保留，可以再次尝试。', 8000); }
    finally { button.disabled = false; }
  });

  async function startJob(jobId, replay = false, heading = 0.5, targetYear = null) {
    stopJourney();
    state.jobId = jobId; state.manifest = null; state.geometryKey = null;
    state.viewingReplay = replay;
    state.expectedYear = replay ? null : targetYear;
    state.loadedTiles = new Set(); state.originalImage = null; state.finalLoaded = false;
    state.revealed = false; state.pastPercent = 0; state.offlineSaved = false;
    state.initialHeading = heading; state.wrap = false; state.offset = 0;
    $('generation-overlay').hidden = false; $('progress-strip').hidden = false;
    text('generation-title', replay ? '重访这一刻' : '让时间慢下来');
    text('generation-detail', replay ? '正在打开保存的全景…' : '正在读取你的全景…');
    text('progress-text', '准备出发'); text('progress-count', '0 / 0'); $('progress-fill').style.width = '0%';
    $('download-button').hidden = true; $('metrics-panel').hidden = true; $('historical-context').hidden = true; $('place-warning').hidden = true;
    $('metrics-toggle').setAttribute('aria-expanded', 'false');
    $('replay-badge').hidden = !replay; text('result-mode', '');
    text('result-place', ''); text('result-subtitle', '旧日的风景，正在眼前展开。');
    text('result-year', targetYear ?? '—'); text('reveal-year', targetYear ?? '—');
    $('past-label').innerHTML = `${escapeHTML(targetYear ?? '待确认')} 年 <span>REIMAGINED</span>`;
    document.title = `${targetYear ?? '读取旅程'} · CENTURY PANO`;
    for (const canvas of [$('original-canvas'), $('past-canvas')]) { canvas.width = 1; canvas.height = 1; }
    if (!replay && state.fileURL) {
      try {
        const image = await loadImage(state.fileURL);
        for (const canvas of [$('original-canvas'), $('past-canvas')]) {
          canvas.width = Math.min(image.naturalWidth, 6000); canvas.height = Math.round(canvas.width / image.naturalWidth * image.naturalHeight);
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        }
      } catch { /* Server preview will replace the temporary image. */ }
    }
    showScreen('result');
    history.replaceState(null, '', `?replay=${encodeURIComponent(jobId)}`);
    getAudio(jobId);
    pollManifest(state.generation);
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
    state.gyroTarget = state.offset; render(); return true;
  }
  function placeName(place) { return typeof place === 'string' ? place : place?.name || '未知城市'; }
  function isDemo(manifest) { return !!manifest.demo || manifest.provider === 'demo' || manifest.tiles?.some((tile) => tile.provider === 'demo'); }
  function renderHistoricalContext(manifest) {
    const context = manifest.constraints?.historical_context;
    const panel = $('historical-context'); panel.hidden = false;
    if (!context) {
      panel.innerHTML = '<h3>历史背景</h3><p>此旅程暂无地点历史背景记录。画面为想象重建，具体建筑和土地用途尚未核实。</p>';
      return;
    }
    const fallback = context.evidence_basis === 'fallback';
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(context.reference_date || '');
    const reference = date ? `${date[1]} 年 ${Number(date[2])} 月 ${Number(date[3])} 日` : `${context.target_year ?? yearOf(manifest) ?? '所选'} 年 7 月 1 日`;
    const siteLabels = { undeveloped: '未开发', agricultural: '农业用地', built: '已建成', mixed: '混合用途', unknown: '尚未确认' };
    const list = (heading, values) => Array.isArray(values) && values.length ? `<div class="history-section"><h4>${heading}</h4><ul>${values.map((value) => `<li>${escapeHTML(value)}</li>`).join('')}</ul></div>` : '';
    panel.innerHTML = `<div class="history-heading"><h3>历史背景推测</h3><span>${escapeHTML(reference)} · 参考时点</span></div>`
      + `<p class="history-status">${fallback ? '地点历史尚未确认 · 使用保守推测' : '基于模型知识的推测 · 未经史料核实'}</p>`
      + `<p>${escapeHTML(context.period_summary || '该地点在目标年份的背景尚未确认。')}</p>`
      + `<p><strong>推测土地用途：${escapeHTML(siteLabels[context.site_state] || siteLabels.unknown)}</strong>${context.site_history ? `<br>${escapeHTML(context.site_history)}` : ''}</p>`
      + list('当地背景', context.local_context)
      + list('画面重建依据', context.reconstruction_changes)
      + list('仍待确认', context.uncertainties)
      + '<p class="history-footnote">同一地点可能曾是荒地、农田，或存在不同建筑。当前全景不代表这些建筑在所选年份已经存在；影像与背景均需史料核实。</p>';
  }
  function updateMetadata(manifest) {
    const demo = isDemo(manifest), replay = manifest.mode === 'replay' || state.viewingReplay;
    const year = yearOf(manifest);
    const unrecognizedCity = manifest.place?.source === 'manual' && manifest.place?.prompt_safe === false;
    $('place-warning').hidden = !unrecognizedCity;
    if (unrecognizedCity) {
      const warning = '手填城市未识别，未用于历史推理，请补充州 / 国家或使用照片定位。';
      text('place-warning', warning); text('location-note', warning);
    }
    text('result-place', placeName(manifest.place)); text('result-year', year ?? '—');
    text('reveal-year', year ?? '—');
    $('past-label').innerHTML = `${escapeHTML(year ?? '待确认')} 年 <span>REIMAGINED</span>`;
    document.title = `${year ?? '年份待确认'} · ${placeName(manifest.place)} · CENTURY PANO`;
    $('replay-badge').hidden = !replay;
    text('result-mode', demo ? '本地效果演示 · 未调用 AI' : replay ? '已存档旅程 · 无生成调用' : 'AI 想象重建');
    text('result-note', demo ? '工程示例 / 本地调色用于验证交互与流程，不代表 AI 重建效果。' : '结合所选年份与拍摄地点推测历史场景，建筑和土地用途可能与今天不同。');
    const done = manifest.tiles?.filter((tile) => ['done', 'error'].includes(tile.status)).length || 0;
    const total = manifest.geometry?.n || manifest.tiles?.length || 0;
    $('progress-fill').style.width = `${total ? done / total * 100 : 0}%`;
    text('progress-count', `${done} / ${total || '—'} 个画面`);
    const stage = manifest.stage;
    let progress = done ? '时光正在展开，已完成的区域可以拖动探索' : stage === 'history' ? '正在判断该年份的当地历史与地块变化' : manifest.anchor?.status === 'running' ? '正在建立统一的历史场景与环境' : stage === 'preprocess' ? '正在准备全景' : '正在理解拍摄场景与所选年份';
    if (manifest.status === 'done') progress = replay ? '已打开存档 · 数据来自原始运行' : '旅程已完成';
    if (manifest.status === 'done_partial') progress = '部分画面未生成，已保留对应原图';
    if (manifest.status === 'error') progress = '旅程暂时中断';
    text('progress-text', progress); text('generation-detail', progress);
    if (done > 0) { $('generation-overlay').hidden = true; if (!state.finalLoaded && state.pastPercent === 0) setPastPercent(100); }
    renderHistoricalContext(manifest);
    renderMetrics(manifest);
  }
  async function applyManifest(manifest, generation) {
    if (generation !== state.generation) return;
    state.manifest = manifest; updateMetadata(manifest);
    let ready = false;
    try { ready = await prepareGeometry(manifest, generation); } catch { /* Preview may not exist during preprocessing. */ }
    if (!ready || generation !== state.generation) return;
    const geometry = manifest.geometry;
    const arrivals = (manifest.tiles || []).filter((tile) => ['done', 'error'].includes(tile.status) && !state.loadedTiles.has(tile.i));
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
    if (manifest.result?.status === 'done' && !state.finalLoaded) {
      try {
        const image = await loadImage(`/jobs/${encodeURIComponent(manifest.job_id)}/result`);
        if (generation !== state.generation) return;
        const ctx = $('past-canvas').getContext('2d'); ctx.drawImage(image, 0, 0, geometry.W, geometry.H);
        duplicateCanvas($('past-canvas'), geometry.W, geometry.H);
        state.finalLoaded = true; $('generation-overlay').hidden = true;
        $('download-button').href = `/jobs/${encodeURIComponent(manifest.job_id)}/result`;
        $('download-button').hidden = false;
        text('result-subtitle', isDemo(manifest) ? '工程示例。拖动圆点，探索今昔对比。' : '时间走了很远，视角始终在这里。');
        if (manifest.status === 'done_partial') showToast('部分区域未能完成重建，已保留原始画面。');
        await reveal(generation);
        if (generation === state.generation) cacheJourney(manifest);
      } catch { text('progress-text', '结果正在保存，马上就好…'); }
    }
    render();
  }
  async function pollManifest(generation, failures = 0) {
    if (generation !== state.generation) return;
    try {
      const response = await fetch(`/jobs/${encodeURIComponent(state.jobId)}/manifest`, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? '这个旅程不存在，或当前设备还没有保存它。' : '暂时无法连接服务');
      const manifest = await response.json();
      if (generation !== state.generation) return;
      if (state.expectedYear !== null && yearOf(manifest) !== null && yearOf(manifest) !== state.expectedYear) {
        $('generation-overlay').hidden = false;
        text('generation-title', '返回的年份与选择不一致');
        text('generation-detail', `你选择了 ${state.expectedYear} 年，请重新生成。`);
        text('progress-text', '已停止加载，避免显示其他年份的结果');
        return;
      }
      await applyManifest(manifest, generation);
      if (generation !== state.generation) return;
      if (manifest.status === 'error') {
        $('generation-overlay').hidden = false;
        text('generation-title', '这一程，稍后再出发');
        text('generation-detail', manifest.error || '生成未能完成，请返回重试。');
        text('result-subtitle', '照片仍然保留，可以重新开始。');
        showToast(manifest.error || '生成失败。点击「新的旅程」重新选择，或打开存档。', 9000);
        return;
      }
      if (['done', 'done_partial'].includes(manifest.status) && state.finalLoaded) return;
      state.pollTimer = setTimeout(() => pollManifest(generation, 0), 500);
    } catch (error) {
      if (generation !== state.generation) return;
      text('progress-text', navigator.onLine ? '连接暂时中断，正在自动重试…' : '网络已断开，等待重新连接…');
      if (failures === 1) showToast(error.message || '连接中断，恢复网络后会自动继续。');
      if (failures > 10) {
        $('generation-overlay').hidden = false;
        text('generation-title', '旅程在这里等你');
        text('generation-detail', '暂时无法连接，正在重试。你也可以返回时光档案。');
      }
      state.pollTimer = setTimeout(() => pollManifest(generation, failures + 1), Math.min(5000, 1000 + failures * 500));
    }
  }
  async function reveal(generation) {
    if (state.revealed || generation !== state.generation) return;
    state.revealed = true; state.revealing = true; state.drag = null;
    const center = (state.offset + $('pano-viewport').clientWidth / 2) / state.renderWidth;
    setPastPercent(0);
    document.body.classList.add('revealing'); resizeViewport();
    state.offset = constrainOffset(center * state.renderWidth - $('pano-viewport').clientWidth / 2); render();
    await new Promise((resolve) => setTimeout(resolve, 210));
    if (generation !== state.generation) return;
    playAudio();
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1500;
    await new Promise((resolve) => {
      const start = performance.now();
      function animate(now) {
        if (generation !== state.generation) { resolve(); return; }
        const t = duration ? Math.min(1, (now - start) / duration) : 1;
        setPastPercent((t < .5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2) * 100);
        if (t < 1) requestAnimationFrame(animate); else resolve();
      }
      requestAnimationFrame(animate);
    });
    if (generation !== state.generation) return;
    document.body.classList.remove('revealing'); state.revealing = false;
    resizeViewport(); state.offset = constrainOffset(center * state.renderWidth - $('pano-viewport').clientWidth / 2);
    state.gyroBase = state.offset; state.gyroTarget = state.offset; state.alpha0 = null;
    setPastPercent(100);
  }

  function metricNumber(value, suffix = ' s') { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) + suffix : '—'; }
  function renderMetrics(manifest) {
    const metrics = manifest.metrics || {}, seam = metrics.seam_err || {};
    const cells = [
      ['首个可见画面', metricNumber(metrics.first_view_s), '首次完成的重建画面'],
      ['完整旅程', metricNumber(metrics.total_s), '本次运行实际用时'],
      ['接缝色差 · 调色前 / 后', `${metricNumber(seam.raw, '')} / ${metricNumber(seam.after_color_match, '')}`, `原图参考值 ${metricNumber(seam.originals_floor, '')}`],
      ['相对串行加速', metricNumber(metrics.speedup, '×'), metrics.serial_baseline_s == null ? '尚未测量串行基线' : `串行基线 ${metricNumber(metrics.serial_baseline_s)}`],
    ];
    $('metrics-panel').innerHTML = cells.map(([name, value, note]) => `<div class="metric"><span>${escapeHTML(name)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></div>`).join('') + `<p class="metrics-note">${isDemo(manifest) ? '以上为本地演示管线的运行数据，不代表 AI 服务的速度或质量。' : '数据来自该旅程的实际运行；回放不重新计时。'} 破折号表示尚未测量。接缝色差采用重叠区域 Lab 距离，数值越小代表色彩越接近；这不衡量历史真实性。${manifest.scene?.fallback ? ' 场景解析使用了默认设置。' : ''}${manifest.anchor?.status === 'skipped' ? ' 年代参考图未生成，已跳过色彩匹配。' : ''}</p>`;
  }
  $('metrics-toggle').addEventListener('click', () => {
    const open = $('metrics-panel').hidden;
    $('metrics-panel').hidden = !open; $('metrics-toggle').setAttribute('aria-expanded', String(open));
    $('metrics-toggle').lastElementChild.textContent = open ? '−' : '+';
  });

  function gyroFallback(message = '请在 Safari / Chrome 中打开以启用转动跟随。现在可以左右拖动探索。') {
    disableGyro(); $('gyro-hint').hidden = false; text('gyro-hint', message);
  }
  function disableGyro() {
    state.gyro = false; state.alpha0 = null;
    window.removeEventListener('deviceorientation', onOrientation); clearTimeout(disableGyro.timer);
    $('gyro-button').innerHTML = '<svg><use href="#i-gyro"/></svg>开启转动跟随';
    $('gyro-button').setAttribute('aria-pressed', 'false'); $('recenter-button').hidden = true;
  }
  function onOrientation(event) {
    if (!state.gyro) return;
    if (event.alpha == null) { gyroFallback(); return; }
    state.gyroSeen = true;
    if (state.alpha0 === null) { state.alpha0 = event.alpha; state.gyroBase = state.offset; }
    const delta = ((event.alpha - state.alpha0 + 540) % 360) - 180;
    state.gyroTarget = state.gyroBase - delta * state.renderWidth / (state.wrap ? 360 : 120);
  }
  $('gyro-button').addEventListener('click', async () => {
    if (state.gyro) { disableGyro(); return; }
    try {
      if (!window.DeviceOrientationEvent) { gyroFallback(); return; }
      if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await window.DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') { gyroFallback(); return; }
      }
      state.gyro = true; state.alpha0 = null; state.gyroSeen = false; state.gyroBase = state.offset; state.gyroTarget = state.offset;
      window.addEventListener('deviceorientation', onOrientation);
      $('gyro-button').innerHTML = '<svg><use href="#i-check"/></svg>转动跟随已开启';
      $('gyro-button').setAttribute('aria-pressed', 'true'); $('recenter-button').hidden = false; $('gyro-hint').hidden = true;
      disableGyro.timer = setTimeout(() => { if (state.gyro && !state.gyroSeen) gyroFallback(); }, 2200);
    } catch { gyroFallback(); }
  });
  $('recenter-button').addEventListener('click', () => {
    state.alpha0 = null; state.gyroBase = state.offset; state.gyroTarget = state.offset;
    showToast('已将当前视角设为中心。', 2200);
  });

  function localReplays() { try { return JSON.parse(localStorage.getItem('century-replays') || '[]'); } catch { return []; } }
  async function cacheJourney(manifest) {
    if (state.offlineSaved || !navigator.serviceWorker) return;
    state.offlineSaved = true;
    try {
      const registration = await navigator.serviceWorker.ready;
      const urls = [
        `/jobs/${manifest.job_id}/manifest`, `/jobs/${manifest.job_id}/preview`,
        `/jobs/${manifest.job_id}/result`, `/jobs/${manifest.job_id}/audio`,
        ...(manifest.tiles || []).filter((tile) => tile.status === 'done').map((tile) => tile.path ? assetURL(tile.path) : `/jobs/${manifest.job_id}/tiles/${tile.i}`),
      ];
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        if (!event.data?.ok) return;
        const entry = { job_id: manifest.job_id, place: manifest.place, target_year: manifest.target_year, decade: manifest.decade, anchor_year: manifest.anchor_year, metrics: manifest.metrics, provider: manifest.provider, demo: isDemo(manifest), mode: 'replay' };
        const replays = localReplays().filter((replay) => replay.job_id !== entry.job_id);
        replays.unshift(entry);
        try { localStorage.setItem('century-replays', JSON.stringify(replays.slice(0, 12))); } catch { /* Quota restriction does not affect the current viewer. */ }
        if (state.jobId === manifest.job_id) text('progress-text', '旅程已保存 · 断网后可从时光档案重访');
      };
      (navigator.serviceWorker.controller || registration.active)?.postMessage({ type: 'CACHE_JOURNEY', urls, jobId: manifest.job_id }, [channel.port2]);
    } catch { /* Offline availability is only advertised after successful caching. */ }
  }
  async function openReplays() {
    const dialog = $('replay-dialog'); if (!dialog.open) dialog.showModal();
    $('replay-list').innerHTML = '<p class="empty-state">正在打开时光档案…</p>';
    let entries = [];
    try {
      const response = await fetch('/replays');
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json(); entries = Array.isArray(body) ? body : body.replays || [];
    } catch { /* Merge confirmed device caches below. */ }
    const device = localReplays();
    const map = new Map([...device, ...entries].map((entry) => [entry.job_id, entry]));
    entries = [...map.values()];
    if (!entries.length) { $('replay-list').innerHTML = '<p class="empty-state">还没有保存的旅程。<br>联网完成一次生成后，就能在这里离线重访。</p>'; return; }
    $('replay-list').innerHTML = '';
    entries.forEach((entry) => {
      const button = document.createElement('button'); button.className = 'replay-card';
      const demo = isDemo(entry), cached = device.some((item) => item.job_id === entry.job_id);
      button.innerHTML = `<img src="/jobs/${encodeURIComponent(entry.job_id)}/result" alt="${escapeHTML(placeName(entry.place))}全景缩略图"><span class="replay-card-content"><strong>${escapeHTML(yearOf(entry) ?? '年份待确认')}</strong><span>${escapeHTML(placeName(entry.place))}</span><small>${demo ? '工程示例 · 本地调色' : '已完成的想象重建'}${cached ? ' · 已存本机' : ''}</small></span><span>↗</span>`;
      button.addEventListener('click', () => { unlockAudio(); dialog.close(); startJob(entry.job_id, true, 0.5, yearOf(entry)); });
      $('replay-list').appendChild(button);
    });
  }
  $('sample-button').addEventListener('click', openReplays); $('nav-replays').addEventListener('click', openReplays);
  $('close-replays').addEventListener('click', () => $('replay-dialog').close());
  $('replay-dialog').addEventListener('click', (event) => { if (event.target === $('replay-dialog')) { const rect = $('replay-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('replay-dialog').close(); } });
  window.addEventListener('offline', connectionStatus); window.addEventListener('online', () => { checkHealth(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* HTTPS or localhost is needed for offline mode. */ });
  setTargetYear(state.targetYear);
  checkHealth();
  const replayId = new URLSearchParams(location.search).get('replay');
  if (replayId && /^[a-zA-Z0-9_-]{1,100}$/.test(replayId)) startJob(replayId, true);
})();
