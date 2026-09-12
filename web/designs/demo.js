(() => {
  'use strict';
  const eras = {
    '1900': { name: '世纪之交', filter: 'sepia(1) saturate(.35) contrast(1.1) brightness(.94)' },
    '1920': { name: '摩登年代', filter: 'sepia(.85) saturate(.55) contrast(1.05)' },
    '1950': { name: '复古日常', filter: 'sepia(.32) saturate(.75) hue-rotate(-12deg)' },
    '1970': { name: '胶片记忆', filter: 'sepia(.2) saturate(.85) contrast(.9) hue-rotate(-8deg)' }
  };
  let year = '1920';
  let source = document.querySelector('img[data-scene]')?.getAttribute('src') || '../assets/pittsburgh.png';
  const defaultSource = source;
  let uploadUrl = null;
  let selectionVersion = 0;
  let split = 50;
  let toastTimer;
  const toast = document.createElement('div');
  toast.className = 'demo-toast';
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  document.body.append(toast);
  function notify(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }
  const preview = document.createElement('dialog');
  preview.className = 'demo-dialog';
  preview.setAttribute('aria-labelledby', 'demo-preview-title');
  preview.innerHTML = `<div class="demo-dialog-top"><div><p>A WINDOW THROUGH TIME</p><h2 id="demo-preview-title">走进 <span data-year>1920</span> 年代</h2></div><button class="demo-close" data-close aria-label="关闭全景预览">×</button></div><div class="demo-viewer" data-compare tabindex="0" aria-label="全景预览，可拖动或使用左右方向键平移"><img data-scene alt="城市概念影像" draggable="false"><div class="demo-viewer-past"><img data-scene data-past alt="年代色调模拟" draggable="false"></div><span class="demo-view-label"><span data-year>1920</span> · 色调模拟</span><span class="demo-view-label now">原始画面</span><span class="demo-viewer-hint">↔ 拖动探索 · 下方滑杆比较今昔</span></div><div class="demo-controls"><label for="demo-modal-compare"><span>过去与现在</span><span data-compare-label>50%</span></label><input id="demo-modal-compare" data-compare-range type="range" min="0" max="100" value="50"><p>当前为前端交互演示，年代变化使用色调模拟。概念图并非历史影像；照片仅在此浏览器预览。</p></div><div class="demo-era-row">${Object.keys(eras).map(era => `<button data-era="${era}" aria-pressed="${era === year}">${era}s</button>`).join('')}</div>`;
  const archive = document.createElement('dialog');
  archive.className = 'demo-dialog';
  archive.setAttribute('aria-labelledby', 'demo-archive-title');
  archive.innerHTML = `<div class="demo-dialog-top"><div><p>THE TIME ARCHIVE</p><h2 id="demo-archive-title">从一张时光明信片开始</h2></div><button class="demo-close" data-close aria-label="关闭时光档案">×</button></div><p class="demo-archive-intro">挑一个年代，体验同一座城市的不同色调。<br>以下为设计示例，使用同一张 AI 概念图，并非真实历史重建。</p><div class="demo-archive-grid">${[['1900','世纪初的河岸'],['1920','钢铁之城的午后'],['1970','一段胶片记忆']].map(([era,title]) => `<button class="demo-archive-card" data-sample="${era}"><img src="${defaultSource}" alt="${title}概念预览"><span>${title}<small>PITTSBURGH · ${era}s ↗</small></span></button>`).join('')}</div>`;
  document.body.append(preview, archive);
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/jpeg,image/png,image/webp';
  picker.hidden = true;
  picker.setAttribute('aria-label', '选择本地照片');
  document.body.append(picker);
  function updateImages() {
    document.querySelectorAll('img[data-scene]').forEach(img => { img.src = source; });
  }
  function selectEra(value) {
    if (!eras[value]) return;
    year = value;
    document.querySelectorAll('[data-era]').forEach(button => {
      const active = button.dataset.era === year;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.querySelectorAll('[data-year]').forEach(node => { node.textContent = year; });
    document.querySelectorAll('[data-era-name]').forEach(node => { node.textContent = eras[year].name; });
    document.querySelectorAll('[data-past]').forEach(node => { node.style.filter = eras[year].filter; });
    document.body.style.setProperty('--era-filter', eras[year].filter);
  }
  function compare(value) {
    split = Math.max(0, Math.min(100, Number(value) || 0));
    document.querySelectorAll('[data-compare]').forEach(node => { node.style.setProperty('--split', `${split}%`); });
    document.querySelectorAll('[data-compare-range]').forEach(input => {
      input.value = String(split);
      input.setAttribute('aria-valuetext', `过去 ${split}%，现在 ${100 - split}%`);
    });
    document.querySelectorAll('[data-compare-label]').forEach(node => { node.textContent = `${split}%`; });
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-era')) selectEra(target.dataset.era);
    if (target.hasAttribute('data-upload')) picker.click();
    if (target.hasAttribute('data-preview')) preview.showModal();
    if (target.hasAttribute('data-archive')) archive.showModal();
    if (target.hasAttribute('data-close')) target.closest('dialog').close();
    if (target.hasAttribute('data-sample')) {
      selectionVersion += 1;
      source = defaultSource;
      updateImages();
      selectEra(target.dataset.sample);
      document.querySelectorAll('[data-filename]').forEach(node => { node.textContent = 'Pittsburgh · 概念全景'; });
      archive.close();
      preview.showModal();
    }
  });
  document.addEventListener('input', event => {
    if (event.target.matches('[data-compare-range]')) compare(event.target.value);
  });
  [preview, archive].forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    picker.value = '';
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) return notify('请使用 JPG、PNG 或 WebP 图片。');
    if (file.size > 40 * 1024 * 1024) return notify('图片请小于 40 MB。');
    const version = ++selectionVersion;
    const nextUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = nextUrl;
    try {
      await image.decode();
      if (version !== selectionVersion) {
        URL.revokeObjectURL(nextUrl);
        return;
      }
      if (uploadUrl) URL.revokeObjectURL(uploadUrl);
      uploadUrl = nextUrl;
      source = nextUrl;
      updateImages();
      document.querySelectorAll('[data-filename]').forEach(node => { node.textContent = file.name; });
      notify('照片已载入，仅在本地预览。试试切换年代与拖动滑杆。');
    } catch {
      URL.revokeObjectURL(nextUrl);
      if (version === selectionVersion) notify('这张图片无法读取，请换一张 JPG 或 PNG。');
    }
  });
  const viewer = preview.querySelector('.demo-viewer');
  let pan = 50;
  let drag = null;
  viewer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, pan };
    viewer.setPointerCapture(event.pointerId);
    viewer.style.cursor = 'grabbing';
  });
  viewer.addEventListener('pointermove', event => {
    if (!drag) return;
    pan = Math.max(0, Math.min(100, drag.pan - (event.clientX - drag.x) / viewer.clientWidth * 100));
    viewer.style.setProperty('--pan-shift', `${-pan / 5}%`);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewer.addEventListener(name, () => { drag = null; viewer.style.cursor = 'grab'; });
  viewer.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    pan = Math.max(0, Math.min(100, pan + (event.key === 'ArrowRight' ? 5 : -5)));
    viewer.style.setProperty('--pan-shift', `${-pan / 5}%`);
  });
  if (window.self !== window.top) document.querySelectorAll('a[href="../"],a[href="../index.html"]').forEach(link => { link.target = '_top'; });
  updateImages();
  selectEra(year);
  compare(split);
})();
