import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div', attrs = '') {
    Object.assign(this, { tag, handlers: {}, attributes: {}, dataset: {}, value: '', hidden: /\shidden(?:\s|$)/.test(attrs), disabled: false, clientWidth: 390, clientHeight: 844, naturalWidth: 3000, naturalHeight: 750, children: [] });
    for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
      this.attributes[name] = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
    }
    this.style = { setProperty(name, value) { this[name] = value; } };
    const classes = new Set((this.attributes.class || '').split(/\s+/));
    this.classList = {
      contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      toggle: (name, active = !classes.has(name)) => { if (active) classes.add(name); else classes.delete(name); },
    };
    this.firstElementChild = this.lastElementChild = { style: {}, textContent: '' };
  }
  addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
  async emit(name, detail = {}) { for (const callback of this.handlers[name] || []) await callback({ target: this, preventDefault() {}, ...detail }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) {
    return selector.split(',').some((part) => {
      const value = part.trim().split(/\s+/).at(-1);
      if (value.startsWith('#')) return this.attributes.id === value.slice(1);
      if (value.startsWith('.')) return this.classList.contains(value.slice(1));
      if (value === '[data-year]') return 'year' in this.dataset;
      return this.tag === value;
    });
  }
  closest(selector) { return this.matches(selector) ? this : null; }
  querySelector(selector) { return this.children.find((element) => element.matches(selector)) || null; }
  set innerHTML(value) { this._html = value; this.children = /<img\b/.test(value) ? [new Element('img')] : []; }
  get innerHTML() { return this._html || ''; }
  insertAdjacentHTML(_position, value) { this.innerHTML = (this.innerHTML || '') + value; }
  appendChild(element) { this.children.push(element); }
  click() { return this.emit('click'); }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  checkValidity() { return true; }
  getContext() { return { drawImage() {}, fillRect() {} }; }
}

function app(options = {}) {
  const nodes = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)].map(([, tag, attrs]) => new Element(tag, attrs));
  const elements = new Map(nodes.filter((element) => element.attributes.id).map((element) => [element.attributes.id, element]));
  const requests = [], jobs = new Map();
  const fetch = async (url, request) => {
    if (options.fetch) {
      const response = await options.fetch(url, request);
      if (response) return response;
    }
    if (url === '/health') return { ok: true, json: async () => ({ min_year: 1800, max_year: 2026, default_year: 1925 }) };
    if (url === '/location/resolve') return { ok: true, json: async () => ({ place: { name: 'Pittsburgh', cc: 'US' } }) };
    if (url === '/jobs') {
      requests.push(request.body);
      const job_id = `job-${requests.length}`;
      jobs.set(job_id, { job_id, target_year: Number(request.body.get('target_year')), status: 'queued', tiles: [] });
      return { ok: true, json: async () => ({ job_id }) };
    }
    const id = /^\/jobs\/(.+)\/manifest$/.exec(url)?.[1];
    if (id) return { ok: true, json: async () => jobs.get(id) };
    throw new Error(`Unexpected request: ${url}`);
  };
  const document = {
    title: 'CENTURY PANO', body: nodes.find((element) => element.tag === 'body'), addEventListener() {},
    getElementById(id) { assert.ok(elements.has(id), `Missing HTML element: ${id}`); return elements.get(id); },
    querySelector(selector) { return nodes.find((element) => element.matches(selector)) || null; },
    querySelectorAll(selector) { return nodes.filter((element) => element.matches(selector)); },
    createElement() { return new Element(); },
  };
  const storage = new Map();
  const context = vm.createContext({
    document, navigator: { onLine: true, maxTouchPoints: 0, ...options.navigator }, fetch, FormData, Blob, File, URL, URLSearchParams,
    window: { addEventListener() {}, removeEventListener() {}, scrollTo() {} },
    location: { search: '', pathname: '/' }, history: { replaceState() {} },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
    matchMedia: () => ({ matches: false }),
    Image: class { constructor() { this.naturalWidth = 3000; this.naturalHeight = 750; } set src(_value) { queueMicrotask(() => this.onload?.()); } },
    ResizeObserver: class { observe() {} },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  });
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'globalThis.hooks = { state, setTargetYear, yearOf, locate, updateMetadata, pollManifest };\n})();');
  vm.runInContext(readFileSync(new URL('../web/motion.js', import.meta.url), 'utf8'), context);
  vm.runInContext(instrumented, context);
  return { ...context.hooks, elements, document, requests, jobs };
}

function photoGPS() {
  const buffer = Buffer.alloc(140);
  buffer.writeUInt16BE(0xffd8, 0); buffer.writeUInt16BE(0xffe1, 2); buffer.writeUInt16BE(134, 4);
  buffer.write('Exif\0\0', 6); buffer.write('II', 12); buffer.writeUInt16LE(42, 14); buffer.writeUInt32LE(8, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(0x8825, 22); buffer.writeUInt32LE(26, 30);
  buffer.writeUInt16LE(4, 38);
  for (const [index, tag, type, count, value] of [[0, 1, 2, 2, 78], [1, 2, 5, 3, 76], [2, 3, 2, 2, 87], [3, 4, 5, 3, 100]]) {
    const entry = 40 + index * 12;
    buffer.writeUInt16LE(tag, entry); buffer.writeUInt16LE(type, entry + 2); buffer.writeUInt32LE(count, entry + 4); buffer.writeUInt32LE(value, entry + 8);
  }
  for (const [start, degrees] of [[88, 40], [112, 79]]) {
    for (let index = 0; index < 3; index++) {
      buffer.writeUInt32LE(index === 0 ? degrees : 0, start + index * 8); buffer.writeUInt32LE(1, start + index * 8 + 4);
    }
  }
  return new Blob([buffer], { type: 'image/jpeg' });
}

test('year controls support adjacent years and retain old replay aliases', async () => {
  const view = app();
  await Promise.resolve();
  for (const year of [1800, 1944, 1945, 1946, 1949, 1950, 2026]) {
    view.setTargetYear(year, true);
    assert.equal(view.state.targetYear, year);
    assert.equal(Number(view.elements.get('year-input').value), year);
    assert.equal(Number(view.elements.get('year-range').value), year);
  }
  assert.match(html, /id="year-range"[^>]+step="1"/);
  assert.equal(view.yearOf({ target_year: 1945, anchor_year: 1955, decade: '1970s' }), 1945);
  assert.equal(view.yearOf({ anchor_year: 1950, decade: '1970s' }), 1950);
  assert.equal(view.yearOf({ decade: '1920s' }), 1925);
});

test('generating 1945 then 1950 submits distinct exact-year requests', async () => {
  const view = app();
  view.state.file = new Blob(['photo'], { type: 'image/jpeg' });
  for (const year of [1945, 1950]) {
    view.state.screen = 'preview'; view.setTargetYear(year, true);
    await view.elements.get('generate-button').emit('click');
    assert.equal(view.requests.at(-1).get('target_year'), String(year));
    assert.equal(view.requests.at(-1).has('decade'), false);
    assert.equal(view.state.expectedYear, year);
  }
  assert.equal(view.requests.length, 2);
  assert.equal(view.state.jobId, 'job-2');
});

test('photo GPS precedes device GPS and manual location survives asynchronous resolution', async () => {
  let deviceCalls = 0, resolveCity;
  const navigator = { geolocation: { getCurrentPosition(success) { deviceCalls++; success({ coords: { latitude: 1, longitude: 2 } }); } } };
  const delayedCity = new Promise((resolve) => { resolveCity = resolve; });
  const view = app({ navigator, fetch: (url) => url === '/location/resolve' ? delayedCity : null });
  const photo = photoGPS();
  const locating = view.locate(photo, 0, true);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.equal(deviceCalls, 0);
  assert.equal(view.state.locationSource, 'exif');
  assert.equal(view.state.location.lat, 40); assert.equal(view.state.location.lon, -79);
  view.elements.get('place-input').value = 'Pittsburgh, PA, US';
  await view.elements.get('place-input').emit('input');
  resolveCity({ ok: true, json: async () => ({ place: { name: 'Late automatic city', cc: 'US' } }) });
  await locating;
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.equal(view.elements.get('place-input').value, 'Pittsburgh, PA, US', 'late GPS resolution cannot overwrite a manually edited city');
  assert.equal(view.state.locationSource, 'exif', 'editing the city retains photo coordinates for clearing the override');
  view.state.file = photo; view.state.screen = 'preview';
  await view.elements.get('generate-button').emit('click');
  assert.equal(view.requests[0].get('place'), 'Pittsburgh, PA, US');
  view.elements.get('place-input').value = '';
  await view.elements.get('place-input').emit('input');
  view.state.screen = 'preview';
  await view.elements.get('generate-button').emit('click');
  assert.equal(view.requests[1].has('place'), false, 'clearing a manual city restores photo GPS precedence on the server');
  assert.deepEqual(Buffer.from(await view.requests[1].get('image').arrayBuffer()), Buffer.from(await photo.arrayBuffer()), 'the original photo GPS remains available to the server');

  const device = app({ navigator });
  const noExif = new Blob(['no exif']);
  await device.locate(noExif, 0);
  assert.equal(deviceCalls, 0, 'opening a photo does not request device location');
  device.elements.get('place-input').value = 'Pittsburgh, PA, US';
  await device.elements.get('place-input').emit('input');
  await device.locate(noExif, 0, true);
  assert.equal(deviceCalls, 1);
  assert.equal(device.state.locationSource, 'geolocation');
  assert.equal(device.elements.get('place-input').value, 'Pittsburgh, PA, US');
  device.state.file = noExif; device.state.screen = 'preview';
  await device.elements.get('generate-button').emit('click');
  assert.equal(device.requests[0].get('place'), 'Pittsburgh, PA, US');
  assert.equal(device.requests[0].get('lat'), '1');
});

test('mismatched-year results stop before applying a manifest', async () => {
  const view = app();
  view.state.jobId = 'wrong-year'; view.state.expectedYear = 1945;
  view.jobs.set('wrong-year', { job_id: 'wrong-year', target_year: 1950, status: 'done' });
  await view.pollManifest(view.state.generation);
  assert.equal(view.state.manifest, null);
  assert.match(view.elements.get('generation-title').textContent, /年份与选择不一致/);
});

test('selecting Now while generating remains on the original as tiles and the final result arrive', async () => {
  const view = app();
  view.state.file = new Blob(['photo'], { type: 'image/jpeg' });
  view.state.screen = 'preview'; view.setTargetYear(1945, true);
  await view.elements.get('generate-button').emit('click');
  await view.elements.get('present-button').emit('click');
  const manifest = {
    job_id: view.state.jobId, target_year: 1945, status: 'running',
    geometry: { W: 3000, H: 750, tile_w: 1024, n: 1, wrap: false },
    tiles: [{ i: 0, x: 0, status: 'done' }],
  };
  view.jobs.set(view.state.jobId, manifest);
  await view.pollManifest(view.state.generation);
  assert.equal(view.state.loadedTiles.size, 1);
  assert.equal(view.elements.get('compare-button').disabled, false);
  assert.equal(view.state.pastPercent, 0);
  manifest.status = 'done'; manifest.result = { status: 'done' };
  await view.pollManifest(view.state.generation);
  assert.equal(view.state.finalLoaded, true);
  assert.equal(view.state.viewMode, 'present');
  assert.equal(view.state.pastPercent, 0);
  assert.equal(view.elements.get('present-button').getAttribute('aria-pressed'), 'true');
  assert.equal(view.elements.get('window-year').textContent, '现在');
});

test('historical context includes the reference date and unverified site uncertainty safely', () => {
  const view = app();
  view.updateMetadata({ target_year: 1945, place: 'Shanghai', constraints: { historical_context: {
    target_year: 1945, reference_date: '1945-07-01', evidence_basis: 'model_knowledge_unverified',
    period_summary: 'Background <script>alert(1)</script>', site_state: 'undeveloped',
    site_history: 'Earlier undeveloped land', uncertainties: ['Exact site history is unknown'],
  } } });
  const content = view.elements.get('historical-context').innerHTML;
  assert.match(content, /1945 年 7 月 1 日/);
  assert.match(content, /未经史料核实/);
  assert.match(content, /未开发/);
  assert.match(content, /Exact site history is unknown/);
  assert.ok(!content.includes('<script>'));
  assert.match(view.document.title, /^1945 · Shanghai/);
});

test('unrecognized manual cities are explicitly excluded and history progress explains local changes', () => {
  const view = app();
  view.updateMetadata({ target_year: 1945, stage: 'history', place: { name: 'Unknown place', source: 'manual', prompt_safe: false } });
  assert.equal(view.elements.get('place-warning').hidden, false);
  assert.match(view.elements.get('place-warning').textContent, /手填城市未识别，未用于历史推理/);
  assert.match(view.elements.get('location-note').textContent, /补充州 \/ 国家或使用照片定位/);
  assert.equal(view.elements.get('generation-detail').textContent, '正在判断该年份的当地历史与地块变化');
  view.updateMetadata({ target_year: 1945, place: { name: 'Pittsburgh', source: 'manual', prompt_safe: true } });
  assert.equal(view.elements.get('place-warning').hidden, true);
  assert.match(html, /placeholder="城市，例如 Pittsburgh, PA, US"/);
});
