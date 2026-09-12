import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

class Element {
  constructor() {
    Object.assign(this, { handlers: {}, attributes: {}, dataset: {}, style: {}, value: '', hidden: false, disabled: false, clientWidth: 800, clientHeight: 400, children: [] });
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.firstElementChild = this.lastElementChild = { style: {}, textContent: '' };
  }
  addEventListener(name, callback) { (this.handlers[name] ||= []).push(callback); }
  async emit(name) { for (const callback of this.handlers[name] || []) await callback({ target: this }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  insertAdjacentHTML(_position, value) { this.innerHTML = (this.innerHTML || '') + value; }
  appendChild(element) { this.children.push(element); }
  checkValidity() { return true; }
  getContext() { return { drawImage() {} }; }
}

function app(options = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const presets = [...html.matchAll(/data-year="(\d+)"/g)].map((match) => Object.assign(new Element(), { dataset: { year: match[1] } }));
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
    title: 'CENTURY PANO', body: new Element(),
    getElementById(id) { assert.ok(elements.has(id), `Missing HTML element: ${id}`); return elements.get(id); },
    querySelector() { return new Element(); },
    querySelectorAll(selector) { assert.equal(selector, '[data-year]'); return presets; },
    createElement() { return new Element(); },
  };
  const context = vm.createContext({
    document, navigator: { onLine: true, ...options.navigator }, fetch, FormData, Blob, URL, URLSearchParams,
    window: { addEventListener() {}, removeEventListener() {}, scrollTo() {} },
    location: { search: '', pathname: '/' }, history: { replaceState() {} },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {},
    ResizeObserver: class { observe() {} },
    localStorage: { getItem() { return null; } },
  });
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'globalThis.hooks = { state, setTargetYear, yearOf, locate, updateMetadata, pollManifest };\n})();');
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
  let deviceCalls = 0;
  const view = app({ navigator: { geolocation: { getCurrentPosition(success) { deviceCalls++; success({ coords: { latitude: 1, longitude: 2 } }); } } } });
  await view.locate(photoGPS(), 0);
  assert.equal(deviceCalls, 0);
  assert.equal(view.state.locationSource, 'exif');
  assert.equal(view.state.location.lat, 40); assert.equal(view.state.location.lon, -79);
  view.elements.get('place-input').value = 'Pittsburgh, PA, US';
  await view.elements.get('place-input').emit('input');
  await view.locate(new Blob(['no exif']), 0);
  assert.equal(deviceCalls, 1);
  assert.equal(view.state.locationSource, 'geolocation');
  assert.equal(view.elements.get('place-input').value, 'Pittsburgh, PA, US');
  view.state.file = new Blob(['photo']); view.state.screen = 'preview';
  await view.elements.get('generate-button').emit('click');
  assert.equal(view.requests[0].get('place'), 'Pittsburgh, PA, US');
  assert.equal(view.requests[0].get('lat'), '1');
});

test('mismatched-year results stop before applying a manifest', async () => {
  const view = app();
  view.state.jobId = 'wrong-year'; view.state.expectedYear = 1945;
  view.jobs.set('wrong-year', { job_id: 'wrong-year', target_year: 1950, status: 'done' });
  await view.pollManifest(view.state.generation);
  assert.equal(view.state.manifest, null);
  assert.match(view.elements.get('generation-title').textContent, /年份与选择不一致/);
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
