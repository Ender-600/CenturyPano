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
  for (const [id, value] of Object.entries({ lat: 40.4433, lon: -79.9436, year: 1925, radius: 100 })) {
    elements.get(id).value = String(value);
  }
  elements.get('plan-form').inputs = ['lat', 'lon', 'year', 'radius', 'gps', 'snapshot', 'prepare'].map((id) => elements.get(id));
  const tabs = ['historical', 'modern', 'depth', 'pano', 'world'].map((view) => Object.assign(new Element('BUTTON'), { dataset: { view } }));
  const moves = ['forward', 'back', 'left', 'right'].map((move) => Object.assign(new Element('BUTTON'), { dataset: { move } }));
  const storage = new Map(Object.entries(options.storage || {})), requests = [], timers = new Map(), rewrites = [];
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
    document, window: { addEventListener() {}, devicePixelRatio: 1, matchMedia: () => ({ matches: !!options.mobile }) },
    location: { hash: '', search: '', pathname: '/world', hostname: 'example.test', ...options.location },
    history: { replaceState(...args) { rewrites.push(args); } },
    sessionStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    navigator: { geolocation: { getCurrentPosition(success) { gpsCalls++; success({ coords: { latitude: 1, longitude: 2, accuracy: 12 } }); } } },
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
  const hooks = '{state,api,safeAssetURL,safeSourceURL,initialiseAccess,boot,bindEvents,preparePlan,renderPlan,startGeneration,pollJob,applyJob,restoreSaved,showView,semanticsTransform,importEdits,resumeJob,changeReason}';
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('void boot();', `globalThis.hooks = ${hooks};`), context);
  return { ...context.hooks, elements, tabs, moves, requests, timers, storage, rewrites, objects, revoked,
    gpsCalls: () => gpsCalls, document, SplatStub, workspace };
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

test('boot uses loopback session without keys and never requests geolocation automatically', async () => {
  const view = app({ location: { hostname: 'localhost' } });
  await view.boot();
  assert.deepEqual(view.requests.map((request) => request.url).sort(), ['/world-config', '/world-session']);
  assert.ok(view.requests.every((request) => !request.headers.has('Authorization')));
  assert.equal(view.gpsCalls(), 0);
  await view.elements.get('gps').emit('click');
  assert.equal(view.gpsCalls(), 1);
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
  authorised(view);
  await view.preparePlan();
  assert.equal(view.requests.length, 1);
  assert.equal(JSON.parse(view.requests[0].body).source, 'osm');
  assert.equal(view.state.planBusy, false);
  assert.equal(view.elements.get('prepare').disabled, false);
  assert.match(view.elements.get('message').textContent, /地图来源/);
});

test('explicit CMU snapshot retains chosen year and never starts paid generation', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response(plan({ target_year: 1946 })) : undefined });
  authorised(view); view.elements.get('lat').value = '1'; view.elements.get('year').value = '1946';
  await view.preparePlan('cmu_snapshot');
  const payload = JSON.parse(view.requests[0].body);
  assert.deepEqual(payload, { lat: 40.4433, lon: -79.9436, year: 1946, radius_m: 100, heading_deg: 0, source: 'cmu_snapshot' });
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
  authorised(view); await view.preparePlan('cmu_snapshot');
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
