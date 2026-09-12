import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from 'three';
import { createPanoramaMesh, PanoramaLookControls, panoramaHeading, setCameraBearing, cameraBearing } from '../web/world/panorama.js';
import { createOrientationController } from '../web/world/orientation.js';
import { createLiveLocation, positionFix, locationDistance } from '../web/world/location.js';
import { createYearWheel } from '../web/world/year-wheel.js';

const source = readFileSync(new URL('../web/world/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/world/index.html', import.meta.url), 'utf8');
const PLAN = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222222222222222222222222222';
const PROBE = '/world-plans/00000000-0000-0000-0000-000000000000';
const TOKEN = 'private-test-access-token';

class Element {
  constructor(tagName = 'DIV') {
    Object.assign(this, { tagName, children: [], handlers: {}, attributes: {}, dataset: {}, style: {},
      hidden: false, disabled: false, value: '', textContent: '', clientWidth: 800, clientHeight: 400,
      naturalWidth: 2048, naturalHeight: 1024 });
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set innerHTML(_value) { throw new Error('Do not inject untrusted HTML'); }
  addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
  removeEventListener(type, callback) { this.handlers[type] = (this.handlers[type] || []).filter((item) => item !== callback); }
  async emit(type, event = {}) {
    for (const callback of this.handlers[type] || []) await callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = [...elements]; this.textContent = ''; }
  querySelectorAll() { return this.inputs || []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'src') this.src = ''; }
  reportValidity() { return true; }
  async decode() {}
  scrollIntoView(options) { this.scrolls = [...(this.scrolls || []), options]; }
  remove() {}
  click() {}
  setPointerCapture() {}
}

function response(data = {}, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data,
    arrayBuffer: async () => data instanceof ArrayBuffer ? data : new Uint8Array([1, 2, 3]).buffer,
    blob: async () => new Blob([typeof data === 'string' ? data : 'asset'], { type: 'image/png' }) };
}

function plan(overrides = {}) {
  return { plan_id: PLAN, target_year: 1925, modern_buildings: [], historical_buildings: [], changes: [],
    sources: [], uncertainties: [], camera_position: [0, 1.6, 0], assets: {}, ...overrides };
}

function app(options = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  for (const [id, value] of Object.entries({ lat: '', lon: '', year: 1925, radius: 100, 'location-mode': 'device' })) {
    elements.get(id).value = String(value);
  }
  elements.get('plan-form').inputs = ['lat', 'lon', 'year', 'radius', 'gps', 'snapshot', 'test-prepare', 'location-mode', 'geometry-test', 'open-streetview'].map((id) => elements.get(id));
  const tabs = ['source', 'historical', 'modern', 'depth', 'pano', 'world'].map((view) => Object.assign(new Element('BUTTON'), { dataset: { view } }));
  const moves = ['forward', 'back', 'left', 'right'].map((move) => Object.assign(new Element('BUTTON'), { dataset: { move } }));
  const storage = new Map(Object.entries(options.storage || {})), requests = [], timers = new Map(), rewrites = [], gpsOptions = [], popups = [];
  const objects = new Map(), revoked = [], documentEvents = {}, windowEvents = {}, watches = new Map();
  const workspace = new Element('SECTION');
  let timerId = 0, objectId = 0, gpsCalls = 0, watchId = 0;
  class ObjectURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${++objectId}`; objects.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); objects.delete(url); }
  }
  class SplatStub extends THREE.Group {
    constructor(input) { super(); this.input = input; this.initialized = Promise.resolve(this); }
    dispose() { this.disposed = true; }
  }
  const document = {
    body: new Element('BODY'), visibilityState: options.visibility || 'hidden',
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll(selector) { return selector === '[data-view]' ? tabs : selector === '[data-move]' ? moves : []; },
    querySelector(selector) { return selector === '.workspace' ? workspace : null; },
    createElement(tag) { return new Element(tag.toUpperCase()); },
    addEventListener(type, handler) { (documentEvents[type] ||= []).push(handler); },
    removeEventListener(type, handler) { documentEvents[type] = (documentEvents[type] || []).filter((item) => item !== handler); },
  };
  const context = vm.createContext({
    THREE, createPanoramaMesh, PanoramaLookControls, panoramaHeading, setCameraBearing, cameraBearing,
    createOrientationController, createLiveLocation, positionFix, locationDistance, createYearWheel, SplatMesh: SplatStub, SparkRenderer: class {},
    GLTFLoader: class { async parseAsync() { return { scene: options.gltf || new THREE.Group() }; } },
    document, window: { DeviceOrientationEvent: options.orientation,
      setTimeout(callback, milliseconds) { const id = ++timerId; timers.set(id, { callback, milliseconds }); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener(type, handler) { (windowEvents[type] ||= []).push(handler); },
      removeEventListener(type, handler) { windowEvents[type] = (windowEvents[type] || []).filter((item) => item !== handler); }, open(...args) {
      const popup = { args, opener: {}, location: { replace(url) { popup.url = url; } }, close() { popup.closed = true; } };
      popups.push(popup); return options.blockPopups ? null : popup;
    }, isSecureContext: options.secure !== false, devicePixelRatio: 1, matchMedia: () => ({ matches: !!options.mobile }) },
    location: { hash: '', search: '', pathname: '/world', hostname: 'example.test', origin: 'https://example.test', ...options.location },
    history: { replaceState(...args) { rewrites.push(args); } },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    navigator: { userAgent: options.userAgent || '', permissions: options.permissions, clipboard: options.clipboard,
      geolocation: options.noGPS ? undefined : {
      watchPosition(success, failure, settings) { const id = ++watchId; watches.set(id, { success, failure, settings }); return id; },
      clearWatch(id) { watches.delete(id); },
      getCurrentPosition(success, failure, settings) {
      gpsCalls++; gpsOptions.push(settings);
      if (options.gps) return options.gps(success, failure, settings, gpsCalls);
      success({ coords: { latitude: 1, longitude: 2, accuracy: 12 }, timestamp: Date.now() });
    } } },
    Headers, Blob, URL: ObjectURL, URLSearchParams, AbortController, DOMException, Uint8Array,
    setTimeout(callback, milliseconds) { const id = ++timerId; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); }, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      if (options.fetch) {
        const result = await options.fetch(url, init);
        if (result !== undefined) return result;
      }
      if (url === '/world-config') return response({ configured: true, min_year: 1800, max_year: 2026 });
      if (url === '/world-session') return response({ access_token: TOKEN });
      if (url === PROBE) return response({ detail: 'missing' }, 404);
      throw new Error('Unexpected fetch');
    },
  });
  document.defaultView = context.window;
  for (const element of elements.values()) element.ownerDocument = document;
  const hooks = '{state,api,safeAssetURL,safeSourceURL,initialiseAccess,boot,bindEvents,preparePlan,renderPlan,startGeneration,pollJob,applyJob,restoreSaved,showView,semanticsTransform,importEdits,resumeJob,changeReason,refreshLocation,setLocationMode,resolveLocation,openStreetView,toggleMotion,calibrateView,manualLook,generateForYear,moveCamera,startLiveLocation,stopLiveLocation,maybePrepareCurrent}';
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('void boot();', `globalThis.hooks = ${hooks};`), context);
  return { ...context.hooks, elements, tabs, moves, requests, timers, storage, rewrites, objects, revoked,
    gpsCalls: () => gpsCalls, gpsOptions, popups, document, SplatStub, workspace, watches,
    async emitDocument(type) { for (const callback of documentEvents[type] || []) await callback(); },
    async emitWindow(type, event = {}) { for (const callback of [...(windowEvents[type] || [])]) await callback(event); } };
}

function authorised(view) { view.state.token = TOKEN; view.state.config = { configured: true }; }

test('remote fragment access is removed from URL and sent only in protected headers', async () => {
  const view = app({ location: { hash: `#access=${TOKEN}` } });
  await view.initialiseAccess();
  assert.equal(view.state.token, TOKEN);
  assert.equal(view.rewrites[0][2], '/world');
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].url, PROBE);
  assert.equal(view.requests[0].headers.get('Authorization'), `Bearer ${TOKEN}`);
  assert.equal(view.requests[0].redirect, 'error');
  assert.equal(view.storage.get('century.world.access'), TOKEN);
  assert.equal(view.gpsCalls(), 0);
});

test('boot uses loopback session and requests a fresh device position automatically', async () => {
  const view = app({ location: { hostname: 'localhost' } });
  await view.boot();
  assert.deepEqual(view.requests.map((request) => request.url).sort(), ['/world-config', '/world-session']);
  assert.ok(view.requests.every((request) => !request.headers.has('Authorization')));
  assert.equal(view.gpsCalls(), 1);
  assert.equal(view.elements.get('lat').readOnly, true);
  assert.equal(view.elements.get('test-controls').hidden, true);
  await view.elements.get('gps').emit('click');
  assert.equal(view.gpsCalls(), 2);
  assert.equal(view.gpsOptions[0].maximumAge, 0);
  assert.equal(view.gpsOptions[0].enableHighAccuracy, true);
  assert.equal(view.elements.get('lat').value, '1.000000');
});

test('external asset and source URLs cannot receive a service token', async () => {
  const view = app(); authorised(view);
  assert.throws(() => view.safeAssetURL('https://evil.example/world-jobs/a/assets/scene.spz'));
  assert.throws(() => view.safeAssetURL(`/world-jobs/${JOB}/assets/../../secret`));
  assert.throws(() => view.safeAssetURL(`/world-jobs/${JOB}/assets/scene.spz?access=${TOKEN}`));
  await assert.rejects(view.api('https://evil.example'), /地址/);
  assert.equal(view.requests.length, 0);
  assert.equal(view.safeSourceURL('javascript:alert(1)'), null);
  assert.equal(view.safeSourceURL('https://user:pass@example.com'), null);
  assert.equal(view.safeSourceURL('https://www.cmu.edu/history'), 'https://www.cmu.edu/history');
});

test('OSM failure exits loading without silently switching to a snapshot', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response({ detail: '地图来源不可用。' }, 422) : undefined });
  authorised(view); await view.setLocationMode('test');
  view.elements.get('lat').value = '40.44'; view.elements.get('lon').value = '-79.94';
  await view.preparePlan('osm');
  assert.equal(view.requests.length, 1);
  assert.equal(JSON.parse(view.requests[0].body).source, 'osm');
  assert.equal(view.state.planBusy, false);
  assert.equal(view.elements.get('test-prepare').disabled, false);
  assert.match(view.elements.get('message').textContent, /地图来源/);
});

test('explicit CMU snapshot retains chosen year and never starts paid generation', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response(plan({ target_year: 1946 })) : undefined });
  authorised(view); await view.setLocationMode('test'); view.elements.get('lat').value = '1'; view.elements.get('year').value = '1946';
  await view.preparePlan('cmu_snapshot');
  const payload = JSON.parse(view.requests[0].body);
  assert.deepEqual(payload, { lat: 40.4433, lon: -79.9436, year: 1946, radius_m: 100, heading_deg: 0, source: 'cmu_snapshot', location_source: 'test' });
  assert.equal(view.requests.length, 1);
  assert.equal(view.state.plan.plan_id, PLAN);
});

test('generation submits once, polls GET every five seconds, and stops on ready', async () => {
  let reads = 0;
  const view = app({ fetch: (url, init) => {
    if (url === '/world-jobs' && init.method === 'POST') return response({ job_id: JOB, stage: 'queued', assets: [] });
    if (url === `/world-jobs/${JOB}`) return response({ job_id: JOB, stage: ++reads === 1 ? 'generating_world' : 'ready', assets: [] });
  } });
  authorised(view); view.state.plan = plan();
  await view.startGeneration();
  await view.startGeneration();
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(view.requests[0].body), { plan_id: PLAN, model: 'marble-1.1' });
  assert.equal([...view.timers.values()][0].milliseconds, 5000);
  await view.pollJob(view.state.jobEpoch); await view.pollJob(view.state.jobEpoch);
  assert.equal(view.requests.filter((request) => request.method === 'GET').length, 2);
  assert.equal(view.state.job.stage, 'ready');
  assert.equal(view.timers.size, 0);
});

test('standard is the default and choosing Draft changes the visible cost and submitted model', async () => {
  const view = app({ fetch: (url) => url === '/world-jobs'
    ? response({ job_id: JOB, stage: 'queued', model: 'marble-1.0-draft', assets: [] }) : undefined });
  authorised(view); view.bindEvents(); view.renderPlan(plan());
  assert.equal(view.elements.get('world-model').value, 'marble-1.1');
  assert.match(view.elements.get('generation-quality').textContent, /1,500 credits/);
  const select = view.elements.get('world-model'); select.value = 'marble-1.0-draft';
  await select.emit('change');
  assert.match(view.elements.get('generation-quality').textContent, /150 credits/);
  await view.startGeneration();
  assert.equal(JSON.parse(view.requests[0].body).model, 'marble-1.0-draft');
  assert.equal(select.disabled, true);
  assert.match(view.elements.get('job-quality').textContent, /快速草稿/);
});

test('saved Draft and reduced SPZ keep their actual quality labels without triggering an upgrade', () => {
  const view = app(); authorised(view); view.renderPlan(plan());
  view.applyJob({ job_id: JOB, stage: 'ready', model: 'marble-1.0-draft',
    assets: [{ kind: 'spz', filename: 'scene.spz', lod: '100k', validation: { num_points: 100000 } }] });
  assert.match(view.elements.get('job-quality').textContent, /快速草稿.*精简精度 100k.*100,000 点/);
  assert.doesNotMatch(view.elements.get('job-quality').textContent, /标准质量|完整精度/);
  assert.equal(view.elements.get('world-model').value, 'marble-1.0-draft');
  assert.equal(view.elements.get('world-model').disabled, true);
  assert.equal(view.requests.length, 0);
  view.applyJob({ job_id: JOB, stage: 'ready', model: 'marble-1.1',
    assets: [{ kind: 'spz', filename: 'scene.spz', lod: 'full_res', validation: { num_points: 2000000 } }] });
  assert.match(view.elements.get('job-quality').textContent, /标准质量.*完整精度.*2,000,000 点/);
  assert.equal(view.requests.length, 0);
  view.applyJob({ job_id: JOB, stage: 'ready', assets: [{ kind: 'spz', filename: 'scene.spz' }] });
  assert.match(view.elements.get('job-quality').textContent, /模型未记录.*资源精度未记录/);
  assert.doesNotMatch(view.elements.get('generation-quality').textContent, /标准质量/);
});

test('lost generation submission response is persisted and never retried automatically', async () => {
  const view = app({ fetch: () => { throw new Error('network'); } });
  authorised(view); view.state.plan = plan();
  await view.startGeneration(); await view.startGeneration();
  assert.equal(view.requests.length, 1);
  assert.equal(view.state.submissionUnknown, true);
  assert.equal(view.elements.get('generate').disabled, true);
  assert.equal(JSON.parse(view.storage.get('century.world.resume')).submission_unknown, true);
});

test('refresh restores the original job and plan through GET only', async () => {
  const view = app({ storage: { 'century.world.resume': JSON.stringify({ job_id: JOB, plan_id: PLAN }) }, fetch: (url) => {
    if (url === `/world-jobs/${JOB}`) return response({ job_id: JOB, plan_id: PLAN, stage: 'generating_depth', assets: [] });
    if (url === `/world-plans/${PLAN}`) return response(plan());
  } });
  authorised(view); await view.restoreSaved();
  assert.equal(view.state.job.job_id, JOB);
  assert.equal(view.state.plan.plan_id, PLAN);
  assert.ok(view.requests.every((request) => request.method === 'GET'));
  assert.equal(view.requests.length, 2);
  assert.equal(view.state.restoring, false);
});

test('world query link overrides another saved task and loads its actual SPZ using GET only', async () => {
  const previous = '99999999999999999999999999999999';
  const view = app({ visibility: 'visible', location: { search: `?world=${JOB}` },
    storage: { 'century.world.resume': JSON.stringify({ job_id: previous, plan_id: PLAN }) }, fetch: (url) => {
      if (url === `/world-jobs/${JOB}`) return response({ job_id: JOB, plan_id: PLAN, stage: 'ready',
        assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] });
      if (url === `/world-plans/${PLAN}`) return response(plan());
      if (url === `/world-jobs/${JOB}/assets/scene.spz`) return response();
    } });
  authorised(view); view.state.engine = fakeEngine();
  await view.restoreSaved();
  await new Promise(setImmediate);
  assert.deepEqual(view.requests.map((request) => request.url), [
    `/world-jobs/${JOB}`, `/world-plans/${PLAN}`, `/world-jobs/${JOB}/assets/scene.spz`,
  ]);
  assert.ok(view.requests.every((request) => request.method === 'GET'));
  assert.equal(view.state.view, 'world');
  assert.ok(view.state.engine.current.children[0] instanceof view.SplatStub);
  assert.equal(view.rewrites.at(-1)[2], `/world?world=${JOB}`);
  assert.equal(view.rewrites.some((entry) => entry[2].includes(TOKEN)), false);
  assert.equal(JSON.parse(view.storage.get('century.world.resume')).job_id, JOB);
});

test('malformed world query does not load an unrelated saved task', async () => {
  const view = app({ location: { search: '?world=not-a-job' },
    storage: { 'century.world.resume': JSON.stringify({ job_id: JOB, plan_id: PLAN }) } });
  authorised(view); await view.restoreSaved();
  assert.equal(view.requests.length, 0);
  assert.match(view.elements.get('message').textContent, /链接无效/);
});

test('later selected preview wins over an earlier slow asset response', async () => {
  let release;
  const view = app({ visibility: 'visible', fetch: (url) => {
    if (url.endsWith('/depth.png')) return new Promise((resolve) => { release = () => resolve(response('old depth')); });
    if (url.endsWith('/historical_panorama.jpg')) return response('new panorama');
  } });
  authorised(view); view.state.engine = fakeEngine();
  view.state.plan = plan({ assets: { 'depth.png': `/world-plans/${PLAN}/assets/depth.png` } });
  view.state.job = { assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  const old = view.showView('depth');
  await view.showView('pano'); release(); await old;
  assert.equal(view.state.view, 'pano');
  assert.match(view.elements.get('view-caption').textContent, /历史想象全景/);
  assert.equal(view.objects.size, 1);
  assert.equal(await [...view.objects.values()][0].text(), 'new panorama');
});

function fakeEngine() {
  return { renderer: { domElement: new Element('CANVAS') }, scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), update() {} },
    helpers: new THREE.Group(), current: null, home: null };
}

test('SPZ receives real bytes and metric transform precedes the X180 axis conversion', async () => {
  const bytes = new Uint8Array([31, 139, 7, 8]).buffer;
  const view = app({ fetch: () => response(bytes) });
  authorised(view); view.state.engine = fakeEngine();
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz`,
    semantics_metadata: { metric_scale_factor: 2, ground_plane_offset: 0.42 } }] };
  await view.showView('world');
  const parent = view.state.engine.current, splat = parent.children[0];
  assert.ok(splat instanceof view.SplatStub);
  assert.equal(splat.input.fileType, 'spz');
  assert.deepEqual([...splat.input.fileBytes], [31, 139, 7, 8]);
  parent.updateMatrixWorld(true);
  const transformed = new THREE.Vector3(2, 3, 4).applyMatrix4(splat.matrixWorld);
  assert.ok(transformed.distanceTo(new THREE.Vector3(4, -5.58, -8)) < 1e-10);
  assert.equal(view.state.engine.metric, true);
  assert.match(view.elements.get('view-details').textContent, /未核实/);
});

test('missing or partial scale metadata keeps model units and does not guess ground', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz`,
    semantics_metadata: { metric_scale_factor: 2 } }] };
  await view.showView('world');
  const splat = view.state.engine.current.children[0];
  assert.equal(splat.scale.x, 1); assert.equal(Math.abs(splat.position.y), 0);
  assert.equal(view.state.engine.metric, false);
  assert.match(view.elements.get('view-details').textContent, /模型单位/);
});

test('failed historical review stays explicit while genuine SPZ assets remain viewable', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  const job = { job_id: JOB, stage: 'ready', review: { status: 'rejected', scope: 'historical_appearance',
    notes: ['出现现代双黄线与大型广告，与 1925 年地点不符。'] },
    validation: { historical_accuracy: 'failed_visual_review' },
    assets: [{ kind: 'spz', filename: 'scene.spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  view.applyJob(job);
  assert.match(view.elements.get('job-stage').textContent, /历史外观未通过检查/);
  assert.match(view.elements.get('job-detail').textContent, /现代双黄线/);
  assert.equal(view.tabs.find((tab) => tab.dataset.view === 'world').disabled, false);
  await view.showView('world');
  assert.ok(view.state.engine.current.children[0] instanceof view.SplatStub);
  assert.match(view.elements.get('view-caption').textContent, /历史外观未通过检查/);
  assert.match(view.elements.get('view-details').textContent, /现代双黄线/);
  view.applyJob(job);
  assert.equal(view.elements.get('viewer-note').textContent.match(/历史外观未通过检查/g).length, 1);
});

test('coarse overview fits buildings instead of the enormous GLB ground plane', async () => {
  const object = new THREE.Group();
  const building = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial());
  building.position.set(0, 5, -20); object.add(building);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), new THREE.MeshBasicMaterial());
  ground.name = 'Ground'; ground.rotation.x = -Math.PI / 2; object.add(ground);
  const view = app({ gltf: object, fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  view.state.plan = plan({ assets: { 'historical.glb': `/world-plans/${PLAN}/assets/historical.glb` } });
  await view.showView('historical');
  assert.ok(view.state.engine.camera.position.length() < 60);
  assert.ok(view.state.engine.controls.target.distanceTo(new THREE.Vector3(0, 5, -20)) < 1e-10);
});

test('before and after models share the same frame even when most buildings are removed', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  const retained = { footprint: [[-5, -30], [5, -30], [5, -20], [-5, -20]], height_m: 10 };
  const removed = { footprint: [[70, 50], [80, 50], [80, 70], [70, 70]], height_m: 40 };
  view.state.plan = plan({ modern_buildings: [retained, removed], historical_buildings: [retained],
    assets: { 'modern.glb': `/world-plans/${PLAN}/assets/modern.glb`, 'historical.glb': `/world-plans/${PLAN}/assets/historical.glb` } });
  await view.showView('modern');
  const position = view.state.engine.camera.position.clone(), target = view.state.engine.controls.target.clone();
  await view.showView('historical');
  assert.ok(view.state.engine.camera.position.equals(position));
  assert.ok(view.state.engine.controls.target.equals(target));
  assert.ok(target.x > 30 && target.y === 20);
});

test('mobile prepare reveals the preview but refresh restoration does not force scrolling', async () => {
  const view = app({ mobile: true, fetch: (url) => {
    if (url === '/world-plans' || url === `/world-plans/${PLAN}`) return response(plan());
  } });
  authorised(view); await view.setLocationMode('test'); await view.preparePlan('cmu_snapshot');
  assert.equal(view.workspace.scrolls.length, 1);
  await view.restoreSaved();
  assert.equal(view.workspace.scrolls.length, 1);
});

test('plan evidence is text-only and unknown geometry never claims verified history', () => {
  const view = app();
  view.renderPlan(plan({ modern_buildings: [{ id: 'a', label: '<img onerror=attack()>' }],
    historical_buildings: [{ id: 'a' }], changes: [{ building_id: 'a', action: 'unknown', reason: '<script>attack()</script>' }],
    sources: [{ title: 'Unsafe link', url: 'javascript:attack()' }, { title: '<b>CMU</b>', url: 'https://www.cmu.edu/' }],
    uncertainties: ['Unverified modern footprint'] }));
  const entry = view.elements.get('changes').children[0];
  assert.equal(entry.children[0].textContent, '年代未核实');
  assert.equal(entry.children[1].textContent, '<img onerror=attack()>');
  assert.equal(view.elements.get('sources').children[0].tagName, 'P');
  assert.equal(view.elements.get('sources').children[1].rel, 'noopener noreferrer');
});

test('only recognised planning reasons are translated; user explanations remain verbatim', () => {
  const view = app();
  const official = 'Official CMU completion/opening evidence postdates 1925. Remove the completed modern building; earlier structures and construction-stage geometry remain unknown.';
  assert.match(view.changeReason({ reason: official }), /1925 年后/);
  assert.match(view.changeReason({ reason: 'No bound archival date or target-year footprint. Retained only as an unverified modern massing placeholder.' }), /未核实/);
  const custom = 'My archive says the old shop stood here until 1926.';
  assert.equal(view.changeReason({ reason: custom }), custom);
  assert.equal(view.changeReason({ reason: official, origin: 'user_edit' }), official);
});

test('geometry edits create a new plan without triggering paid generation', async () => {
  const nextPlan = '33333333-3333-3333-3333-333333333333';
  const view = app({ fetch: (url) => url.endsWith('/edits') ? response(plan({ plan_id: nextPlan })) : undefined });
  authorised(view); view.state.plan = plan();
  const edits = { edits: [{ building_id: 'old', action: 'remove', reason: 'Documented date', source_url: 'https://www.cmu.edu/', source_title: 'Record' }] };
  await view.importEdits(new Blob([JSON.stringify(edits)]));
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].url, `/world-plans/${PLAN}/edits`);
  assert.equal(view.state.plan.plan_id, nextPlan);
  assert.equal(view.state.job, null);
  assert.equal(view.state.planBusy, false);
});

test('resuming is an explicit POST for the saved job and then GET polling', async () => {
  const view = app({ fetch: (url) => url.endsWith('/resume') ? response({ job_id: JOB, stage: 'generating_world', assets: [] }) : undefined });
  authorised(view); view.state.job = { job_id: JOB, stage: 'paused', can_resume: true, assets: [] };
  view.applyJob(view.state.job);
  assert.equal(view.requests.length, 0);
  await view.resumeJob();
  assert.equal(view.requests[0].url, `/world-jobs/${JOB}/resume`);
  assert.equal(view.requests[0].method, 'POST');
  assert.equal(view.state.resumeBusy, false);
  assert.equal([...view.timers.values()][0].milliseconds, 5000);
});


test('preparing the live plan reacquires position instead of reusing the displayed fix', async () => {
  const timestamp = Date.now();
  const view = app({ gps: (success, _failure, _settings, call) => success({
    coords: { latitude: 40 + call / 10, longitude: -79 - call / 10, accuracy: 7 }, timestamp }),
    fetch: (url) => url === '/world-plans' ? response(plan()) : undefined });
  authorised(view);
  await view.refreshLocation();
  assert.equal(view.elements.get('lat').value, '40.100000');
  await view.preparePlan();
  assert.equal(view.gpsCalls(), 2);
  const payload = JSON.parse(view.requests[0].body);
  assert.equal(payload.lat, 40.2);
  assert.equal(payload.lon, -79.2);
  assert.equal(payload.location_source, 'device');
  assert.equal(payload.location_timestamp_ms, timestamp);
  assert.equal(payload.location_accuracy_m, 7);
});

test('GPS denial blocks live preparation and does not fall back to old or CMU coordinates', async () => {
  const view = app({ gps: (_success, failure) => failure({ code: 1 }) });
  authorised(view);
  view.elements.get('lat').value = '40.4433'; view.elements.get('lon').value = '-79.9436';
  await view.preparePlan();
  assert.equal(view.requests.length, 0);
  assert.equal(view.elements.get('lat').value, '');
  assert.equal(view.elements.get('lon').value, '');
  assert.equal(view.state.locationFix, null);
  assert.match(view.elements.get('location-status').textContent, /权限被拒绝/);
  assert.equal(view.state.planBusy, false);
  await view.preparePlan('cmu_snapshot');
  assert.equal(view.requests.length, 0);
  assert.equal(view.state.locationMode, 'device');
});

test('iPhone denial shows both permission settings and explicit retry recovers fresh GPS', async () => {
  let allowed = false;
  const view = app({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1',
    gps: (success, failure) => allowed
      ? success({ coords: { latitude: 40.44, longitude: -79.94, accuracy: 5 }, timestamp: Date.now() })
      : failure({ code: 1 }),
  });
  view.bindEvents();
  await assert.rejects(view.refreshLocation(), /权限被拒绝/);
  assert.equal(view.elements.get('location-help').hidden, false);
  const instructions = view.elements.get('location-help-steps').children.map((element) => element.textContent).join(' ');
  assert.match(instructions, /网站设置/);
  assert.match(instructions, /隐私与安全性/);
  assert.match(instructions, /精确位置/);
  assert.equal(view.state.locationFix, null);
  allowed = true;
  await view.elements.get('retry-location').emit('click');
  await new Promise(setImmediate);
  assert.equal(view.gpsCalls(), 2);
  assert.equal(view.state.locationFix.lat, 40.44);
  assert.equal(view.elements.get('location-help').hidden, true);
  assert.equal(view.requests.length, 0);
});

test('pending Permissions query cannot delay the user-initiated GPS request', async () => {
  const view = app({ permissions: { query: () => new Promise(() => {}) } });
  const request = view.refreshLocation();
  assert.equal(view.gpsCalls(), 1);
  await request;
  assert.equal(view.state.locationFix.lat, 1);
});

test('stale denied Permissions state cannot block successful explicit GPS retry', async () => {
  const view = app({ permissions: { query: async () => ({ state: 'denied', addEventListener() {} }) } });
  await view.refreshLocation();
  await new Promise(setImmediate);
  await view.refreshLocation();
  assert.equal(view.gpsCalls(), 2);
  assert.equal(view.state.locationFix.lat, 1);
  assert.equal(view.state.locationError, '');
});

test('granting permission in a visible page reacquires GPS without starting generation', async () => {
  const callbacks = [];
  const permission = { state: 'denied', addEventListener(type, callback) { if (type === 'change') callbacks.push(callback); } };
  const view = app({ visibility: 'visible', permissions: { query: async () => permission },
    gps: (success, failure) => permission.state === 'granted'
      ? success({ coords: { latitude: 40.44, longitude: -79.94, accuracy: 5 }, timestamp: Date.now() })
      : failure({ code: 1 }) });
  view.bindEvents();
  await assert.rejects(view.refreshLocation());
  await new Promise(setImmediate);
  assert.ok(callbacks.length > 0);
  permission.state = 'granted';
  for (const callback of callbacks) callback();
  await new Promise(setImmediate);
  assert.equal(view.gpsCalls(), 2);
  assert.equal(view.state.locationFix.lat, 40.44);
  assert.equal(view.requests.length, 0);
});

test('permission changes while hidden do not request the device position', async () => {
  const callbacks = [];
  const permission = { state: 'denied', addEventListener(type, callback) { if (type === 'change') callbacks.push(callback); } };
  const view = app({ visibility: 'hidden', permissions: { query: async () => permission },
    gps: (_success, failure) => failure({ code: 1 }) });
  view.bindEvents();
  await assert.rejects(view.refreshLocation());
  await new Promise(setImmediate);
  permission.state = 'granted';
  for (const callback of callbacks) callback();
  await new Promise(setImmediate);
  assert.equal(view.gpsCalls(), 1);
  assert.equal(view.requests.length, 0);
});

test('returning from Settings notices a granted permission even without a change event', async () => {
  const permission = { state: 'denied', addEventListener() {} };
  const view = app({ visibility: 'visible', permissions: { query: async () => permission },
    gps: (success, failure) => permission.state === 'granted'
      ? success({ coords: { latitude: 40.44, longitude: -79.94, accuracy: 5 }, timestamp: Date.now() })
      : failure({ code: 1 }) });
  view.bindEvents();
  await assert.rejects(view.refreshLocation());
  await new Promise(setImmediate);
  permission.state = 'granted';
  await view.emitWindow('focus');
  await new Promise(setImmediate);
  assert.equal(view.gpsCalls(), 2);
  assert.equal(view.state.locationFix.lat, 40.44);
  assert.equal(view.requests.length, 0);
});

test('copying the demo link happens only on click and keeps the access code out of DOM', async () => {
  const copies = [];
  const view = app({ clipboard: { writeText: async (value) => copies.push(value) },
    location: { search: `?world=${JOB}&unused=value` }, gps: (_success, failure) => failure({ code: 1 }) });
  authorised(view); view.bindEvents();
  await assert.rejects(view.refreshLocation());
  assert.equal(copies.length, 0);
  await view.elements.get('copy-location-link').emit('click');
  assert.equal(copies.length, 1);
  const copied = new URL(copies[0]);
  assert.equal(copied.origin, 'https://example.test');
  assert.equal(copied.search, `?world=${JOB}`);
  assert.equal(new URLSearchParams(copied.hash.slice(1)).get('access'), TOKEN);
  assert.ok([...view.elements.values()].every((element) => !element.textContent.includes(TOKEN)));
  assert.equal(view.requests.length, 0);
});

test('a fresh request rejects stale coordinates even when the browser supplies them', async () => {
  const view = app({ gps: (success) => success({
    coords: { latitude: 40.4433, longitude: -79.9436, accuracy: 12 }, timestamp: Date.now() - 120000 }) });
  authorised(view); await view.preparePlan();
  assert.equal(view.requests.length, 0);
  assert.match(view.elements.get('location-status').textContent, /过期/);
  assert.equal(view.state.locationFix, null);
});

test('insecure context and unsupported GPS block live requests with actionable location errors', async () => {
  for (const options of [{ secure: false }, { noGPS: true }]) {
    const view = app(options); authorised(view); await view.preparePlan();
    assert.equal(view.requests.length, 0);
    assert.equal(view.gpsCalls(), 0);
    assert.match(view.elements.get('location-status').textContent, /HTTPS|不支持定位/);
  }
});

test('explicit manual test mode sends test provenance and never calls GPS', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response(plan()) : undefined });
  authorised(view); await view.setLocationMode('test');
  view.elements.get('lat').value = '40.442'; view.elements.get('lon').value = '-79.946';
  await view.preparePlan();
  assert.equal(view.gpsCalls(), 0);
  assert.equal(view.elements.get('lat').readOnly, false);
  assert.equal(view.elements.get('test-controls').hidden, false);
  assert.match(view.elements.get('location-status').textContent, /测试模式/);
  const payload = JSON.parse(view.requests[0].body);
  assert.equal(payload.location_source, 'test');
  assert.equal(payload.lat, 40.442);
  assert.equal(payload.location_timestamp_ms, undefined);
  await view.setLocationMode('device');
  assert.equal(view.gpsCalls(), 1);
  assert.equal(view.elements.get('lat').value, '1.000000');
  assert.equal(view.elements.get('lat').readOnly, true);
});

test('replaying an old world leaves current GPS and year inputs independent', async () => {
  const view = app({ location: { search: `?world=${JOB}` }, fetch: (url) => {
    if (url === `/world-jobs/${JOB}`) return response({ job_id: JOB, plan_id: PLAN, stage: 'ready', assets: [] });
    if (url === `/world-plans/${PLAN}`) return response(plan({ target_year: 1900,
      location: { lat: 40.4433, lon: -79.9436, radius_m: 50, location_source: 'test' } }));
  } });
  authorised(view); await view.refreshLocation();
  view.elements.get('year').value = '1925';
  await view.restoreSaved();
  assert.equal(view.elements.get('lat').value, '1.000000');
  assert.equal(view.elements.get('lon').value, '2.000000');
  assert.equal(view.elements.get('year').value, '1925');
  assert.equal(view.elements.get('radius').value, '100');
  assert.equal(view.state.locationMode, 'device');
  assert.match(view.elements.get('plan-location').textContent, /已保存.*40.443300.*1900 年.*测试点位.*独立/);
  assert.ok(view.requests.every((request) => request.method === 'GET'));
});

test('switching to test mode discards a late pending GPS success', async () => {
  let deliver;
  const view = app({ gps: (success) => { deliver = success; } });
  const pending = view.refreshLocation();
  await view.setLocationMode('test');
  view.elements.get('lat').value = '40'; view.elements.get('lon').value = '-79';
  deliver({ coords: { latitude: 10, longitude: 20, accuracy: 2 }, timestamp: Date.now() });
  await assert.rejects(pending, /模式已切换/);
  assert.equal(view.state.locationMode, 'test');
  assert.equal(view.elements.get('lat').value, '40');
  assert.equal(view.state.locationFix, null);
  assert.equal(view.state.locationBusy, false);
});


test('live preparation requests Google street-view photographs and does not fall back to OSM', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response({ detail: '街景服务未配置。' }, 503) : undefined });
  authorised(view); await view.preparePlan();
  assert.equal(view.requests.length, 1);
  const payload = JSON.parse(view.requests[0].body);
  assert.equal(payload.source, 'google_streetview');
  assert.equal(payload.location_source, 'device');
  assert.match(view.elements.get('message').textContent, /未配置/);
  await view.preparePlan('osm');
  assert.equal(view.requests.length, 1);
});

test('source-photo plan shows the genuine private panorama and hides geometry tools', async () => {
  const view = app({ fetch: (url) => {
    if (url === '/world-plans') return response(plan({ input_kind: 'streetview_panorama',
      source_panorama: { metadata: { date: '2024-06', copyright: '© Google' } },
      assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } }));
    if (url.endsWith('/source_panorama.jpg')) return response('source photograph');
  } });
  authorised(view); view.state.engine = fakeEngine(); await view.preparePlan();
  assert.equal(view.state.view, 'source');
  assert.equal(view.elements.get('geometry-stats').hidden, true);
  assert.equal(view.elements.get('geometry-edits').hidden, true);
  assert.ok(view.tabs.filter((tab) => ['historical', 'modern', 'depth'].includes(tab.dataset.view)).every((tab) => tab.hidden));
  assert.match(view.elements.get('view-caption').textContent, /当前街景/);
  assert.match(view.elements.get('view-details').textContent, /2024-06.*照片/);
  assert.equal(await [...view.objects.values()][0].text(), 'source photograph');
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 1);
});

test('official Street View link uses a fresh fix and never includes a key or service token', async () => {
  const view = app(); authorised(view);
  await view.openStreetView();
  assert.equal(view.gpsCalls(), 1);
  assert.equal(view.requests.length, 0);
  assert.equal(view.popups.length, 1);
  assert.equal(view.popups[0].opener, null);
  const url = new URL(view.popups[0].url);
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.searchParams.get('viewpoint'), '1,2');
  assert.equal(url.searchParams.get('map_action'), 'pano');
  assert.equal(url.searchParams.has('key'), false);
  assert.equal(url.href.includes(TOKEN), false);
});

test('denied location closes the pending official Street View tab without a test-location fallback', async () => {
  const view = app({ gps: (_success, failure) => failure({ code: 1 }) });
  await view.openStreetView();
  assert.equal(view.popups[0].closed, true);
  assert.equal(view.popups[0].url, undefined);
  assert.match(view.elements.get('location-status').textContent, /权限被拒绝/);
});

test('photo generation separates image-edit charges from World Labs credits', () => {
  const view = app(); authorised(view); view.state.plan = plan({ input_kind: 'streetview_panorama' });
  view.applyJob({ job_id: JOB, stage: 'ready', generation_calls: { image_edit: 1, world: 1 },
    cost_credits: { depth: null, world: 150, total: 150 }, assets: [] });
  assert.match(view.elements.get('cost').textContent, /OpenAI 图片改写另行计费.*世界：150 credits.*总计：150 credits/);
});

test('fresh location automatically prepares the source scene once without starting AI generation', async () => {
  const view = app({ visibility: 'visible', location: { hostname: 'localhost' }, fetch: (url) => {
    if (url === '/world-config') return response({ configured: true, model: 'marble-1.1', streetview: { available: true } });
    if (url === '/world-plans') return response(plan({ input_kind: 'streetview_panorama',
      source_panorama: { metadata: { heading: 264 } },
      assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } }));
    if (url.endsWith('/source_panorama.jpg')) return response('current source');
  } });
  view.state.engine = fakeEngine(); await view.boot();
  assert.equal(view.gpsCalls(), 1);
  assert.deepEqual(view.requests.filter((request) => request.method === 'POST').map((request) => request.url), ['/world-plans']);
  assert.equal(view.state.view, 'source');
  assert.equal(view.state.engine.current.userData.kind, 'panorama');
  assert.equal(view.elements.get('flat-preview').hidden, true);
  assert.equal(view.elements.get('generate').hidden, false);
  assert.equal(view.watches.size, 1);
});

test('source and historical panorama share the viewing direction and forbid simulated translation', async () => {
  const view = app({ fetch: () => response('pano') }); authorised(view); view.state.engine = fakeEngine();
  view.state.plan = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 264 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  view.state.job = { assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  await view.showView('source');
  assert.ok(Math.abs(cameraBearing(view.state.engine.camera).heading - 264) < 1e-7);
  setCameraBearing(view.state.engine.camera, 359, 22);
  const direction = view.state.engine.camera.quaternion.clone();
  await view.showView('pano');
  assert.ok(view.state.engine.camera.quaternion.angleTo(direction) < 1e-7);
  assert.equal(view.elements.get('move-pad').hidden, true);
  view.state.keys.add('forward'); view.moveCamera(view.state.engine, 1);
  assert.equal(view.state.engine.camera.position.length(), 0);
  await view.showView('source');
  assert.ok(view.state.engine.camera.quaternion.angleTo(direction) < 1e-7);
});

test('sensor permission is user initiated; GPS course stays separate and calibration survives pano switching', async () => {
  let permissions = 0;
  const view = app({ visibility: 'visible', orientation: { requestPermission() { permissions++; return Promise.resolve('granted'); } },
    fetch: () => response('pano') });
  authorised(view); view.state.engine = fakeEngine();
  view.state.plan = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 264 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  view.state.job = { assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` },
    { kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  await view.showView('source');
  assert.equal(permissions, 0); view.toggleMotion(); assert.equal(permissions, 1);
  await Promise.resolve(); await Promise.resolve();
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().phase, 'tracking');
  const before = view.state.orientation.getQuaternion().clone();
  assert.equal(view.watches.size, 1);
  const watch = [...view.watches.values()][0];
  watch.success({ coords: { heading: 90, speed: 1.4, accuracy: 8 }, timestamp: Date.now() });
  assert.match(view.elements.get('heading-readout').textContent, /镜头约 0°.*行进 90°/);
  assert.ok(view.state.orientation.getQuaternion().angleTo(before) < 1e-7);
  watch.success({ coords: { heading: 90, speed: 0, accuracy: 8 }, timestamp: Date.now() });
  assert.doesNotMatch(view.elements.get('heading-readout').textContent, /行进/);
  view.manualLook(); setCameraBearing(view.state.engine.camera, 123); view.calibrateView();
  assert.equal(view.state.calibrating, false);
  assert.equal(view.state.orientation.getStatus().mode, 'calibrated');
  await view.showView('pano');
  assert.equal(view.state.orientation.getStatus().mode, 'calibrated');
  await view.showView('world');
  assert.equal(view.state.orientation.getStatus().enabled, false);
  assert.equal(view.watches.size, 0);
  view.toggleMotion(); await Promise.resolve(); await Promise.resolve();
  assert.equal(view.state.orientation.getStatus().relativeOnly, true);
  view.document.visibilityState = 'hidden'; await view.emitDocument('visibilitychange');
  assert.equal(view.state.orientation.getStatus().enabled, false);
  assert.equal(view.watches.size, 0);
});

test('changing the prominent year prepares that year before its single world submission', async () => {
  const view = app({ fetch: (url) => {
    if (url === '/world-plans') return response(plan({ target_year: 1945, input_kind: 'streetview_panorama' }));
    if (url === '/world-jobs') return response({ job_id: JOB, stage: 'queued', model: 'marble-1.1', assets: [] });
  } });
  authorised(view); view.state.plan = plan(); view.elements.get('year').value = '1945';
  await view.generateForYear();
  const posts = view.requests.filter((request) => request.method === 'POST');
  assert.deepEqual(posts.map((request) => request.url), ['/world-plans', '/world-jobs']);
  assert.equal(JSON.parse(posts[0].body).year, 1945);
  assert.equal(view.state.plan.target_year, 1945);
});

async function followingPanorama(options = {}) {
  const view = app({ visibility: 'visible', orientation: { requestPermission: () => Promise.resolve('granted') },
    fetch: () => response('pano'), ...options });
  authorised(view); view.bindEvents(); view.state.engine = fakeEngine();
  view.state.plan = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 0 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  await view.showView('source'); view.toggleMotion();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.watches.size, 1);
  return view;
}

test('back-forward cache preserves panorama rendering and allows an explicit sensor restart', async () => {
  let permissions = 0, stoppedRender = 0, disconnected = 0, disposedLook = 0;
  const view = await followingPanorama({ orientation: { requestPermission() { permissions++; return Promise.resolve('granted'); } } });
  const engine = view.state.engine, orientation = view.state.orientation, image = view.state.imageURL;
  engine.renderer.setAnimationLoop = () => { stoppedRender++; };
  engine.observer = { disconnect() { disconnected++; } };
  engine.look = { pointers: new Map(), dispose() { disposedLook++; } };
  view.state.job = { job_id: JOB, stage: 'generating_world', assets: [] };
  const oldEpoch = view.state.jobEpoch;
  await view.emitWindow('pagehide', { persisted: true });
  assert.equal(view.state.orientation.getStatus().enabled, false);
  assert.equal(view.watches.size, 0);
  assert.equal(view.objects.has(image), true);
  assert.equal(stoppedRender + disconnected + disposedLook, 0);
  assert.ok(view.state.jobEpoch > oldEpoch);
  await view.emitWindow('pageshow', { persisted: true });
  assert.equal(view.state.engine, engine); assert.equal(view.state.orientation, orientation);
  assert.equal(permissions, 1); assert.equal(view.watches.size, 1); // Live GPS resumes without sensor permission.
  assert.ok([...view.timers.values()].some((timer) => timer.milliseconds === 5000));
  view.toggleMotion(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  assert.equal(permissions, 2); assert.equal(view.state.orientation.getStatus().phase, 'tracking');
  assert.equal(view.watches.size, 2);
  view.state.orientation.stop();
});

test('a failed panorama switch stops sensors and the location watch', async () => {
  const view = await followingPanorama({ fetch: (url) => url.endsWith('historical_panorama.jpg')
    ? response({ detail: '图片不可用' }, 422) : response('source') });
  view.state.job = { assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  await view.showView('pano');
  assert.equal(view.state.engine.current, null);
  assert.equal(view.state.orientation.getStatus().enabled, false);
  assert.equal(view.watches.size, 0);
  assert.equal(view.state.travel, null);
  assert.equal(view.elements.get('motion-toggle').disabled, true);
});

test('queued location-watch callbacks cannot restore stopped travel or overwrite a new session', async () => {
  const view = await followingPanorama();
  const oldWatch = [...view.watches.values()][0];
  const fix = (heading) => ({ coords: { heading, speed: 1.2, accuracy: 5 }, timestamp: Date.now() });
  view.toggleMotion(); oldWatch.success(fix(70));
  assert.equal(view.state.travel, null);
  assert.doesNotMatch(view.elements.get('heading-readout').textContent, /行进/);
  view.toggleMotion(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const newWatch = [...view.watches.values()][0]; newWatch.success(fix(80));
  oldWatch.success(fix(70)); assert.equal(view.state.travel.heading, 80);
  oldWatch.failure({ code: 2 }); assert.equal(view.state.travel.heading, 80);
  await view.setLocationMode('test'); newWatch.success(fix(90));
  assert.equal(view.state.travel, null); assert.equal(view.watches.size, 0);
  view.state.orientation.stop();
});

function liveLocationApp(options = {}) {
  const view = app({ visibility: 'visible', fetch: (url, init) => {
    if (url === '/world-plans') {
      if (options.prepare) return options.prepare(init);
      const body = JSON.parse(init.body);
      return response(plan({ plan_id: '33333333-3333-3333-3333-333333333333', target_year: body.year,
        location: { lat: body.lat, lon: body.lon }, input_kind: 'streetview_panorama',
        source_panorama: { metadata: { heading: 90 } },
        assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } }));
    }
    return response('source');
  }, ...options });
  authorised(view); view.bindEvents(); view.state.engine = fakeEngine();
  view.state.config.streetview = { available: true }; view.state.bootReady = true;
  view.state.plan = plan({ location: { lat: 1, lon: 2 }, input_kind: 'streetview_panorama',
    source_panorama: { metadata: { heading: 0, lat: 1.01, lon: 2.01 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  view.startLiveLocation();
  const feed = async (lat, { accuracy = 5, timestamp = Date.now() } = {}) => {
    [...view.watches.values()][0].success({ coords: { latitude: lat, longitude: 2, accuracy }, timestamp });
    await new Promise(setImmediate);
  };
  return { ...view, feed, posts: () => view.requests.filter((item) => item.method === 'POST') };
}

test('live GPS updates coordinates continuously but only refreshes source after meaningful movement', async () => {
  const view = liveLocationApp();
  await view.showView('source'); setCameraBearing(view.state.engine.camera, 123, 15);
  await view.feed(1.00002); // Small drift; pano camera itself is much farther away.
  assert.equal(view.elements.get('lat').value, '1.000020'); assert.equal(view.posts().length, 0);
  await view.feed(1.001);
  assert.deepEqual(view.posts().map((item) => item.url), ['/world-plans']);
  assert.equal(JSON.parse(view.posts()[0].body).lat, 1.001);
  assert.ok(Math.abs(cameraBearing(view.state.engine.camera).heading - 123) < 1e-7);
  await view.feed(1.002); // Already moved again, still within the request cooldown.
  assert.equal(view.posts().length, 1); assert.ok(view.state.liveTimer !== null);
  view.state.liveAttemptAt -= 16000; await view.maybePrepareCurrent();
  assert.equal(view.posts().length, 2); assert.equal(JSON.parse(view.posts()[1].body).lat, 1.002);
  await view.feed(1.00201); assert.equal(view.posts().length, 2);
});

test('live GPS preserves historical views, running jobs, native tracking and scale calibration', async () => {
  const view = liveLocationApp();
  view.state.job = { job_id: JOB, stage: 'generating_world' };
  await view.feed(1.001); assert.equal(view.posts().length, 0);
  view.state.job.stage = 'ready'; view.state.view = 'pano';
  await view.feed(1.002); assert.equal(view.posts().length, 0); assert.equal(view.state.job.job_id, JOB);
  view.state.view = 'world'; await view.feed(1.003); assert.equal(view.posts().length, 0);
  view.state.view = 'source'; view.state.scaleCalibration = { isActive: () => true };
  await view.feed(1.004); assert.equal(view.posts().length, 0);
  assert.equal(view.elements.get('lat').value, '1.004000');
  view.state.scaleCalibration = null;
  view.state.walking = { getStatus: () => ({ locked: true }) };
  const camera = view.state.engine.camera.position.clone();
  await view.feed(1.005);
  assert.equal(view.elements.get('lat').value, '1.005000');
  assert.equal(view.posts().length, 0); assert.ok(view.state.engine.camera.position.equals(camera));
});

test('a late automatic source response cannot replace a newly chosen view', async () => {
  let complete;
  const view = liveLocationApp({ prepare: () => new Promise((resolve) => { complete = resolve; }) });
  await view.feed(1.001); assert.equal(view.state.planBusy, true);
  view.state.view = 'world'; ++view.state.viewEpoch;
  const original = view.state.plan;
  complete(response(plan({ plan_id: '33333333-3333-3333-3333-333333333333' })));
  await new Promise(setImmediate);
  assert.equal(view.state.plan, original); assert.equal(view.state.view, 'world');
  assert.equal(view.state.planBusy, false);
});

test('live updates pause in background, resume once, and reject old watch callbacks after mode changes', async () => {
  const view = liveLocationApp(); const old = [...view.watches.values()][0];
  await view.feed(1.00001);
  view.document.visibilityState = 'hidden'; await view.emitDocument('visibilitychange');
  assert.equal(view.watches.size, 0);
  old.success({ coords: { latitude: 50, longitude: 20, accuracy: 5 }, timestamp: Date.now() });
  assert.equal(view.elements.get('lat').value, '1.000010');
  view.document.visibilityState = 'visible'; await view.emitDocument('visibilitychange');
  await view.emitDocument('visibilitychange'); assert.equal(view.watches.size, 1);
  const active = [...view.watches.values()][0]; await view.setLocationMode('test');
  active.success({ coords: { latitude: 50, longitude: 20, accuracy: 5 }, timestamp: Date.now() });
  assert.equal(view.elements.get('lat').value, ''); assert.equal(view.watches.size, 0);
});

test('poor GPS accuracy defers source refresh and failed requests have a retry cooldown', async () => {
  const view = liveLocationApp({ prepare: () => response({ detail: '附近没有街景' }, 404) });
  await view.feed(1.001, { accuracy: 100 });
  assert.equal(view.posts().length, 0); assert.match(view.elements.get('location-status').textContent, /更准确/);
  await view.feed(1.001); assert.equal(view.posts().length, 1);
  await view.feed(1.0011); assert.equal(view.posts().length, 1);
  assert.equal(view.state.plan.plan_id, PLAN);
  view.state.liveAttemptAt -= 61000; await view.maybePrepareCurrent();
  assert.equal(view.posts().length, 2); assert.equal(view.state.plan.plan_id, PLAN);
});

test('a year wheel selection updates the generation year without submitting on scroll or Enter', async () => {
  const view = app(); authorised(view); view.bindEvents(); view.state.plan = plan();
  assert.equal(view.elements.has('prepare'), false);
  await view.elements.get('year-wheel').emit('keydown', { key: 'ArrowUp' });
  assert.equal(view.elements.get('year').value, '1926');
  assert.match(view.elements.get('generate').textContent, /1926/);
  await view.elements.get('plan-form').emit('submit');
  assert.equal(view.requests.length, 0);
  view.state.yearWheel.setRange(1900, 1950); view.state.yearWheel.setValue(2100);
  assert.equal(view.elements.get('year').value, '1950');
});

test('generation at a moved location must successfully prepare the new location even for the same year', async () => {
  for (const fails of [false, true]) {
    const view = app({ gps: (success) => success({ coords: { latitude: 1.001, longitude: 2, accuracy: 5 }, timestamp: Date.now() }),
      fetch: (url, init) => {
        if (url === '/world-plans') return fails ? response({ detail: '没有街景' }, 404)
          : response(plan({ location: { lat: JSON.parse(init.body).lat, lon: 2 }, input_kind: 'streetview_panorama' }));
        if (url === '/world-jobs') return response({ job_id: JOB, stage: 'queued', assets: [] });
      } });
    authorised(view); view.state.plan = plan({ location: { lat: 1, lon: 2 } });
    view.state.locationFix = { lat: 1.001, lon: 2, accuracy_m: 5, timestamp_ms: Date.now() };
    await view.generateForYear();
    const posts = view.requests.filter((request) => request.method === 'POST');
    assert.equal(JSON.parse(posts[0].body).lat, 1.001);
    assert.deepEqual(posts.map((request) => request.url), fails ? ['/world-plans'] : ['/world-plans', '/world-jobs']);
  }
});

test('automatic refresh cannot clear a job that became active during the source request', async () => {
  let complete;
  const view = liveLocationApp({ prepare: () => new Promise((resolve) => { complete = resolve; }) });
  await view.feed(1.001);
  const original = view.state.plan;
  view.applyJob({ job_id: JOB, stage: 'generating_world', assets: [] });
  complete(response(plan({ plan_id: '33333333-3333-3333-3333-333333333333' })));
  await new Promise(setImmediate);
  assert.equal(view.state.plan, original); assert.equal(view.state.job.job_id, JOB);
  assert.equal(view.state.job.stage, 'generating_world'); assert.equal(view.state.planBusy, false);
  view.state.job.stage = 'submission_unknown'; await view.feed(1.002);
  view.state.job.stage = 'error'; await view.feed(1.003);
  assert.equal(view.posts().length, 1);
});
