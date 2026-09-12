(() => {
  'use strict';
  const eras = {
    '1900': { name: 'Turn of the Century', filter: 'sepia(1) saturate(.35) contrast(1.1) brightness(.94)' },
    '1920': { name: 'Roaring Twenties', filter: 'sepia(.85) saturate(.55) contrast(1.05)' },
    '1950': { name: 'Golden Days', filter: 'sepia(.32) saturate(.75) hue-rotate(-12deg)' },
    '1970': { name: 'Film Memories', filter: 'sepia(.2) saturate(.85) contrast(.9) hue-rotate(-8deg)' }
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
  preview.innerHTML = `<div class="demo-dialog-top"><div><p>A WINDOW THROUGH TIME</p><h2 id="demo-preview-title">Step into the <span data-year>1920</span>s</h2></div><button class="demo-close" data-close aria-label="Close panorama preview">×</button></div><div class="demo-viewer" data-compare tabindex="0" aria-label="Panorama preview. Drag or use the left and right arrow keys to pan"><img data-scene alt="Concept image of the city" draggable="false"><div class="demo-viewer-past"><img data-scene data-past alt="Simulated era color grading" draggable="false"></div><span class="demo-view-label"><span data-year>1920</span> · Simulated color grading</span><span class="demo-view-label now">Original image</span><span class="demo-viewer-hint">↔ Drag to explore · Use the slider below to compare</span></div><div class="demo-controls"><label for="demo-modal-compare"><span>Past and present</span><span data-compare-label>50%</span></label><input id="demo-modal-compare" data-compare-range type="range" min="0" max="100" value="50"><p>This interactive demo uses color grading to simulate different eras. The concept art is not historical imagery. Photos are previewed only in this browser.</p></div><div class="demo-era-row">${Object.keys(eras).map(era => `<button data-era="${era}" aria-pressed="${era === year}">${era}s</button>`).join('')}</div>`;
  const archive = document.createElement('dialog');
  archive.className = 'demo-dialog';
  archive.setAttribute('aria-labelledby', 'demo-archive-title');
  archive.innerHTML = `<div class="demo-dialog-top"><div><p>THE TIME ARCHIVE</p><h2 id="demo-archive-title">Start with a postcard from the past</h2></div><button class="demo-close" data-close aria-label="Close Time Archive">×</button></div><p class="demo-archive-intro">Choose an era to see the same city in a different light.<br>These design samples use the same AI concept image and are not historical reconstructions.</p><div class="demo-archive-grid">${[['1900','Riverbanks at the Turn of the Century'],['1920','An Afternoon in the Steel City'],['1970','Memories on Film']].map(([era,title]) => `<button class="demo-archive-card" data-sample="${era}"><img src="${defaultSource}" alt="${title} concept preview"><span>${title}<small>PITTSBURGH · ${era}s ↗</small></span></button>`).join('')}</div>`;
  document.body.append(preview, archive);
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/jpeg,image/png,image/webp';
  picker.hidden = true;
  picker.setAttribute('aria-label', 'Choose a local photo');
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
      input.setAttribute('aria-valuetext', `Past ${split}%, present ${100 - split}%`);
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
      document.querySelectorAll('[data-filename]').forEach(node => { node.textContent = 'Pittsburgh · Concept panorama'; });
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
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) return notify('Please use a JPG, PNG, or WebP image.');
    if (file.size > 40 * 1024 * 1024) return notify('Please choose an image smaller than 40 MB.');
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
      notify('Photo loaded for local preview. Try switching eras and dragging the slider.');
    } catch {
      URL.revokeObjectURL(nextUrl);
      if (version === selectionVersion) notify('Unable to read this image. Try another JPG or PNG.');
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
