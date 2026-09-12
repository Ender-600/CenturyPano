(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const eraFilters = {
    '1900': 'sepia(.95) saturate(.4) contrast(1.02)',
    '1920': 'sepia(.58) saturate(.65) contrast(.97)',
    '1950': 'sepia(.22) saturate(.82) hue-rotate(-10deg)',
    '1970': 'sepia(.16) saturate(.9) contrast(.92) hue-rotate(-6deg)'
  };
  const stage = $('landscape');
  const present = $('present-image');
  const past = $('past-image');
  const windowEl = document.querySelector('.window');
  const sheet = $('options-sheet');
  const defaultSource = present.getAttribute('src');
  let selectedEra = '1920';
  let lastPastEra = selectedEra;
  let comparing = false;
  let split = 50;
  let pan = .48;
  let imageWidth = 1536;
  let imageHeight = 1024;
  let renderWidth = 0;
  let renderHeight = 0;
  let panDrag = null;
  let sliderPointer = null;
  let objectURL = null;
  let selectionVersion = 0;
  let toastTimer;

  function render() {
    const x = -(renderWidth - stage.clientWidth) * pan;
    const y = (stage.clientHeight - renderHeight) / 2;
    for (const image of [present, past]) image.style.transform = `translate3d(${x}px,${y}px,0)`;
  }
  function resize() {
    const scale = Math.max(stage.clientWidth / imageWidth, stage.clientHeight / imageHeight) * 1.08;
    renderWidth = imageWidth * scale;
    renderHeight = imageHeight * scale;
    for (const image of [present, past]) {
      image.style.width = `${renderWidth}px`;
      image.style.height = `${renderHeight}px`;
    }
    render();
  }
  function dismissHint() { $('gesture-hint').classList.add('dismissed'); }
  function notify(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
  }
  function setSplit(value) {
    split = Math.round(Math.max(0, Math.min(100, value)));
    windowEl.style.setProperty('--split', `${split}%`);
    $('compare-grip').setAttribute('aria-valuenow', String(split));
    $('compare-grip').setAttribute('aria-valuetext', `过去 ${split}%，现在 ${100 - split}%`);
  }
  function setComparison(enabled) {
    if (enabled && selectedEra === 'now') setEra(lastPastEra);
    comparing = enabled;
    windowEl.classList.toggle('comparing', comparing);
    $('compare-button').setAttribute('aria-pressed', String(comparing));
    $('compare-control').hidden = !comparing;
    $('compare-labels').hidden = !comparing;
    $('time-description').textContent = comparing ? '轻轻一划，今昔之间。' : selectedEra === 'now' ? '就在此刻。' : '同一个地方，另一个年代。';
    dismissHint();
  }
  function setEra(era) {
    if (era !== 'now' && !eraFilters[era]) return;
    selectedEra = era;
    document.body.dataset.era = era;
    if (era !== 'now') {
      lastPastEra = era;
      document.documentElement.style.setProperty('--past-filter', eraFilters[era]);
      $('past-label-year').textContent = era;
    }
    $('year-display').textContent = era === 'now' ? '现在' : era;
    $('year-suffix').hidden = era === 'now';
    document.querySelectorAll('.era-picker [data-era]').forEach(button => {
      const active = button.dataset.era === era;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (era === 'now') setComparison(false);
    else $('time-description').textContent = comparing ? '轻轻一划，今昔之间。' : '同一个地方，另一个年代。';
  }
  function setClean(enabled) {
    document.body.classList.toggle('clean', enabled);
    document.querySelectorAll('.chrome').forEach(element => {
      element.inert = enabled;
      if (enabled) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    });
    $('compare-control').inert = enabled;
    $('restore-button').hidden = !enabled;
    dismissHint();
    (enabled ? $('restore-button') : $('clean-button')).focus({ preventScroll: true });
  }
  function openSheet() { sheet.showModal(); dismissHint(); }
  function choosePhoto() { if (sheet.open) sheet.close(); $('photo-input').click(); }
  document.querySelectorAll('.era-picker [data-era]').forEach(button => button.addEventListener('click', () => { setEra(button.dataset.era); dismissHint(); }));
  $('compare-button').addEventListener('click', () => setComparison(!comparing));
  $('upload-button').addEventListener('click', choosePhoto);
  $('sheet-upload').addEventListener('click', choosePhoto);
  $('menu-button').addEventListener('click', openSheet);
  $('close-sheet').addEventListener('click', () => sheet.close());
  $('clean-button').addEventListener('click', () => setClean(true));
  $('restore-button').addEventListener('click', () => setClean(false));
  $('sheet-clean').addEventListener('click', () => { sheet.close(); setClean(true); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('clean')) setClean(false);
  });
  sheet.addEventListener('click', event => {
    if (event.target !== sheet) return;
    const rect = sheet.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) sheet.close();
  });

  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    stage.setPointerCapture(event.pointerId);
    panDrag = { id: event.pointerId, x: event.clientX, pan };
    stage.classList.add('dragging');
    dismissHint();
  });
  stage.addEventListener('pointermove', event => {
    if (!panDrag || event.pointerId !== panDrag.id) return;
    pan = Math.max(0, Math.min(1, panDrag.pan - (event.clientX - panDrag.x) / Math.max(1, renderWidth - stage.clientWidth)));
    render();
  });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(eventName, () => {
    panDrag = null;
    stage.classList.remove('dragging');
  });
  stage.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') pan = 0;
    else if (event.key === 'End') pan = 1;
    else pan = Math.max(0, Math.min(1, pan + (event.key === 'ArrowRight' ? .04 : -.04)));
    dismissHint(); render();
  });
  const grip = $('compare-grip');
  function slideAt(clientX) {
    const rect = stage.getBoundingClientRect();
    setSplit((clientX - rect.left) / rect.width * 100);
  }
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    sliderPointer = event.pointerId;
    slideAt(event.clientX);
  });
  grip.addEventListener('pointermove', event => { if (sliderPointer === event.pointerId) slideAt(event.clientX); });
  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) grip.addEventListener(eventName, () => { sliderPointer = null; });
  grip.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    setSplit(event.key === 'Home' ? 0 : event.key === 'End' ? 100 : split + (event.key === 'ArrowRight' ? 2 : -2));
  });

  async function loadSource(url, version) {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (version !== selectionVersion) return false;
    imageWidth = image.naturalWidth;
    imageHeight = image.naturalHeight;
    present.src = url; past.src = url;
    pan = .48;
    resize();
    return true;
  }
  $('photo-input').addEventListener('change', async () => {
    const file = $('photo-input').files[0];
    $('photo-input').value = '';
    if (!file) return;
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) return notify('请选择 JPG、PNG 或 WebP 照片。');
    if (file.size > 40 * 1024 * 1024) return notify('请选择小于 40 MB 的照片。');
    const version = ++selectionVersion;
    const url = URL.createObjectURL(file);
    try {
      if (!await loadSource(url, version)) { URL.revokeObjectURL(url); return; }
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = url;
      present.alt = '你选择的照片'; past.alt = '你选择的照片的年代色调演示';
      $('place-name').textContent = '你的视角';
      $('file-label').textContent = file.name;
      $('concept-note').textContent = '本地照片 · 年代色调演示';
      notify('照片已载入。左右滑动，找一个喜欢的视角。');
    } catch {
      URL.revokeObjectURL(url);
      if (version === selectionVersion) notify('这张照片暂时无法读取，请换一张试试。');
    }
  });
  $('reset-button').addEventListener('click', async () => {
    sheet.close();
    const version = ++selectionVersion;
    try {
      if (!await loadSource(defaultSource, version)) return;
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = null;
      present.alt = '匹兹堡河岸与金色桥梁的概念全景';
      past.alt = '同一风景的年代色调模拟';
      $('place-name').textContent = 'Pittsburgh';
      $('file-label').textContent = '全景照片，会更开阔。';
      $('concept-note').textContent = '概念影像 · 年代色调演示';
      setEra('1920'); setComparison(false); setSplit(50);
      notify('回到最初的视角。');
    } catch { if (version === selectionVersion) notify('概念全景暂时无法载入，请稍后重试。'); }
  });
  present.addEventListener('load', () => {
    imageWidth = present.naturalWidth;
    imageHeight = present.naturalHeight;
    resize();
  });
  present.addEventListener('error', () => notify('画面暂时无法载入，可以选择自己的照片。'));
  new ResizeObserver(resize).observe(stage);
  setEra('1920'); setSplit(50); resize();
  setTimeout(dismissHint, 5000);
})();
