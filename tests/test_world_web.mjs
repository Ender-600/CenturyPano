import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from 'three';

const source = readFileSync(new URL('../web/world/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/world/index.html', import.meta.url), 'utf8');
const PLAN = '11111111-1111-1111-1111-111111111111';
const JOB = '22222222222222222222222222222222';
const PROBE = '/world-plans/00000000-0000-0000-0000-000000000000';
const TOKEN = 'private-test-access-token';

class Element {
  constructor(tagName = 'DIV') {
    Object.assign(this, { tagName, children: [], handlers: {}, attributes: {}, dataset: {}, style: {},
      hidden: false, disabled: false, value: '', textContent: '', clientWidth: 800, clientHeight: 400 });
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set innerHTML(_value) { throw new Error('Do not inject untrusted HTML'); }
  addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
  async emit(type, event = {}) {
    for (const callback of this.handlers[type] || []) await callback({ target: this, preventDefault() {}, ...event });
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
  elements.get('plan-form').inputs = ['lat', 'lon', 'year', 'radius', 'gps', 'snapshot', 'prepare', 'location-mode', 'geometry-test', 'open-streetview'].map((id) => elements.get(id));
  const tabs = ['source', 'historical', 'modern', 'depth', 'pano', 'world'].map((view) => Object.assign(new Element('BUTTON'), { dataset: { view } }));
  const moves = ['forward', 'back', 'left', 'right'].map((move) => Object.assign(new Element('BUTTON'), { dataset: { move } }));
  const storage = new Map(Object.entries(options.storage || {})), requests = [], timers = new Map(), rewrites = [], gpsOptions = [], popups = [];
  const objects = new Map(), revoked = [];
  const workspace = new Element('SECTION');
  let timerId = 0, objectId = 0, gpsCalls = 0;
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
    createElement(tag) { return new Element(tag.toUpperCase()); }, addEventListener() {},
  };
  const context = vm.createContext({
    THREE, SplatMesh: SplatStub, SparkRenderer: class {},
    GLTFLoader: class { async parseAsync() { return { scene: options.gltf || new THREE.Group() }; } },
    document, window: { addEventListener() {}, open(...args) {
      const popup = { args, opener: {}, location: { replace(url) { popup.url = url; } }, close() { popup.closed = true; } };
      popups.push(popup); return options.blockPopups ? null : popup;
    }, isSecureContext: options.secure !== false, devicePixelRatio: 1, matchMedia: () => ({ matches: !!options.mobile }) },
    location: { hash: '', search: '', pathname: '/world', hostname: 'example.test', ...options.location },
    history: { replaceState(...args) { rewrites.push(args); } },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    navigator: { geolocation: options.noGPS ? undefined : { getCurrentPosition(success, failure, settings) {
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
  const hooks = '{state,api,safeAssetURL,safeSourceURL,initialiseAccess,boot,bindEvents,preparePlan,renderPlan,startGeneration,pollJob,applyJob,restoreSaved,showView,semanticsTransform,importEdits,resumeJob,changeReason,refreshLocation,setLocationMode,resolveLocation,openStreetView}';
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('void boot();', `globalThis.hooks = ${hooks};`), context);
  return { ...context.hooks, elements, tabs, moves, requests, timers, storage, rewrites, objects, revoked,
    gpsCalls: () => gpsCalls, gpsOptions, popups, document, SplatStub, workspace };
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
  assert.equal(view.elements.get('prepare').disabled, false);
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
  assert.deepEqual(JSON.parse(view.requests[0].body), { plan_id: PLAN, model: 'marble-1.0-draft' });
  assert.equal([...view.timers.values()][0].milliseconds, 5000);
  await view.pollJob(view.state.jobEpoch); await view.pollJob(view.state.jobEpoch);
  assert.equal(view.requests.filter((request) => request.method === 'GET').length, 2);
  assert.equal(view.state.job.stage, 'ready');
  assert.equal(view.timers.size, 0);
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
  authorised(view);
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
  assert.match(view.elements.get('viewer-note').textContent, /未核实/);
});

test('missing or partial scale metadata keeps model units and does not guess ground', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz`,
    semantics_metadata: { metric_scale_factor: 2 } }] };
  await view.showView('world');
  const splat = view.state.engine.current.children[0];
  assert.equal(splat.scale.x, 1); assert.equal(Math.abs(splat.position.y), 0);
  assert.equal(view.state.engine.metric, false);
  assert.match(view.elements.get('view-caption').textContent, /模型单位/);
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
  assert.match(view.elements.get('viewer-note').textContent, /现代双黄线/);
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
  authorised(view); await view.preparePlan();
  assert.equal(view.state.view, 'source');
  assert.equal(view.elements.get('geometry-stats').hidden, true);
  assert.equal(view.elements.get('geometry-edits').hidden, true);
  assert.ok(view.tabs.filter((tab) => ['historical', 'modern', 'depth'].includes(tab.dataset.view)).every((tab) => tab.hidden));
  assert.match(view.elements.get('view-caption').textContent, /360° 实景全景照片/);
  assert.match(view.elements.get('viewer-note').textContent, /2024-06.*照片/);
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
