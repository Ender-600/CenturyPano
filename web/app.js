'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const screens = ['capture', 'preview', 'result'];
  const legacyYears = { '1900s': 1905, '1920s': 1925, '1950s': 1955, '1970s': 1975 };
  const defaultTitle = document.title;
  const motionDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const state = {
    screen: 'capture', file: null, fileURL: null, targetYear: 1925,
    minYear: 1800, maxYear: new Date().getFullYear(), yearEdited: false, yearDraft: null, expectedYear: null,
    imageWidth: 0, imageHeight: 0, location: null, locationSource: null,
    manualPlace: false, locationPromise: null, locationRevision: 0,
    offset: 0, renderWidth: 0, renderHeight: 0, wrap: false,
    manifest: null, jobId: null, generation: 0, pollTimer: null,
    geometryKey: null, originalImage: null, loadedTiles: new Set(),
    finalLoaded: false, revealed: false, pastPercent: 0, health: null,
    gyro: false, gyroTarget: 0, gyroSeen: false,
    gyroPending: false, gyroRequest: 0, gyroHeading: null, gyroSignal: false,
    drag: null, audioContext: null, audioBuffers: new Map(), sound: true,
    loadingFile: 0, offlineSaved: false, revealing: false,
    viewMode: 'past', clean: false, submitting: false, loadingSource: false,
    viewRevision: 0, viewportWidth: 0, cachePending: false, fileOrigin: null,
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
    $('compare-button').title = available ? '拖动分界线，对比今昔' : '生成画面后即可对比';
    $('slider-handle').hidden = !result || state.viewMode !== 'compare';
    document.querySelectorAll('.viewport-label').forEach((label) => { label.hidden = !result || state.viewMode !== 'compare'; });
    $('generate-button').hidden = !failed && (!preview || original);
    $('generate-button').disabled = busy;
    $('generate-button').innerHTML = `${failed ? '重新预览这张照片' : state.submitting ? '正在提交…' : `走进 ${state.targetYear} 年`}<svg><use href="#i-arrow"/></svg>`;
    $('album-button').disabled = busy;
    $('capture-button').disabled = busy;
    $('photo-settings').hidden = !preview;
    $('result-actions').hidden = !result;
    $('journey-info').hidden = !result;
    $('retake-button').hidden = !preview;
    $('new-journey-button').hidden = !result;
    text('window-year', original ? '现在' : displayYear ?? '—');
    $('year-picker-button').setAttribute('aria-label', `选择具体年份，当前${original ? '现在' : `${displayYear ?? '待确认'}年`}`);
    $('window-year-suffix').hidden = original;
    text('window-place', result ? placeName(state.manifest?.place) : preview ? $('place-input').value.trim() || '你的视角' : 'Pittsburgh');
    const caption = state.submitting ? '正在提交你的旅程。' : state.loadingSource ? '正在打开这个视角。' :
      original ? '就在此刻。' : state.viewMode === 'compare' ? '轻轻一划，今昔之间。' :
        preview ? '保留眼前，选择一个年份。' : result ? '同一个地方，另一个年份。' : '让手机，成为时间的视窗。';
    text('window-caption', caption);
    text('provider-note', state.screen === 'capture' ? '概念影像 · 非历史照片' : preview ?
      '原图预览 · 点击生成后开始重建' : isDemo(state.manifest || {}) ? '工程示例 · 本地调色' : '想象重建 · 非历史影像');
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
        if (state.screen !== 'result' && !state.submitting && !state.loadingSource && !state.yearEdited) {
          setTargetYear(state.health.default_year ?? state.targetYear);
        }
      }
    } catch { /* Replay remains available when the live service is offline. */ }
    connectionStatus();
    syncChrome();
  }

  $('capture-button').addEventListener('click', () => { closeOptions(); $('camera-input').click(); });
  $('album-button').addEventListener('click', () => { closeOptions(); $('album-input').click(); });
  $('camera-input').addEventListener('change', (event) => acceptFile(event.target.files[0]));
  $('album-input').addEventListener('change', (event) => acceptFile(event.target.files[0]));
  $('retake-button').addEventListener('click', goHome);
  $('new-journey-button').addEventListener('click', goHome);
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); goHome(); });
  $('place-input').addEventListener('input', () => {
    state.manualPlace = true;
    text('location-note', $('place-input').value.trim() ? '手填城市会覆盖照片 GPS 和设备定位，仅提供城市级背景；可补充州和国家以准确识别。' : '未填写城市时，优先使用照片 GPS；也可主动使用设备定位。');
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
    $('year-range').setAttribute('aria-valuetext', `${$('year-range').value} 年，以 7 月 1 日为参考`);
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
      image.onerror = () => reject(new Error('影像暂时无法读取'));
      image.decoding = 'async'; image.src = url;
    });
  }
  async function acceptFile(file) {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) { showToast('照片大于 40 MB，请选择小一些的全景。'); return; }
    if (!(/^image\/(jpeg|png|heic|heif|heic-sequence|heif-sequence)$/.test(file.type) || (!file.type && /\.(heic|heif|jpe?g|png)$/i.test(file.name)))) { showToast('请选择 JPEG、PNG 或 HEIC 全景照片。'); return; }
    let request = ++state.loadingFile;
    state.loadingSource = true; syncChrome();
    let url = null;
    try {
      url = URL.createObjectURL(file); let image;
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
      text('image-warning', '这张照片看起来较窄。仍然可以继续，横向全景会带来更开阔的体验。');
      text('location-note', '正在读取照片位置… 也可以手动填写拍摄城市。');
      showScreen('preview');
      if (location.search) history.replaceState(null, '', location.pathname);
      requestAnimationFrame(() => { resizeViewport(); state.offset = Math.max(0, (state.renderWidth - $('preview-window').clientWidth) / 2); resetMotionOrigin(); render(); });
      if (narrow) showToast('已打开原图。横向全景会带来更开阔的视野。');
      state.locationPromise = locate(file, request);
    } catch (error) {
      if (url && url !== state.fileURL) URL.revokeObjectURL(url);
      if (request === state.loadingFile) showToast(error.message || '照片读取失败，请重新选择。');
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
        if (!response.ok) throw new Error('这个旅程的工作图尚未就绪，请稍后再试。');
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
      text('image-warning', '沿用存档中的原始工作图；它可能已经裁剪或缩放。');
      showScreen('preview');
      history.replaceState(null, '', location.pathname);
      requestAnimationFrame(() => { resizeViewport(); state.offset = constrainOffset(heading * state.renderWidth - $('preview-window').clientWidth / 2); resetMotionOrigin(); render(); });
      showToast(recovered ? '已打开存档工作图。点击生成，探索新的年份。' : '已保留你的原图。点击生成，探索新的年份。');
    } catch (error) {
      if (newURL && newURL !== state.fileURL) URL.revokeObjectURL(newURL);
      if (request === state.loadingFile) showToast(error.message || '暂时无法读取原始视角，请稍后再试。');
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
      if (!state.manualPlace) text('location-note', useDevice ? '未获取位置。服务器仍会读取照片 GPS，也可以手动填写拍摄城市。' : '浏览器未读取到照片位置。服务器仍会尝试照片 GPS，也可填写城市或点「使用当前位置」。');
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
      text('location-note', `${exif ? '照片 GPS' : '设备定位（照片 GPS 由服务器优先读取）'} · ${city.name || '已定位'}${city.cc ? '，' + city.cc : ''}。可手动覆盖；设备位置可能与拍摄地不同。`);
      syncChrome();
    } catch {
      if (current() && !state.manualPlace) text('location-note', '已获取坐标，将用于推测当地历史背景；可手动填写拍摄城市覆盖。');
    }
  }
  $('locate-button').addEventListener('click', () => {
    if (!state.file || state.screen !== 'preview' || state.submitting) return;
    state.manualPlace = false; $('place-input').value = '';
    text('location-note', '优先读取照片 GPS，没有时获取当前位置…');
    state.locationPromise = locate(state.file, state.loadingFile, true);
  });
  function restoreJourneyLocation(place, recovered = false) {
    state.locationPromise = null;
    if (!place && !recovered) return; // An unfinished live job still has its original input state.
    if (!place) {
      state.location = null; state.locationSource = null; state.manualPlace = false;
      $('place-input').value = '';
      text('location-note', '未记录拍摄位置，可填写城市或主动使用设备定位。');
      return;
    }
    const name = placeName(place) === '未知城市' ? '' : placeName(place);
    const coordinates = typeof place === 'object' && Number.isFinite(place.lat) && Number.isFinite(place.lon)
      ? { lat: place.lat, lon: place.lon } : null;
    state.manualPlace = place.source === 'manual' || (!coordinates && !!name);
    state.location = coordinates;
    // A replay working JPEG has no EXIF. Send saved coordinates explicitly;
    // the backend still gives any EXIF in the original upload precedence.
    state.locationSource = coordinates ? 'geolocation' : null;
    $('place-input').value = state.manualPlace && typeof place === 'object'
      ? [name, place.admin1, place.cc].filter(Boolean).join(', ') : name;
    text('location-note', coordinates && !state.manualPlace ? '沿用这张照片的拍摄坐标。可手动填写城市覆盖。' : state.manualPlace ? '沿用这个旅程的城市。可修改并补充州和国家。' : '未记录拍摄位置，可填写城市或主动使用设备定位。');
  }

  function activeViewport() { return state.screen === 'capture' ? $('capture-screen') : state.screen === 'preview' ? $('preview-window') : $('pano-viewport'); }
  function constrainOffset(value) {
    if (state.wrap && state.renderWidth > 0) return ((value % state.renderWidth) + state.renderWidth) % state.renderWidth;
    return Math.max(0, Math.min(Math.max(0, state.renderWidth - activeViewport().clientWidth), value));
  }
  function resizeViewport() {
    const viewport = activeViewport(), oldWidth = state.renderWidth;
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    const fraction = oldWidth > 0 ? (state.offset + (state.viewportWidth || viewport.clientWidth) / 2) / oldWidth : 0.5;
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
      if (!handle && event.target.closest('button, a, input, select, textarea')) return;
      $('gesture-hint').hidden = true;
      state.velocity = 0;
      state.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: state.offset, slider: !!handle,
        target: viewport, axis: null, lastX: event.clientX, lastT: performance.now(), velocity: 0 };
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
      if (drag.axis === 'x' && !drag.slider && performance.now() - drag.lastT < 80) {
        // Flick: carry the last measured speed into the inertia loop in frame().
        state.velocity = -drag.velocity;
      }
      if (state.gyro) resetMotionOrigin();
      state.drag = null; viewport.classList.remove('dragging');
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
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
    const generation = state.generation, jobId = state.jobId;
    const buffer = await getAudio(jobId);
    if (!buffer || state.audioContext.state !== 'running' || generation !== state.generation || state.screen !== 'result') return;
    const source = state.audioContext.createBufferSource(), gain = state.audioContext.createGain();
    source.buffer = buffer; source.connect(gain); gain.connect(state.audioContext.destination);
    const t = state.audioContext.currentTime;
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(0.32, t + 0.15);
    gain.gain.setValueAtTime(0.32, t + 1.6); gain.gain.linearRampToValueAtTime(0, t + 2);
    source.start(t, 0, Math.min(2, buffer.duration));
  }
  $('audio-button').addEventListener('click', async () => { await unlockAudio(); await playAudio(); });

  $('generate-button').addEventListener('click', async () => {
    if (state.screen === 'result' && (state.manifest?.status === 'error' || state.yearMismatch)) { await editJourney(state.expectedYear ?? state.targetYear); return; }
    if (!state.file || state.screen !== 'preview' || state.submitting || state.loadingSource) return;
    if (!$('year-input').checkValidity()) {
      if (!$('options-dialog').open) $('options-dialog').showModal();
      $('year-input').reportValidity(); return;
    }
    unlockAudio();
    const generation = state.generation, file = state.file, targetYear = state.targetYear;
    const heading = state.renderWidth ? ((state.offset + $('preview-window').clientWidth / 2) / state.renderWidth) : 0.5;
    const wrap = $('is-360').checked;
    state.submitting = true; syncChrome();
    try {
      if (!navigator.onLine) throw new Error('目前处于离线状态，请打开时光档案，重访已保存的旅程。');
      if (!state.manualPlace || !$('place-input').value.trim()) await state.locationPromise;
      if (generation !== state.generation || state.file !== file || state.screen !== 'preview') return;
      const place = $('place-input').value.trim();
      const form = new FormData(); form.append('image', file); form.append('target_year', String(targetYear));
      form.append('heading', String(Math.max(0, Math.min(1, heading)))); form.append('is_360', String(wrap));
      if (state.location) { form.append('lat', String(state.location.lat)); form.append('lon', String(state.location.lon)); }
      if (state.manualPlace && place) form.append('place', place);
      const response = await fetch('/jobs', { method: 'POST', body: form });
      if (!response.ok) {
        let detail = await response.text();
        try { const body = JSON.parse(detail); detail = typeof body.detail === 'string' ? body.detail : body.message; } catch { /* The API also returns plain, readable error messages. */ }
        throw new Error(detail || `生成请求暂时失败 (${response.status})，请稍后重试。`);
      }
      const job = await response.json();
      if (!job.job_id) throw new Error('服务未返回旅程编号，请重试。');
      rememberJob({ job_id: job.job_id, target_year: targetYear, anchor_year: targetYear, place: place || '未知城市', status: 'running', provider: state.health?.provider });
      if (generation !== state.generation || state.file !== file || state.screen !== 'preview') {
        showToast('旅程已提交，可从时光档案继续查看。');
        return;
      }
      state.targetYear = targetYear;
      await startJob(job.job_id, false, heading, targetYear);
    } catch (error) {
      if (generation === state.generation) showToast(error.message || '连接失败，照片已保留，可以再次尝试。', 8000);
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
    getAudio(jobId);
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
    if (year !== null) state.targetYear = year;
    if (state.receiptStatus !== manifest.status) { rememberJob(manifest); state.receiptStatus = manifest.status; }
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
    text('result-mode', (demo ? '本地效果演示 · 未调用 AI' : replay ? '已存档旅程 · 无生成调用' : 'AI 想象重建') + (manifest.scene?.is_outdoor === false ? ' · 室内场景，效果有限' : ''));
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
    if (done > 0) $('generation-overlay').hidden = true;
    $('progress-strip').hidden = state.finalLoaded && ['done', 'done_partial'].includes(manifest.status);
    syncChrome();
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
    syncChrome();
    if (manifest.result?.status === 'done' && !state.finalLoaded) {
      try {
        const image = await loadImage(`/jobs/${encodeURIComponent(manifest.job_id)}/result`);
        if (generation !== state.generation) return;
        const ctx = $('past-canvas').getContext('2d'); ctx.drawImage(image, 0, 0, geometry.W, geometry.H);
        duplicateCanvas($('past-canvas'), geometry.W, geometry.H);
        state.finalLoaded = true; $('generation-overlay').hidden = true;
        $('progress-strip').hidden = true;
        $('download-button').href = `/jobs/${encodeURIComponent(manifest.job_id)}/result`;
        $('download-button').hidden = false;
        text('result-subtitle', isDemo(manifest) ? '工程示例。拖动圆点，探索今昔对比。' : '时间走了很远，视角始终在这里。');
        if (manifest.status === 'done_partial') showToast('部分区域未能完成重建，已保留原始画面。');
        syncChrome();
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
        state.yearMismatch = true;
        $('generation-overlay').hidden = false;
        text('generation-title', '返回的年份与选择不一致');
        text('generation-detail', `你选择了 ${state.expectedYear} 年，请重新生成。`);
        text('progress-text', '已停止加载，避免显示其他年份的结果');
        syncChrome(); return;
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
    document.body.classList.add('revealing'); resizeViewport();
    state.offset = constrainOffset(center * state.renderWidth - $('pano-viewport').clientWidth / 2); render();
    // The viewer has been watching tiles land on the past layer. Do not snap that away:
    // sweep back to the present as a deliberate "before", hold, then sweep into the past.
    await sweep(state.pastPercent, 0, reduced ? 0 : 420);
    if (generation !== state.generation) return;
    await new Promise((resolve) => setTimeout(resolve, reduced ? 60 : 320));
    if (generation !== state.generation) return;
    playAudio();
    await sweep(0, 100, reduced ? 0 : 1500);
    if (generation !== state.generation) return;
    document.body.classList.remove('revealing'); state.revealing = false;
    resizeViewport(); state.offset = constrainOffset(center * state.renderWidth - $('pano-viewport').clientWidth / 2);
    resetMotionOrigin();
    if (viewRevision === state.viewRevision) setPastPercent(100);
    syncChrome();
  }

  function metricNumber(value, suffix = ' s') { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) + suffix : '—'; }
  function renderMetrics(manifest) {
    const metrics = manifest.metrics || {}, seam = metrics.seam_err || {}, align = metrics.alignment || {};
    const cells = [
      ['首个可见画面', metricNumber(metrics.first_view_s), '首次完成的重建画面'],
      ['完整旅程', metricNumber(metrics.total_s), '本次运行实际用时'],
      ['接缝色差 · 生成 → 最终', `${metricNumber(seam.raw, '')} → ${metricNumber(seam.at_seam_cut ?? seam.after_color_match, '')}`,
        seam.at_seam_cut == null ? `调色后 ${metricNumber(seam.after_color_match, '')}` :
          `调色 ${metricNumber(seam.after_color_match, '')} · 统一曝光 ${metricNumber(seam.after_compensation, '')} · 切缝 ${seam.carved_seams ?? 0} 处`],
      ['相对串行加速', metricNumber(metrics.speedup, '×'), metrics.serial_baseline_s == null ? '尚未测量串行基线' : `串行基线 ${metricNumber(metrics.serial_baseline_s)}`],
      ['像素对齐 · 配准前 / 后', `${metricNumber(align.score_before, '')} / ${metricNumber(align.score_after, '')}`,
        align.mean_shift_px == null ? '尚未测量' : `平均漂移 ${metricNumber(align.mean_shift_px, ' px')} · 已校正 ${align.applied ?? 0} 块`],
    ];
    $('metrics-panel').innerHTML = cells.map(([name, value, note]) => `<div class="metric"><span>${escapeHTML(name)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></div>`).join('') + `<p class="metrics-note">${isDemo(manifest) ? '以上为本地演示管线的运行数据，不代表 AI 服务的速度或质量。' : '数据来自该旅程的实际运行；回放不重新计时。'} 破折号表示尚未测量。接缝色差采用 Lab 距离，数值越小代表两块拼图越一致；这不衡量历史真实性。最终值测的是实际裁切路径上的差异：相邻两块若画出了不同的物体，我们不把它们平均成重影，而是沿着两块最吻合的一条竖线裁开。${manifest.scene?.fallback ? ' 场景解析使用了默认设置。' : ''}${manifest.anchor?.status === 'skipped' ? ' 年代参考图未生成，已跳过色彩匹配。' : ''}${manifest.scene?.is_outdoor === false ? ' 这是室内场景：重建只更换材质与陈设，效果通常弱于室外街景。' : ''} 像素对齐为原图与生成图边缘结构的相关度，1 表示完全重合。</p>`;
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
    $('gyro-button').innerHTML = '<svg><use href="#i-gyro"/></svg>开启转动跟随';
    $('gyro-button').disabled = false; $('motion-button').disabled = false;
    $('gyro-button').setAttribute('aria-pressed', 'false'); $('recenter-button').hidden = true;
    $('motion-button').hidden = true;
  }
  function gyroFallback(message) {
    disableGyro();
    motionPrompt('点按重试转动跟随', message);
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
      $('gyro-button').innerHTML = '<svg><use href="#i-check"/></svg>转动跟随已开启';
      motionPrompt('已开启 · 转动手机探索');
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
      if (!window.isSecureContext) { gyroFallback('转动跟随需要 HTTPS，请使用手机预览链接打开。'); return; }
      if (!window.DeviceOrientationEvent) { gyroFallback('浏览器未提供方向传感器，请在手机 Safari 或 Chrome 中打开。'); return; }
      state.gyroPending = true;
      $('gyro-button').disabled = true; $('motion-button').disabled = true;
      // Keep the permission call inside the original tap's user activation on iOS.
      if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await window.DeviceOrientationEvent.requestPermission();
        if (request !== state.gyroRequest) return;
        if (permission !== 'granted') { gyroFallback('未获得转动权限。请在浏览器的网站设置中允许运动与方向访问，再重试。'); return; }
      }
      if (request !== state.gyroRequest) return;
      state.gyro = true; state.gyroSeen = false; state.gyroSignal = false; resetMotionOrigin();
      window.addEventListener('deviceorientation', onOrientation);
      $('gyro-button').innerHTML = '<svg><use href="#i-gyro"/></svg>暂停转动跟随';
      $('gyro-button').setAttribute('aria-pressed', 'true'); $('recenter-button').hidden = false;
      motionPrompt('请竖起手机，轻轻左右转动');
      clearTimeout(enableGyro.timer);
      enableGyro.timer = setTimeout(() => {
        if (state.gyro && !state.gyroSeen) {
          motionPrompt(state.gyroSignal ? '请竖起手机，向前看' : '未收到方向 · 点按重试', state.gyroSignal ?
            '将手机竖起，让后置摄像头朝向前方，再左右转动。' : '请检查浏览器的运动与方向权限；也可以继续拖动。');
        }
      }, 6000);
    } catch { if (request === state.gyroRequest) gyroFallback('无法开启转动跟随，请在手机 Safari 或 Chrome 中允许方向访问后重试。'); }
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
  $('recenter-button').addEventListener('click', () => { resetMotionOrigin(); showToast('已将当前视角设为中心。', 2200); });
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
    const entry = {
      ...previous, job_id: manifest.job_id, place: manifest.place, decade: manifest.decade,
      target_year: yearOf(manifest), anchor_year: manifest.anchor_year, provider: manifest.provider, demo: isDemo(manifest),
      status: manifest.status, metrics: manifest.metrics, saved_at: Date.now(),
    };
    try { localStorage.setItem('century-recent-jobs', JSON.stringify([entry, ...entries.filter((item) => item.job_id !== entry.job_id)].slice(0, 24))); }
    catch { /* Storage restrictions do not interrupt the active journey. */ }
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
        `/jobs/${manifest.job_id}/result`, `/jobs/${manifest.job_id}/audio`,
        ...(manifest.tiles || []).filter((tile) => tile.status === 'done').map((tile) => tile.path ? assetURL(tile.path) : `/jobs/${manifest.job_id}/tiles/${tile.i}`),
      ];
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); if (state.jobId === jobId) state.cachePending = false; }, 15000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout); channel.port1.close();
        if (state.jobId === jobId) state.cachePending = false;
        if (!event.data?.ok) return;
        const entry = { job_id: manifest.job_id, place: manifest.place, target_year: yearOf(manifest), decade: manifest.decade, anchor_year: manifest.anchor_year, metrics: manifest.metrics, provider: manifest.provider, demo: isDemo(manifest), mode: 'replay' };
        const replays = localReplays().filter((replay) => replay.job_id !== entry.job_id);
        replays.unshift(entry);
        try { localStorage.setItem('century-replays', JSON.stringify(replays.slice(0, 12))); } catch { /* Quota restriction does not affect the current viewer. */ }
        if (state.jobId === manifest.job_id) {
          state.offlineSaved = true;
          text('progress-text', '旅程已保存 · 断网后可从时光档案重访');
        }
      };
      (navigator.serviceWorker.controller || registration.active)?.postMessage({ type: 'CACHE_JOURNEY', urls, jobId: manifest.job_id }, [channel.port2]);
    } catch { if (state.jobId === jobId) state.cachePending = false; }
  }
  async function openReplays() {
    closeOptions();
    const dialog = $('replay-dialog'); if (!dialog.open) dialog.showModal();
    $('replay-list').innerHTML = '<p class="empty-state">正在打开时光档案…</p>';
    let entries = [];
    try {
      const response = await fetch('/replays');
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json(); entries = Array.isArray(body) ? body : body.replays || [];
    } catch { /* Merge confirmed device caches below. */ }
    const device = localReplays();
    const map = new Map([...storedJourneys('century-recent-jobs'), ...device, ...entries].map((entry) => [entry.job_id, entry]));
    entries = [...map.values()];
    if (!entries.length) { $('replay-list').innerHTML = '<p class="empty-state">还没有保存的旅程。<br>联网完成一次生成后，就能在这里离线重访。</p>'; return; }
    $('replay-list').innerHTML = '';
    entries.forEach((entry) => {
      const button = document.createElement('button'); button.className = 'replay-card';
      const demo = isDemo(entry), cached = device.some((item) => item.job_id === entry.job_id);
      const pending = entry.status === 'running';
      const status = pending ? '生成中的旅程 · 点击继续查看' : entry.status === 'error' ? '这次旅程未完成 · 查看详情' : demo ? '工程示例 · 本地调色' : '已完成的想象重建';
      button.innerHTML = `<img src="/jobs/${encodeURIComponent(entry.job_id)}/${pending ? 'preview' : 'result'}" alt="${escapeHTML(placeName(entry.place))}全景缩略图"><span class="replay-card-content"><strong>${escapeHTML(yearOf(entry) ?? '旅程')}</strong><span>${escapeHTML(placeName(entry.place))}</span><small>${status}${cached ? ' · 已存本机' : ''}</small></span><span>↗</span>`;
      button.querySelector('img').addEventListener('error', (event) => { event.target.hidden = true; }, { once: true });
      button.addEventListener('click', () => { unlockAudio(); dialog.close(); startJob(entry.job_id, true); });
      $('replay-list').appendChild(button);
    });
  }
  $('sample-button').addEventListener('click', openReplays); $('nav-replays').addEventListener('click', openReplays);
  $('close-replays').addEventListener('click', () => $('replay-dialog').close());
  $('replay-dialog').addEventListener('click', (event) => { if (event.target === $('replay-dialog')) { const rect = $('replay-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('replay-dialog').close(); } });
  window.addEventListener('offline', connectionStatus);
  window.addEventListener('online', () => { checkHealth(); if (state.finalLoaded && state.manifest) cacheJourney(state.manifest); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* HTTPS or localhost is needed for offline mode. */ });
  checkHealth();
  showScreen('capture');
  if (motionDevice) {
    if (window.isSecureContext && window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission !== 'function') enableGyro();
    else motionPrompt('点按开启转动视窗');
  }
  setTimeout(() => { $('gesture-hint').hidden = true; }, 5000);
  const replayId = new URLSearchParams(location.search).get('replay');
  if (replayId && /^[a-zA-Z0-9_-]{1,100}$/.test(replayId)) startJob(replayId, true);
})();
