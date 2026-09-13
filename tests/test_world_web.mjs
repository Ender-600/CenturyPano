import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from 'three';
import { createPanoramaMesh, PanoramaLookControls, panoramaHeading, setCameraBearing, cameraBearing } from '../web/world/panorama.js';
import { createOrientationController, headingFromQuaternion } from '../web/world/orientation.js';
import { createLiveLocation, positionFix, locationDistance } from '../web/world/location.js';
import { createYearWheel } from '../web/world/year-wheel.js';
import { createMotionController } from '../web/world/motion.js';
import { createGPSWalkingController } from '../web/world/gps-walking.js';
import { createScaleCalibration } from '../web/world/scale.js';
import { createPanoramaPrefetch } from '../web/world/prefetch.js';
import { createPanoramaHotspots } from '../web/world/hotspots.js';

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
  focus() {}
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
  for (const [id, value] of Object.entries({ lat: '', lon: '', year: 1925, radius: 100, 'location-mode': 'device', 'walk-mode': 'gps' })) {
    elements.get(id).value = String(value);
  }
  elements.get('plan-form').inputs = ['lat', 'lon', 'year', 'radius', 'gps', 'snapshot', 'test-prepare', 'location-mode', 'geometry-test', 'open-streetview'].map((id) => elements.get(id));
  const tabs = ['source', 'historical', 'modern', 'depth', 'pano', 'world'].map((view) => Object.assign(new Element('BUTTON'), { dataset: { view } }));
  const moves = ['forward', 'back', 'left', 'right'].map((move) => Object.assign(new Element('BUTTON'), { dataset: { move } }));
  const storage = new Map(Object.entries(options.storage || {})), requests = [], timers = new Map(), rewrites = [], gpsOptions = [], popups = [];
  const objects = new Map(), revoked = [], documentEvents = {}, windowEvents = {}, watches = new Map();
  const parentMessages = [], parent = { postMessage(data, origin) { parentMessages.push({ data, origin }); } };
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
    createOrientationController, headingFromQuaternion, createGPSWalkingController, createLiveLocation, positionFix, locationDistance, createYearWheel,
    createMotionController, createScaleCalibration, createPanoramaPrefetch, createPanoramaHotspots, SplatMesh: SplatStub, SparkRenderer: class {},
    GLTFLoader: class { async parseAsync() { return { scene: options.gltf || new THREE.Group() }; } },
    document, window: { DeviceOrientationEvent: options.orientation, CenturyMotion: options.nativeBridge,
      crypto: { randomUUID: () => `native-session-${++objectId}-00000000` },
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
      if (url === '/app-session') return response({ detail: 'Not found' }, 404);
      if (url === '/world-session') return response({ access_token: TOKEN });
      if (url === PROBE) return response({ detail: 'missing' }, 404);
      throw new Error('Unexpected fetch');
    },
  });
  document.defaultView = context.window;
  context.window.parent = parent;
  for (const element of elements.values()) element.ownerDocument = document;
  const hooks = '{state,api,receiveHostState,publishWorldState,setJobURL,startPanoramaGeneration,syncEmbeddedView,safeAssetURL,safeSourceURL,initialiseAccess,boot,bindEvents,preparePlan,renderPlan,startGeneration,pollJob,applyJob,restoreSaved,showView,semanticsTransform,importEdits,resumeJob,changeReason,refreshLocation,setLocationMode,resolveLocation,openStreetView,toggleMotion,startAutomaticMotion,calibrateView,manualLook,maybeStartWalking,startTravelTracking,stopTravelTracking,generateForYear,moveCamera,startWalking,stopWalking,applyNativeWalking,applyGPSWalking,nativeWalkingLocked,gpsWalkingLocked,walkingLocked,updateWalkingUI,startLiveLocation,stopLiveLocation,maybePrepareCurrent,syncPrefetch,togglePrefetch,preloadPanorama,activatePreparedPanorama,advancePanoramaTransition,finishPanoramaTransition}';
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('void boot();', `globalThis.hooks = ${hooks};`), context);
  return { ...context.hooks, elements, tabs, moves, requests, timers, storage, rewrites, objects, revoked,
    window: context.window, parent, parentMessages,
    gpsCalls: () => gpsCalls, gpsOptions, popups, document, SplatStub, workspace, watches,
    async emitDocument(type, event = {}) { for (const callback of [...(documentEvents[type] || [])]) await callback(event); },
    async emitWindow(type, event = {}) { for (const callback of [...(windowEvents[type] || [])]) await callback(event); } };
}

function authorised(view) { view.state.token = TOKEN; view.state.config = { configured: true }; }

test('standalone world detects public access automatically without a code, bearer or saved credential', async () => {
  const view = app({ storage: { 'century.world.access': TOKEN }, fetch: (url) => {
    if (url === '/app-session') return response({ authenticated: true, access_mode: 'public' });
    if (url === `/world-plans/${PLAN}`) return response(plan());
  } });
  await view.boot();
  assert.equal(view.state.bootReady, true);
  assert.equal(view.state.sessionMode, true);
  assert.equal(view.state.sessionAuthenticated, true);
  assert.equal(view.state.publicAccess, true);
  assert.equal(view.state.token, '');
  assert.equal(view.storage.has('century.world.access'), false);
  assert.equal(view.elements.get('access-panel').hidden, true);
  const loaded = await view.api(`/world-plans/${PLAN}`);
  assert.equal(loaded.plan_id, PLAN);
  assert.ok(view.requests.every((request) => request.method === 'GET' && !request.headers.has('Authorization')));
  assert.ok(view.requests.every((request) => !request.url.includes(TOKEN) && request.body === undefined));
  assert.equal(view.requests.some((request) => request.url === '/world-session'), false);
});

test('public service failures show retry guidance and do not fall back to an access-code form', async () => {
  const unavailable = app({ storage: { 'century.world.access': TOKEN }, fetch: (url) => {
    if (url === '/app-session') return response({ detail: 'Service unavailable' }, 502);
  } });
  await unavailable.initialiseAccess();
  assert.equal(unavailable.state.sessionAuthenticated, false);
  assert.equal(unavailable.state.token, '');
  assert.equal(unavailable.elements.get('access-panel').hidden, true);
  assert.match(unavailable.elements.get('message').textContent, /Reload this page/);

  const revoked = app({ fetch: (url) => url === '/app-session'
    ? response({ authenticated: true, access_mode: 'public' }) : response({ detail: 'Service unavailable' }, 401) });
  await revoked.initialiseAccess();
  await assert.rejects(revoked.api(`/world-plans/${PLAN}`));
  assert.equal(revoked.state.sessionAuthenticated, false);
  assert.equal(revoked.elements.get('access-panel').hidden, true);
  await assert.rejects(revoked.api(`/world-plans/${PLAN}`), /service is unavailable/i);
});

test('gateway cookie session enables world controls without a bearer or stored access code', async () => {
  const view = app({ location: { search: '?session=1' }, storage: { 'century.world.access': TOKEN }, fetch: (url) => {
    if (url === '/app-session') return response({ authenticated: true });
    if (url === `/world-plans/${PLAN}`) return response(plan());
  } });
  view.state.locationMode = 'test';
  await view.initialiseAccess();
  assert.equal(view.state.sessionAuthenticated, true);
  assert.equal(view.state.token, '');
  assert.equal(view.storage.has('century.world.access'), false);
  assert.equal(view.elements.get('access-panel').hidden, true);
  assert.equal(view.elements.get('geometry-test').disabled, false);
  const loaded = await view.api(`/world-plans/${PLAN}`);
  assert.equal(loaded.plan_id, PLAN);
  assert.ok(view.requests.every((request) => request.credentials === 'same-origin' && !request.headers.has('Authorization')));
  assert.equal(view.gpsCalls(), 0);
});

test('cookie session failure and expiration leave world APIs and generation locked', async () => {
  for (const sessionReply of [response({ authenticated: false }, 401), response({ authenticated: 'true' }), response({}, 502)]) {
    const view = app({ location: { search: '?session=1' }, fetch: (url) => url === '/app-session' ? sessionReply : undefined });
    await view.initialiseAccess();
    assert.equal(view.state.sessionAuthenticated, false);
    assert.equal(view.elements.get('access-panel').hidden, sessionReply.status !== 401);
    const count = view.requests.length;
    await assert.rejects(view.api(`/world-plans/${PLAN}`), /access code/i);
    assert.equal(view.requests.length, count);
  }
  const expired = app({ location: { search: '?session=1' }, fetch: (url) => url === '/app-session'
    ? response({ authenticated: true }) : response({ detail: 'Access code required' }, 401) });
  await expired.initialiseAccess();
  await assert.rejects(expired.api(`/world-plans/${PLAN}`));
  assert.equal(expired.state.sessionAuthenticated, false);
  assert.equal(expired.elements.get('access-panel').hidden, false);
  assert.equal(expired.elements.get('generate').disabled, true);
});

test('the world reconnect form renews gateway access through the cookie session endpoint', async () => {
  const view = app({ location: { search: '?session=1' }, fetch: (url) => {
    if (url === '/app-session') return response({ authenticated: true });
  } });
  view.bindEvents();
  view.elements.get('access').value = TOKEN;
  await view.elements.get('connect').emit('click');
  assert.equal(view.state.sessionAuthenticated, true);
  assert.equal(view.state.token, '');
  assert.equal(view.storage.has('century.world.access'), false);
  assert.equal(view.elements.get('access').value, '');
  assert.equal(view.requests[0].url, '/app-session');
  assert.equal(view.requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(view.requests[0].body), { access_code: TOKEN });
  assert.equal(view.requests[0].headers.has('Authorization'), false);
});

test('world jobs continue polling with a cookie session and no token', async () => {
  const view = app({ location: { search: '?session=1' }, fetch: (url) => {
    if (url === `/world-jobs/${JOB}`) return response({ job_id: JOB, status: 'queued', stage: 'queued' });
  } });
  view.state.sessionAuthenticated = true;
  view.state.job = { job_id: JOB, stage: 'queued' };
  await view.pollJob(view.state.jobEpoch);
  assert.equal(view.requests[0].url, `/world-jobs/${JOB}`);
  assert.equal(view.requests[0].headers.has('Authorization'), false);
  assert.equal(view.timers.get(view.state.pollTimer).milliseconds, 5000);
});

test('reconnecting an expired cookie loads service configuration that failed during boot', async () => {
  let authenticated = false;
  const view = app({ location: { search: '?session=1' }, fetch: (url, init) => {
    if (url === '/app-session') {
      if (init.method === 'POST') authenticated = true;
      return response({ authenticated }, authenticated ? 200 : 401);
    }
    if (url === '/world-config') return response({ configured: true }, authenticated ? 200 : 401);
  } });
  await view.boot();
  assert.equal(view.state.config, null);
  assert.equal(view.state.sessionAuthenticated, false);
  view.elements.get('access').value = TOKEN;
  await view.elements.get('connect').emit('click');
  assert.equal(view.state.sessionAuthenticated, true);
  assert.equal(view.state.config.configured, true);
  assert.equal(view.elements.get('access-panel').hidden, true);
  assert.equal(view.requests.filter((request) => request.url === '/world-config').length, 2);
});

test('a standalone bearer login retries protected configuration without losing verified access', async () => {
  const view = app({ storage: { 'century.world.access': TOKEN }, fetch: (url, init) => {
    if (url === '/world-config') return response({ configured: true }, init.headers.get('Authorization') === `Bearer ${TOKEN}` ? 200 : 401);
  } });
  await view.boot();
  assert.equal(view.state.token, TOKEN);
  assert.equal(view.state.config.configured, true);
  assert.equal(view.elements.get('access-panel').hidden, true);
  const requests = view.requests.filter((request) => request.url === '/world-config');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.has('Authorization'), false);
  assert.equal(requests[1].headers.get('Authorization'), `Bearer ${TOKEN}`);
});

test('remote fragment access is removed from URL and sent only in protected headers', async () => {
  const view = app({ location: { hash: `#access=${TOKEN}` } });
  await view.initialiseAccess();
  assert.equal(view.state.token, TOKEN);
  assert.equal(view.rewrites[0][2], '/world');
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[0].url, '/app-session');
  assert.equal(view.requests[0].headers.has('Authorization'), false);
  assert.equal(view.requests[1].url, PROBE);
  assert.equal(view.requests[1].headers.get('Authorization'), `Bearer ${TOKEN}`);
  assert.equal(view.requests[1].redirect, 'error');
  assert.equal(view.storage.get('century.world.access'), TOKEN);
  assert.equal(view.gpsCalls(), 0);
});

test('boot uses loopback session and requests a fresh device position automatically', async () => {
  const view = app({ location: { hostname: 'localhost' } });
  await view.boot();
  assert.deepEqual(view.requests.map((request) => request.url).sort(), ['/app-session', '/world-config', '/world-session']);
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
  await assert.rejects(view.api('https://evil.example'), /URL/);
  assert.equal(view.requests.length, 0);
  assert.equal(view.safeSourceURL('javascript:alert(1)'), null);
  assert.equal(view.safeSourceURL('https://user:pass@example.com'), null);
  assert.equal(view.safeSourceURL('https://www.cmu.edu/history'), 'https://www.cmu.edu/history');
});

test('OSM failure exits loading without silently switching to a snapshot', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response({ detail: 'Map source unavailable.' }, 422) : undefined });
  authorised(view); await view.setLocationMode('test');
  view.elements.get('lat').value = '40.44'; view.elements.get('lon').value = '-79.94';
  await view.preparePlan('osm');
  assert.equal(view.requests.length, 1);
  assert.equal(JSON.parse(view.requests[0].body).source, 'osm');
  assert.equal(view.state.planBusy, false);
  assert.equal(view.elements.get('test-prepare').disabled, false);
  assert.match(view.elements.get('message').textContent, /Map source/);
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
  assert.match(view.elements.get('job-quality').textContent, /Quick draft/);
});

test('saved Draft and reduced SPZ keep their actual quality labels without triggering an upgrade', () => {
  const view = app(); authorised(view); view.renderPlan(plan());
  view.applyJob({ job_id: JOB, stage: 'ready', model: 'marble-1.0-draft',
    assets: [{ kind: 'spz', filename: 'scene.spz', lod: '100k', validation: { num_points: 100000 } }] });
  assert.match(view.elements.get('job-quality').textContent, /Quick draft.*Reduced resolution 100k.*100,000 points/);
  assert.doesNotMatch(view.elements.get('job-quality').textContent, /Standard|Full resolution/);
  assert.equal(view.elements.get('world-model').value, 'marble-1.0-draft');
  assert.equal(view.elements.get('world-model').disabled, true);
  assert.equal(view.requests.length, 0);
  view.applyJob({ job_id: JOB, stage: 'ready', model: 'marble-1.1',
    assets: [{ kind: 'spz', filename: 'scene.spz', lod: 'full_res', validation: { num_points: 2000000 } }] });
  assert.match(view.elements.get('job-quality').textContent, /Standard.*Full resolution.*2,000,000 points/);
  assert.equal(view.requests.length, 0);
  view.applyJob({ job_id: JOB, stage: 'ready', assets: [{ kind: 'spz', filename: 'scene.spz' }] });
  assert.match(view.elements.get('job-quality').textContent, /Model not recorded.*Asset resolution not recorded/);
  assert.doesNotMatch(view.elements.get('generation-quality').textContent, /Standard/);
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
  assert.ok(view.state.engine.current.children[0].children[0] instanceof view.SplatStub);
  assert.equal(view.rewrites.at(-1)[2], `/world?world=${JOB}`);
  assert.equal(view.rewrites.some((entry) => entry[2].includes(TOKEN)), false);
  assert.equal(JSON.parse(view.storage.get('century.world.resume')).job_id, JOB);
});

test('malformed world query does not load an unrelated saved task', async () => {
  const view = app({ location: { search: '?world=not-a-job' },
    storage: { 'century.world.resume': JSON.stringify({ job_id: JOB, plan_id: PLAN }) } });
  authorised(view); await view.restoreSaved();
  assert.equal(view.requests.length, 0);
  assert.match(view.elements.get('message').textContent, /Invalid world job link/);
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
  assert.match(view.elements.get('view-caption').textContent, /Reimagined panorama/);
  assert.equal(view.objects.size, 1);
  assert.equal(await [...view.objects.values()][0].text(), 'new panorama');
});

function fakeEngine() {
  return { renderer: { domElement: new Element('CANVAS') }, scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(), controls: { target: new THREE.Vector3(), update() {} },
    helpers: new THREE.Group(), current: null, home: null };
}

test('prepared panorama is decoded and uploaded before an atomic switch that preserves orientation', async () => {
  const view = app({ visibility: 'visible', fetch: () => response('panorama') });
  authorised(view); view.state.config.prefetch = { available: true };
  view.state.engine = fakeEngine(); view.state.prefetchEnabled = true;
  const original = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { pano_id: 'a', heading: 10 } } });
  view.state.plan = original; view.state.view = 'pano';
  const old = createPanoramaMesh({ width: 2048, height: 1024 }, original.source_panorama.metadata);
  view.state.engine.current = old; view.state.engine.scene.add(old);
  view.state.imageURL = 'blob:previous';
  setCameraBearing(view.state.engine.camera, 345, 25);
  const orientation = view.state.engine.camera.quaternion.clone();
  let uploaded = 0, disposed = 0;
  view.state.engine.renderer.initTexture = () => uploaded++;
  old.geometry.addEventListener('dispose', () => disposed++);
  const next = plan({ plan_id: '33333333-3333-3333-3333-333333333333', input_kind: 'streetview_panorama',
    source_panorama: { metadata: { pano_id: 'b', heading: 140, copyright: 'Test source' } } });
  const job = { id: JOB, plan_id: next.plan_id, kind: 'panorama', stage: 'ready', assets: [
    { kind: 'historical_pano', filename: 'historical_panorama.jpg', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  const resource = await view.preloadPanorama(next, job);
  assert.equal(uploaded, 1); assert.equal(view.state.engine.current, old);
  assert.equal(view.requests.length, 1);
  assert.equal(await view.activatePreparedPanorama({ plan: next, job, resource }), true);
  assert.equal(view.requests.filter((request) => request.url.includes('/assets/')).length, 1,
    'Switching an already decoded panorama does not fetch its image again');
  assert.equal(view.requests.at(-1).url, `/world-jobs/${JOB}/hotspots`);
  assert.equal(view.state.engine.current, resource.mesh);
  assert.deepEqual(view.state.engine.camera.quaternion.toArray(), orientation.toArray());
  assert.equal(view.state.plan.plan_id, next.plan_id); assert.equal(view.state.job.id, JOB);
  assert.equal(resource.transferred, true); assert.equal(resource.mesh.material.opacity, 0);
  assert.equal(disposed, 0, 'Previous scene stays visible during the fade');
  view.advancePanoramaTransition(0.175); assert.equal(resource.mesh.material.opacity, 0.5);
  view.advancePanoramaTransition(0.175); assert.equal(resource.mesh.material.opacity, 1);
  assert.equal(disposed, 1); assert.ok(view.revoked.includes('blob:previous'));
  resource.dispose(); assert.equal(resource.disposed, false, 'The viewer owns the transferred resource');
});

test('prepared panoramas never automatically replace 3D walking, a changed year, or a hidden view', async () => {
  const view = app({ visibility: 'visible', fetch: () => response('panorama') });
  authorised(view); view.state.config.prefetch = { available: true };
  view.state.prefetchEnabled = true; view.state.engine = fakeEngine();
  view.state.engine.current = new THREE.Group();
  const next = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 0 } } });
  view.state.plan = next;
  const job = { id: JOB, kind: 'panorama', stage: 'ready', assets: [
    { kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  const resource = await view.preloadPanorama(next, job), previous = view.state.engine.current;
  view.state.view = 'world';
  assert.equal(await view.activatePreparedPanorama({ plan: next, job, resource }), false);
  view.state.view = 'pano'; view.elements.get('year').value = '1955';
  assert.equal(await view.activatePreparedPanorama({ plan: next, job, resource }), false);
  view.elements.get('year').value = '1925'; view.document.visibilityState = 'hidden';
  assert.equal(await view.activatePreparedPanorama({ plan: next, job, resource }), false);
  view.document.visibilityState = 'visible'; view.state.gpsWalking = { getStatus: () => ({ locked: true }) };
  assert.equal(await view.activatePreparedPanorama({ plan: next, job, resource }), false);
  assert.equal(view.state.engine.current, previous); assert.equal(resource.transferred, false);
  resource.dispose(); assert.equal(resource.disposed, true); assert.ok(view.revoked.includes(resource.imageURL));
});

test('panorama walking can generate the current panorama without a configured 3D provider', async () => {
  const view = app({ visibility: 'visible', fetch: (url) => url === '/world-jobs'
    ? response({ id: JOB, plan_id: PLAN, kind: 'panorama', stage: 'queued', assets: [] }) : undefined });
  authorised(view); view.state.config = { configured: false, prefetch: { available: true } };
  view.state.plan = plan({ input_kind: 'streetview_panorama' });
  await view.togglePrefetch();
  const submitted = view.requests.filter((item) => item.method === 'POST');
  assert.equal(submitted.length, 1);
  assert.deepEqual(JSON.parse(submitted[0].body), { plan_id: PLAN, kind: 'panorama' });
  assert.equal(view.state.prefetchEnabled, true); assert.equal(view.state.job.id, JOB);
  assert.equal(view.elements.get('prefetch-toggle').textContent, 'Stop preparing ahead');
  view.state.prefetch.dispose();
});

test('foreground preparation and source auto-refresh cannot run alongside a panorama walk', async () => {
  const view = app({ visibility: 'visible' }); authorised(view);
  view.state.bootReady = true; view.state.prefetchEnabled = true;
  view.state.config.prefetch = { available: true }; view.state.config.streetview = { available: true };
  view.state.plan = plan({ input_kind: 'streetview_panorama' });
  view.state.locationFix = { lat: 1, lon: 2, accuracy_m: 5, timestamp_ms: Date.now() };
  await view.maybePrepareCurrent(); assert.equal(view.requests.length, 0);
  const contexts = [];
  view.state.prefetch = { setContext: (context) => contexts.push(context) };
  view.state.job = { id: JOB, stage: 'generating_world', assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  view.syncPrefetch(); assert.equal(contexts.at(-1).active, false);
  view.state.job.stage = 'ready'; view.state.view = 'world';
  view.syncPrefetch(); assert.equal(contexts.at(-1).active, true); assert.equal(contexts.at(-1).allowSwitch, false);
  view.state.view = 'pano'; view.syncPrefetch(); assert.equal(contexts.at(-1).allowSwitch, true);
});

test('entering panorama mode finishes its old load before activating the prepared next scene', async () => {
  let releaseOld;
  const nextId = '33333333333333333333333333333333';
  const view = app({ visibility: 'visible', fetch: (url) => url.includes(nextId) ? response('next panorama')
    : new Promise((resolve) => { releaseOld = () => resolve(response('old panorama')); }) });
  authorised(view); view.state.config.prefetch = { available: true };
  view.state.engine = fakeEngine(); view.state.engine.current = new THREE.Group();
  view.state.prefetchEnabled = true; view.state.view = 'world';
  view.state.plan = plan({ input_kind: 'streetview_panorama' });
  view.state.job = { id: JOB, stage: 'ready', assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  const next = plan({ plan_id: '33333333-3333-3333-3333-333333333333', input_kind: 'streetview_panorama' });
  const job = { id: nextId, kind: 'panorama', stage: 'ready', assets: [
    { kind: 'historical_pano', url: `/world-jobs/${nextId}/assets/historical_panorama.jpg` }] };
  const resource = await view.preloadPanorama(next, job);
  view.state.prefetch = { setContext: (context) => {
    if (context.allowSwitch && !resource.transferred) void view.activatePreparedPanorama({ plan: next, job, resource });
  } };
  const loading = view.showView('pano');
  assert.equal(view.state.viewBusy, true); assert.equal(resource.transferred, false);
  assert.equal(view.state.plan.plan_id, PLAN);
  releaseOld(); await loading;
  assert.equal(view.state.viewBusy, false); assert.equal(resource.transferred, true);
  assert.equal(view.state.plan.plan_id, next.plan_id); assert.equal(view.state.engine.current, resource.mesh);
  assert.equal(view.state.imageURL, resource.imageURL);
  view.finishPanoramaTransition();
});

test('stopping during preparation of a changed year prevents the not-yet-submitted image job', async () => {
  let releasePlan;
  const next = plan({ target_year: 1955, input_kind: 'streetview_panorama',
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  const view = app({ visibility: 'visible', fetch: (url) => url === '/world-plans'
    ? new Promise((resolve) => { releasePlan = () => resolve(response(next)); }) : response('source') });
  authorised(view); view.state.config.prefetch = { available: true }; view.state.engine = fakeEngine();
  view.state.plan = plan({ input_kind: 'streetview_panorama' }); view.elements.get('year').value = '1955';
  const starting = view.togglePrefetch();
  for (let i = 0; i < 15 && !releasePlan; i++) await Promise.resolve();
  assert.ok(releasePlan); assert.equal(view.state.prefetchEnabled, true);
  await view.togglePrefetch(); assert.equal(view.state.prefetchEnabled, false);
  releasePlan(); await starting;
  assert.equal(view.requests.filter((item) => item.url === '/world-jobs' && item.method === 'POST').length, 0);
  view.state.prefetch.dispose();
});

test('SPZ receives real bytes and metric transform precedes the X180 axis conversion', async () => {
  const bytes = new Uint8Array([31, 139, 7, 8]).buffer;
  const view = app({ fetch: () => response(bytes) });
  authorised(view); view.state.engine = fakeEngine();
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz`,
    semantics_metadata: { metric_scale_factor: 2, ground_plane_offset: 0.42 } }] };
  await view.showView('world');
  const parent = view.state.engine.current, splat = parent.children[0].children[0];
  assert.ok(splat instanceof view.SplatStub);
  assert.equal(splat.input.fileType, 'spz');
  assert.deepEqual([...splat.input.fileBytes], [31, 139, 7, 8]);
  parent.updateMatrixWorld(true);
  const transformed = new THREE.Vector3(2, 3, 4).applyMatrix4(splat.matrixWorld);
  assert.ok(transformed.distanceTo(new THREE.Vector3(4, -5.58, -8)) < 1e-10);
  assert.equal(view.state.engine.metric, true);
  assert.match(view.elements.get('view-details').textContent, /unverified/i);
});

test('valid metric scale enables meter walking even without ground height metadata', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz`,
    semantics_metadata: { metric_scale_factor: 2 } }] };
  await view.showView('world');
  const splat = view.state.engine.current.children[0].children[0];
  assert.equal(splat.scale.x, 2); assert.equal(Math.abs(splat.position.y), 0);
  assert.equal(view.state.engine.metric, true);
  assert.match(view.elements.get('view-details').textContent, /ground height unverified/);
  assert.equal(view.elements.get('walk-scale').disabled, true);
});

test('missing or invalid metric scale keeps model units without applying a ground offset', () => {
  const view = app();
  for (const scale of [undefined, null, '2', 0, -1, Infinity, NaN]) {
    const transform = view.semanticsTransform({ semantics_metadata: { metric_scale_factor: scale, ground_plane_offset: 1.7 } });
    assert.equal(transform.scale, 1); assert.equal(transform.offset, 0);
    assert.equal(transform.metric, false); assert.equal(transform.groundAligned, false);
  }
});

test('failed historical review stays explicit while genuine SPZ assets remain viewable', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  const job = { job_id: JOB, stage: 'ready', review: { status: 'rejected', scope: 'historical_appearance',
    notes: ['Modern double yellow lines and large advertisements do not match this location in 1925.'] },
    validation: { historical_accuracy: 'failed_visual_review' },
    assets: [{ kind: 'spz', filename: 'scene.spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  view.applyJob(job);
  assert.match(view.elements.get('job-stage').textContent, /Historical appearance failed review/);
  assert.match(view.elements.get('job-detail').textContent, /Modern double yellow lines/);
  assert.equal(view.tabs.find((tab) => tab.dataset.view === 'world').disabled, false);
  await view.showView('world');
  assert.ok(view.state.engine.current.children[0].children[0] instanceof view.SplatStub);
  assert.match(view.elements.get('view-caption').textContent, /Historical appearance failed review/);
  assert.match(view.elements.get('view-details').textContent, /Modern double yellow lines/);
  view.applyJob(job);
  assert.equal(view.elements.get('viewer-note').textContent.match(/Historical appearance failed review/g).length, 1);
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
  assert.equal(entry.children[0].textContent, 'Date unverified');
  assert.equal(entry.children[1].textContent, '<img onerror=attack()>');
  assert.equal(view.elements.get('sources').children[0].tagName, 'P');
  assert.equal(view.elements.get('sources').children[1].rel, 'noopener noreferrer');
});

test('only recognised planning reasons are translated; user explanations remain verbatim', () => {
  const view = app();
  const official = 'Official CMU completion/opening evidence postdates 1925. Remove the completed modern building; earlier structures and construction-stage geometry remain unknown.';
  assert.match(view.changeReason({ reason: official }), /after 1925/);
  assert.match(view.changeReason({ reason: 'No bound archival date or target-year footprint. Retained only as an unverified modern massing placeholder.' }), /unverified/i);
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
  assert.match(view.elements.get('location-status').textContent, /Location permission denied/);
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
  await assert.rejects(view.refreshLocation(), /Location permission denied/);
  assert.equal(view.elements.get('location-help').hidden, false);
  const instructions = view.elements.get('location-help-steps').children.map((element) => element.textContent).join(' ');
  assert.match(instructions, /Website Settings/);
  assert.match(instructions, /Privacy & Security/);
  assert.match(instructions, /Precise Location/);
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
  assert.match(view.elements.get('location-status').textContent, /outdated/);
  assert.equal(view.state.locationFix, null);
});

test('insecure context and unsupported GPS block live requests with actionable location errors', async () => {
  for (const options of [{ secure: false }, { noGPS: true }]) {
    const view = app(options); authorised(view); await view.preparePlan();
    assert.equal(view.requests.length, 0);
    assert.equal(view.gpsCalls(), 0);
    assert.match(view.elements.get('location-status').textContent, /HTTPS|does not support location/);
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
  assert.match(view.elements.get('location-status').textContent, /Test mode/);
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
  assert.match(view.elements.get('plan-location').textContent, /saved.*40.443300.*1900.*test location.*separate/);
  assert.ok(view.requests.every((request) => request.method === 'GET'));
});

test('switching to test mode discards a late pending GPS success', async () => {
  let deliver;
  const view = app({ gps: (success) => { deliver = success; } });
  const pending = view.refreshLocation();
  await view.setLocationMode('test');
  view.elements.get('lat').value = '40'; view.elements.get('lon').value = '-79';
  deliver({ coords: { latitude: 10, longitude: 20, accuracy: 2 }, timestamp: Date.now() });
  await assert.rejects(pending, /Location mode changed/);
  assert.equal(view.state.locationMode, 'test');
  assert.equal(view.elements.get('lat').value, '40');
  assert.equal(view.state.locationFix, null);
  assert.equal(view.state.locationBusy, false);
});


test('live preparation requests Google street-view photographs and does not fall back to OSM', async () => {
  const view = app({ fetch: (url) => url === '/world-plans' ? response({ detail: 'Street View service is not configured.' }, 503) : undefined });
  authorised(view); await view.preparePlan();
  assert.equal(view.requests.length, 1);
  const payload = JSON.parse(view.requests[0].body);
  assert.equal(payload.source, 'google_streetview');
  assert.equal(payload.location_source, 'device');
  assert.match(view.elements.get('message').textContent, /not configured/);
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
  assert.match(view.elements.get('view-caption').textContent, /Street View/);
  assert.match(view.elements.get('view-details').textContent, /2024-06.*photograph/);
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
  assert.match(view.elements.get('location-status').textContent, /Location permission denied/);
});

test('photo generation separates image-edit charges from World Labs credits', () => {
  const view = app(); authorised(view); view.state.plan = plan({ input_kind: 'streetview_panorama' });
  view.applyJob({ job_id: JOB, stage: 'ready', generation_calls: { image_edit: 1, world: 1 },
    cost_credits: { depth: null, world: 150, total: 150 }, assets: [] });
  assert.match(view.elements.get('cost').textContent, /OpenAI image editing billed separately.*world: 150 credits.*total: 150 credits/);
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

test('sensor access needs a gesture; GPS course stays separate and compass orientation survives all three views', async () => {
  let permissions = 0;
  const view = app({ visibility: 'visible', orientation: { requestPermission() { permissions++; return Promise.resolve('granted'); } },
    fetch: () => response('pano') });
  authorised(view); view.state.engine = fakeEngine(); view.bindEvents();
  view.state.plan = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 264 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  view.state.job = { assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` },
    { kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  await view.showView('source');
  assert.equal(permissions, 0); view.toggleMotion(); assert.equal(permissions, 1);
  await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().phase, 'tracking');
  const before = view.state.orientation.getQuaternion().clone();
  const watch = [...view.watches.values()].find((item) => item.settings.maximumAge === 3000);
  watch.success({ coords: { heading: 90, speed: 1.4, accuracy: 8 }, timestamp: Date.now() });
  assert.match(view.elements.get('heading-readout').textContent, /View ~0°.*Travel 90°/);
  assert.ok(view.state.orientation.getQuaternion().angleTo(before) < 1e-7);
  watch.success({ coords: { heading: 90, speed: 0, accuracy: 8 }, timestamp: Date.now() });
  assert.doesNotMatch(view.elements.get('heading-readout').textContent, /Travel/);
  view.manualLook(); setCameraBearing(view.state.engine.camera, 123); view.calibrateView();
  assert.equal(view.state.calibrating, false);
  assert.equal(view.state.orientation.getStatus().compassAligning, true);
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  const aligned = view.state.orientation.getQuaternion().clone();
  assert.ok(Math.abs(headingFromQuaternion(aligned) - 90) < 1e-7);
  for (const kind of ['pano', 'world', 'source']) {
    await view.showView(kind);
    assert.equal(view.state.orientation.getStatus().enabled, true);
    assert.equal(view.state.orientation.getStatus().relativeOnly, false);
    assert.ok(view.state.orientation.getQuaternion().angleTo(aligned) < 1e-7);
    assert.ok(view.state.engine.camera.quaternion.angleTo(aligned) < 1e-7);
  }
  assert.equal(permissions, 1);
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

test('back-forward cache preserves rendering and resumes an existing motion grant without another prompt', async () => {
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
  await new Promise(setImmediate);
  assert.equal(view.state.engine, engine); assert.equal(view.state.orientation, orientation);
  assert.equal(permissions, 1);
  assert.ok([...view.timers.values()].some((timer) => timer.milliseconds === 5000));
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().phase, 'tracking');
  assert.equal(view.watches.size, 2);
  view.toggleMotion(); await new Promise(setImmediate);
  assert.equal(permissions, 1); assert.equal(view.state.orientation.getStatus().enabled, true);
  view.state.orientation.stop(); view.stopLiveLocation();
});

test('a failed panorama switch stops sensors and the location watch', async () => {
  const view = await followingPanorama({ fetch: (url) => url.endsWith('historical_panorama.jpg')
    ? response({ detail: 'Image unavailable' }, 422) : response('source') });
  view.state.job = { assets: [{ kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` }] };
  await view.showView('pano');
  assert.equal(view.state.engine.current, null);
  assert.equal(view.state.orientation.getStatus().enabled, false);
  assert.equal(view.watches.size, 0);
  assert.equal(view.state.travel, null);
  assert.equal(view.elements.get('motion-toggle').disabled, false);
  assert.equal(view.elements.get('motion-toggle').hidden, false);
});

test('queued travel callbacks cannot overwrite a new watch or restore travel after switching location mode', async () => {
  const view = await followingPanorama();
  const oldWatch = [...view.watches.values()].find((item) => item.settings.maximumAge === 3000);
  const fix = (heading) => ({ coords: { heading, speed: 1.2, accuracy: 5 }, timestamp: Date.now() });
  view.stopTravelTracking(); oldWatch.success(fix(70));
  assert.equal(view.state.travel, null);
  view.startTravelTracking();
  const newWatch = [...view.watches.values()].find((item) => item.settings.maximumAge === 3000);
  newWatch.success(fix(80));
  oldWatch.success(fix(70)); assert.equal(view.state.travel.heading, 80);
  oldWatch.failure({ code: 2 }); assert.equal(view.state.travel.heading, 80);
  view.toggleMotion();
  assert.equal(view.state.orientation.getStatus().enabled, true);
  assert.equal(view.state.travel.heading, 80);
  await view.setLocationMode('test'); newWatch.success(fix(90));
  assert.equal(view.state.travel, null); assert.equal(view.watches.size, 0);
  view.state.orientation.stop();
});


function walkingApp() {
  const commands = [];
  const view = app({ visibility: 'visible', nativeBridge: { version: 1, platform: 'ios',
    postMessage(json) { commands.push(JSON.parse(json)); } }, fetch: () => response() });
  authorised(view); view.state.engine = fakeEngine(); view.state.engine.current = new THREE.Group();
  view.state.engine.camera.position.set(10, 2, 20); view.state.engine.look = { enabled: false, pointers: new Map() };
  view.state.view = 'world'; view.elements.get('walk-mode').value = 'native'; view.bindEvents(); view.updateWalkingUI();
  const send = async (sequence, overrides = {}) => view.emitWindow('century:motion', { detail: {
    version: 1, sessionId: commands.findLast((item) => item.action === 'start').sessionId,
    sequence, timestampMs: Date.now(), state: 'tracking', position: [0, 1.6, 0], quaternion: [0, 0, 0, 1], ...overrides,
  } });
  return { ...view, commands, send };
}

test('native walking requires an explicit unknown-scale value and then owns all camera input', async () => {
  const view = walkingApp();
  assert.equal(view.commands.length, 0);
  view.startWalking();
  assert.equal(view.commands.length, 0);
  assert.match(view.elements.get('walk-status').textContent, /scale/);
  view.elements.get('walk-scale').value = '2';
  view.startWalking();
  assert.equal(view.commands.length, 1);
  assert.equal(view.nativeWalkingLocked(), true);
  assert.equal(view.elements.get('motion-toggle').disabled, true);
  assert.equal(view.elements.get('reset-view').disabled, true);
  assert.equal(view.elements.get('walk-scale').disabled, true);
  assert.equal(view.elements.get('move-pad').hidden, true);
  await view.send(1);
  assert.equal(view.applyNativeWalking(view.state.engine), true);
  const first = view.state.engine.camera.position.clone();
  view.state.keys.add('forward'); view.moveCamera(view.state.engine, 1);
  assert.ok(view.state.engine.camera.position.equals(first));
  await view.emitWindow('keydown', { code: 'KeyW', target: {}, preventDefault() {} });
  await view.moves[0].emit('pointerdown');
  assert.equal(view.state.touchMoves.size, 0);
  const side = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
  await view.send(2, { position: [0, 1.6, -.3], quaternion: side.toArray() });
  view.applyNativeWalking(view.state.engine);
  assert.ok(view.state.engine.camera.position.distanceTo(new THREE.Vector3(10, 2, 19.4)) < 1e-8);
  assert.ok(view.state.engine.controls.target.clone().sub(view.state.engine.camera.position)
    .distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-8);
  assert.equal(view.state.engine.controls.enabled, false);
  assert.equal(view.requests.length, 0);
  view.stopWalking();
  assert.equal(view.nativeWalkingLocked(), false);
});

test('provider metric scale uses one meter and ignores an obsolete manual input', async () => {
  const view = walkingApp(); view.state.engine.metric = true;
  view.elements.get('walk-scale').value = '99'; view.updateWalkingUI();
  assert.equal(view.elements.get('walk-scale').disabled, true);
  view.startWalking(); await view.send(1);
  await view.send(2, { position: [0, 1.6, -.3] }); view.applyNativeWalking(view.state.engine);
  assert.ok(view.state.engine.camera.position.distanceTo(new THREE.Vector3(10, 2, 19.7)) < 1e-8);
  view.stopWalking();
});

test('native tracking loss freezes the camera and background return never restarts tracking', async () => {
  const view = walkingApp(); view.state.engine.metric = true; view.startWalking(); await view.send(1);
  view.applyNativeWalking(view.state.engine);
  await view.send(2, { state: 'limited' });
  assert.equal(view.state.walking.getStatus().needsReanchor, true);
  assert.equal(view.elements.get('walk-reanchor').disabled, false);
  const before = view.state.engine.camera.position.clone();
  await view.send(3, { position: [3, 1.6, 0] }); view.applyNativeWalking(view.state.engine);
  assert.ok(view.state.engine.camera.position.equals(before));
  view.document.visibilityState = 'hidden'; await view.emitDocument('visibilitychange');
  view.document.visibilityState = 'visible'; await view.emitDocument('visibilitychange');
  assert.equal(view.commands.filter((item) => item.action === 'start').length, 1);
  view.stopWalking();
});

test('switching scene stops native movement and a different world clears manual scale', async () => {
  const view = walkingApp(); view.elements.get('walk-scale').value = '2'; view.startWalking(); await view.send(1);
  view.state.plan = plan({ assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  await view.showView('source');
  assert.equal(view.commands.at(-1).action, 'stop');
  assert.equal(view.nativeWalkingLocked(), false);
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  await view.showView('world');
  assert.equal(view.elements.get('walk-scale').value, '');
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
  const walking = walkingApp(); walking.state.bootReady = true; walking.state.config.streetview = { available: true };
  walking.elements.get('walk-scale').value = '2'; walking.startWalking(); await walking.send(1);
  const camera = walking.state.engine.camera.position.clone(); walking.startLiveLocation();
  [...walking.watches.values()][0].success({ coords: { latitude: 40, longitude: -79, accuracy: 5 }, timestamp: Date.now() });
  assert.equal(walking.elements.get('lat').value, '40.000000');
  assert.ok(walking.state.engine.camera.position.equals(camera)); assert.equal(walking.nativeWalkingLocked(), true);
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
  const view = liveLocationApp({ prepare: () => response({ detail: 'No nearby Street View' }, 404) });
  await view.feed(1.001, { accuracy: 100 });
  assert.equal(view.posts().length, 0); assert.match(view.elements.get('location-status').textContent, /more accurate/);
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
        if (url === '/world-plans') return fails ? response({ detail: 'No Street View' }, 404)
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

function gpsWalkingApp(options = {}) {
  const view = app({ visibility: 'visible', fetch: () => response('asset'), ...options });
  authorised(view); view.state.engine = fakeEngine(); view.state.engine.current = new THREE.Group();
  view.state.engine.camera.position.set(10, 2, 20); view.state.engine.look = { enabled: false, pointers: new Map() };
  view.state.engine.metric = true; view.state.view = 'world'; view.bindEvents();
  view.elements.get('walk-heading').value = '0';
  let time = Date.now();
  view.state.gpsWalking = createGPSWalkingController({ window: view.window, document: view.document,
    now: () => time, onChange: () => view.updateWalkingUI() });
  view.updateWalkingUI();
  const feed = (northMeters, { elapsed = 0, accuracy = 2 } = {}) => {
    time += elapsed;
    [...view.watches.values()].find((watch) => watch.settings.maximumAge === 0).success({ coords: {
      latitude: 1 + northMeters / 6371000 * 180 / Math.PI, longitude: 2, accuracy,
    }, timestamp: time });
  };
  return { ...view, feed };
}

test('GPS starts automatically after compass alignment with an estimated scale and no setup button', async () => {
  const view = gpsWalkingApp({ orientation: {} });
  view.state.engine.metric = false; view.elements.get('walk-heading').value = '';
  assert.equal(view.elements.get('walk-start').hidden, true);
  assert.equal(view.elements.get('walk-open').hidden, true);
  assert.equal(view.watches.size, 0);
  view.startAutomaticMotion(); await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.gpsWalkingLocked(), true); assert.equal(view.nativeWalkingLocked(), false);
  assert.equal(view.state.gpsWalking.getStatus().automatic, true);
  assert.equal(view.elements.get('walk-scale').value, '');
  assert.match(view.elements.get('walk-scale-note').textContent, /estimate.*1 world unit/i);
  assert.equal(view.elements.get('motion-toggle').hidden, true);
  assert.equal(view.elements.get('reset-view').disabled, true);
  const positionWatch = [...view.watches.values()].find((watch) => watch.settings.maximumAge === 0);
  assert.ok(positionWatch);
  view.feed(0); view.feed(4, { elapsed: 2000 });
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 16) < .001);
  assert.equal(view.state.engine.camera.position.y, 2);
  assert.match(view.elements.get('walking-readout').textContent, /Accuracy ~±2 m.*4.0 m/);
  assert.equal(view.requests.length, 0); view.stopWalking(); view.state.orientation.dispose();
});

test('an explicit GPS scale refinement controls displacement while missing compass data keeps walking pending', () => {
  const view = gpsWalkingApp(); view.state.engine.metric = false;
  view.elements.get('walk-scale').value = '2'; view.elements.get('walk-heading').value = '';
  view.startWalking();
  assert.match(view.elements.get('walk-status').textContent, /Waiting for compass direction/);
  assert.equal(view.watches.size, 0);
  view.elements.get('walk-heading').value = '0'; view.startWalking(); view.feed(0); view.feed(4, { elapsed: 2000 });
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 12) < .001);
  view.stopWalking();
});

test('GPS translation keeps a fixed direction through phone turns and blocks virtual movement', async () => {
  const view = gpsWalkingApp(); view.startWalking(); view.feed(0);
  const side = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
  view.state.engine.camera.quaternion.copy(side);
  view.feed(4, { elapsed: 2000 });
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 16) < .001);
  assert.ok(Math.abs(view.state.engine.camera.position.x - 10) < .001);
  assert.ok(view.state.engine.camera.quaternion.angleTo(side) < 1e-7);
  const before = view.state.engine.camera.position.clone();
  await view.emitWindow('keydown', { code: 'KeyW', target: {}, preventDefault() {} });
  await view.moves[0].emit('pointerdown'); view.state.keys.add('forward'); view.moveCamera(view.state.engine, 1);
  assert.ok(view.state.engine.camera.position.equals(before));
  assert.equal(view.state.touchMoves.size, 0);
  view.stopWalking();
  const direction = view.state.engine.controls.target.clone().sub(view.state.engine.camera.position).normalize();
  assert.ok(direction.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-7);
});

test('motion permission is a one-way enable action and cannot pause an active GPS walk', async () => {
  const view = gpsWalkingApp({ orientation: { requestPermission: async () => 'granted' } });
  view.elements.get('walk-heading').value = '';
  view.toggleMotion(); await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().physicalHeading, 0);
  assert.equal(view.gpsWalkingLocked(), true);
  const quaternion = view.state.orientation.getQuaternion().clone();
  view.toggleMotion();
  assert.equal(view.gpsWalkingLocked(), true); assert.equal(view.state.orientation.getStatus().enabled, true);
  assert.ok(view.state.orientation.getQuaternion().angleTo(quaternion) < 1e-7);
  assert.equal(view.elements.get('motion-toggle').hidden, true);
  assert.equal(view.state.engine.controls.enabled, false); assert.equal(view.state.engine.look.enabled, false);
  view.stopWalking(); view.state.orientation.dispose();
});

test('starting GPS during a phone turn uses matching sensor bearings despite render smoothing', async () => {
  const view = gpsWalkingApp({ orientation: { requestPermission: async () => 'granted' } });
  view.elements.get('walk-heading').value = '';
  view.toggleMotion(); await Promise.resolve(); await Promise.resolve();
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  assert.equal(Math.round(view.state.orientation.getStatus().physicalHeading), 90);
  assert.equal(headingFromQuaternion(view.state.engine.camera.quaternion), 0);
  view.startWalking(); view.feed(0); view.feed(4, { elapsed: 2000 });
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 16) < .001);
  assert.ok(Math.abs(view.state.engine.camera.position.x - 10) < .001);
  view.stopWalking(); view.state.orientation.dispose();
});

test('GPS waits for a fresh compass fix and resumes automatically after explicit realignment', async () => {
  const view = gpsWalkingApp({ orientation: { requestPermission: async () => 'granted' } });
  view.elements.get('walk-heading').value = '';
  view.toggleMotion(); await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.gpsWalkingLocked(), true); view.feed(0);
  const before = view.state.engine.camera.position.clone(), oldWatch = [...view.watches.values()].find((item) => item.settings.maximumAge === 0);
  view.calibrateView();
  assert.equal(view.gpsWalkingLocked(), false);
  assert.equal(view.state.orientation.getStatus().compassAligning, true);
  view.maybeStartWalking(); assert.equal(view.gpsWalkingLocked(), false);
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().compassAligning, false);
  assert.equal(view.gpsWalkingLocked(), true);
  assert.ok(Math.abs(headingFromQuaternion(view.state.orientation.getQuaternion()) - 90) < 1e-7);
  assert.ok(view.state.engine.camera.position.equals(before));
  oldWatch.success({ coords: { latitude: 50, longitude: 20, accuracy: 1 }, timestamp: Date.now() });
  assert.equal(view.state.gpsWalking.getStatus().phase, 'waiting');
  view.feed(0, { elapsed: 5 }); view.feed(4, { elapsed: 2000 });
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 16) < .001);
  assert.ok(Math.abs(view.state.engine.camera.position.x - 10) < .001);
  view.stopWalking(); view.state.orientation.dispose();
});

test('GPS rejects a stale sensor heading even if the status timer has not fired', () => {
  const view = gpsWalkingApp(); view.elements.get('walk-heading').value = '';
  view.state.orientation = { getStatus: () => ({ enabled: true, phase: 'tracking', physicalHeading: 90 }),
    getQuaternion: () => null };
  view.startWalking();
  assert.equal(view.gpsWalkingLocked(), false); assert.equal(view.watches.size, 0);
  assert.match(view.elements.get('walking-readout').textContent, /Waiting for compass direction/);
});

test('manual drag cannot override compass heading or interrupt GPS while gyroscope control is active', async () => {
  const view = gpsWalkingApp({ orientation: { requestPermission: async () => 'granted' } });
  view.elements.get('walk-heading').value = '';
  view.toggleMotion(); await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  view.feed(0);
  const quaternion = view.state.orientation.getQuaternion().clone();
  view.manualLook();
  assert.equal(view.gpsWalkingLocked(), true); assert.equal(view.state.calibrating, false);
  assert.equal(view.state.orientation.getStatus().compassAligning, false);
  assert.ok(view.state.orientation.getQuaternion().angleTo(quaternion) < 1e-7);
  view.stopWalking(); view.state.orientation.dispose();
});

test('walking diagnostics stay in settings without a setup prompt and explain filtered GPS movement', () => {
  const view = gpsWalkingApp();
  assert.equal(view.elements.get('walk-open').hidden, true);
  assert.doesNotMatch(view.elements.get('walking-readout').textContent, /Walking is off|Set up/);
  assert.match(view.elements.get('walking-readout').textContent, /automatically/);
  assert.equal(view.watches.size, 0);
  view.startWalking();
  assert.equal(view.elements.get('settings-dialog').attributes.open, undefined);
  view.feed(0, { accuracy: 10 }); view.feed(2, { elapsed: 2000, accuracy: 10 });
  view.applyGPSWalking(view.state.engine, .05);
  assert.equal(view.state.engine.camera.position.z, 20);
  assert.match(view.elements.get('walking-readout').textContent, /Movement filter: 2.0 \/ 7.0 m/);
  view.stopWalking();
});

test('GPS background return holds position and recovers from two fresh fixes without replaying old callbacks', async () => {
  const view = gpsWalkingApp(); view.startWalking(); view.feed(0);
  const watch = [...view.watches.values()][0], before = view.state.engine.camera.position.clone();
  view.document.visibilityState = 'hidden'; await view.emitDocument('visibilitychange');
  assert.equal(view.watches.size, 0);
  assert.equal(view.state.gpsWalking.getStatus().needsReanchor, false);
  assert.equal(view.state.gpsWalking.getStatus().automatic, true);
  view.document.visibilityState = 'visible'; await view.emitDocument('visibilitychange');
  watch.success({ coords: { latitude: 50, longitude: 20, accuracy: 1 }, timestamp: Date.now() });
  assert.equal(view.state.gpsWalking.getStatus().phase, 'background');
  view.feed(4, { elapsed: 2000 }); view.applyGPSWalking(view.state.engine, .1);
  assert.equal(view.state.gpsWalking.getStatus().phase, 'background');
  assert.ok(view.state.engine.camera.position.equals(before));
  view.feed(4, { elapsed: 1000 }); view.applyGPSWalking(view.state.engine, .1);
  assert.equal(view.state.gpsWalking.getStatus().phase, 'tracking');
  assert.ok(view.state.engine.camera.position.equals(before));
  view.feed(8, { elapsed: 2000 });
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 16) < .001);
  view.stopWalking();
});

test('GPS holds through a poor fix and stops when leaving the world or choosing test coordinates', async () => {
  const view = gpsWalkingApp(); view.startWalking(); view.feed(0);
  view.feed(5, { elapsed: 2000, accuracy: 100 });
  assert.equal(view.state.gpsWalking.getStatus().needsReanchor, false);
  assert.equal(view.state.gpsWalking.getStatus().enabled, true);
  assert.equal(view.elements.get('walk-reanchor').disabled, false);
  assert.equal(view.elements.get('walk-heading').disabled, true);
  view.feed(5, { elapsed: 1000, accuracy: 2 });
  assert.equal(view.state.gpsWalking.getStatus().phase, 'tracking');
  for (let frame = 0; frame < 80; frame++) view.applyGPSWalking(view.state.engine, .05);
  assert.ok(Math.abs(view.state.engine.camera.position.z - 15) < .001);
  await view.setLocationMode('test'); assert.equal(view.gpsWalkingLocked(), false);
  view.startWalking(); assert.equal(view.gpsWalkingLocked(), false);
  view.state.locationMode = 'device'; view.startWalking();
  view.state.plan = plan({ assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  await view.showView('source'); assert.equal(view.gpsWalkingLocked(), false);
  assert.equal(view.elements.get('walking-readout').hidden, true);
});

test('switching walking modes releases one owner before enabling another', async () => {
  const view = walkingApp(); view.state.engine.metric = true;
  view.startWalking(); assert.equal(view.nativeWalkingLocked(), true);
  view.elements.get('walk-mode').value = 'gps'; await view.elements.get('walk-mode').emit('change');
  assert.equal(view.nativeWalkingLocked(), false); assert.equal(view.commands.at(-1).action, 'stop');
  view.elements.get('walk-heading').value = '0'; view.startWalking(); assert.equal(view.gpsWalkingLocked(), true);
  view.elements.get('walk-mode').value = 'native'; await view.elements.get('walk-mode').emit('change');
  assert.equal(view.gpsWalkingLocked(), false);
  view.startWalking(); assert.equal(view.nativeWalkingLocked(), true); view.stopWalking();
});

test('walking settings remain reachable in webviews without native dialog methods', async () => {
  const view = app(); view.bindEvents();
  await view.elements.get('settings-open').emit('click');
  assert.equal(view.elements.get('settings-dialog').attributes.open, '');
  await view.elements.get('settings-close').emit('click');
  assert.equal(view.elements.get('settings-dialog').attributes.open, undefined);
});

test('an explicitly served LAN host obtains its own session without a pasted access code', async () => {
  for (const hostname of ['10.0.0.2', '172.26.43.152', '192.168.1.10']) {
    const view = app({ location: { hostname } });
    await view.initialiseAccess();
    assert.equal(view.state.token, TOKEN);
    assert.equal(view.elements.get('access-panel').hidden, true);
    assert.deepEqual(view.requests.map((request) => request.url), ['/app-session', '/world-session']);
    assert.equal(view.requests[0].headers.has('Authorization'), false);
  }
});

test('public and deceptive hostnames do not attempt LAN auto login; rejected LAN sessions stay locked', async () => {
  for (const hostname of ['example.test', '172.15.1.1', '172.32.1.1', '192.169.1.1', '10.256.0.1', '10.0.0.2.evil.test']) {
    const view = app({ location: { hostname } });
    await view.initialiseAccess();
    assert.equal(view.state.token, ''); assert.deepEqual(view.requests.map((request) => request.url), ['/app-session']);
  }
  const view = app({ location: { hostname: '172.26.43.152' }, fetch: () => response({}, 403) });
  await view.initialiseAccess();
  assert.equal(view.state.token, ''); assert.equal(view.elements.get('access-panel').hidden, true);
});

test('an explicit HTTPS viewer link opens the public viewer session without an access fragment', async () => {
  const view = app({ location: { hostname: 'viewer.example', search: '?viewer=1' } });
  await view.initialiseAccess();
  assert.equal(view.elements.get('access-panel').hidden, true);
  assert.deepEqual(view.requests.map((request) => request.url), ['/app-session', '/world-session']);
  assert.equal(view.requests[0].headers.has('Authorization'), false);
  assert.equal(view.rewrites.length, 0);
});

test('public viewer mode hides generation and disables generation-year changes', async () => {
  const view = app({ location: { hostname: 'viewer.example', search: '?viewer=1' }, fetch: (url) => {
    if (url === '/world-config') return response({ configured: false, viewer_only: true,
      min_year: 1800, max_year: 2026, streetview: { available: false } });
  } });
  await view.boot();
  assert.equal(view.elements.get('access-panel').hidden, true);
  assert.equal(view.elements.get('generate').hidden, true);
  assert.equal(view.elements.get('year-wheel').attributes['aria-disabled'], 'true');
  assert.ok(view.requests.every((request) => request.method === 'GET'));
});


test('iOS requests motion once on the first trusted page tap even before a scene exists', async () => {
  for (const decision of ['granted', 'denied']) {
    let permissions = 0;
    const view = app({ visibility: 'visible', orientation: {
      requestPermission() { permissions++; return Promise.resolve(decision); },
    } });
    view.bindEvents();
    view.startAutomaticMotion(); await new Promise(setImmediate);
    assert.equal(permissions, 0);
    assert.equal(view.state.engine, null);
    await view.emitDocument('click', { isTrusted: false });
    assert.equal(permissions, 0);
    await view.emitDocument('click', { isTrusted: true });
    await new Promise(setImmediate);
    assert.equal(permissions, 1);
    assert.equal(view.state.orientation.getStatus().enabled, decision === 'granted');
    await view.emitDocument('click', { isTrusted: true });
    view.startAutomaticMotion(); await new Promise(setImmediate);
    assert.equal(permissions, 1);
    assert.equal(view.elements.get('motion-toggle').hidden, decision === 'granted');
    view.state.orientation.dispose();
  }
});

test('a browser without a permission API follows motion automatically when Street View loads', async () => {
  const view = app({ visibility: 'visible', orientation: {}, fetch: () => response('pano') });
  authorised(view); view.state.engine = fakeEngine(); view.bindEvents();
  view.state.plan = plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 90 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } });
  await view.showView('source'); await new Promise(setImmediate);
  assert.equal(view.state.orientation.getStatus().enabled, true);
  assert.equal(view.state.motionGestureAttempted, false);
  assert.equal(view.elements.get('motion-toggle').hidden, true);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().mode, 'absolute');
  assert.ok(Math.abs(headingFromQuaternion(view.state.orientation.getQuaternion())) < 1e-7);
  view.state.orientation.dispose();
});

test('an explicit walking stop persists through sensor updates and background return until Resume', async () => {
  const view = gpsWalkingApp({ orientation: {} });
  view.elements.get('walk-heading').value = '';
  view.startAutomaticMotion(); await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 0, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.gpsWalkingLocked(), true);
  await view.elements.get('walk-stop').emit('click');
  assert.equal(view.state.walkAutomatic, false); assert.equal(view.gpsWalkingLocked(), false);
  assert.equal(view.elements.get('walk-start').hidden, false);
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  view.maybeStartWalking(); assert.equal(view.gpsWalkingLocked(), false);
  view.document.visibilityState = 'hidden'; await view.emitDocument('visibilitychange');
  view.document.visibilityState = 'visible'; await view.emitDocument('visibilitychange');
  await new Promise(setImmediate);
  await view.emitWindow('deviceorientation', { alpha: 270, beta: 90, gamma: 0, absolute: true });
  assert.equal(view.state.orientation.getStatus().enabled, true);
  assert.equal(view.gpsWalkingLocked(), false); assert.equal(view.state.walkAutomatic, false);
  await view.elements.get('walk-start').emit('click');
  assert.equal(view.gpsWalkingLocked(), true); assert.equal(view.state.walkAutomatic, true);
  assert.equal(view.state.gpsWalking.getStatus().automatic, true);
  view.stopWalking(); view.state.orientation.dispose(); view.stopLiveLocation();
});

test('view and sensor controls belong to settings and GPS is selected without a setup flow', () => {
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  const dialog = html.slice(html.indexOf('<dialog'), html.indexOf('</dialog>'));
  for (const id of ['motion-toggle', 'align-view', 'heading-readout', 'motion-status', 'walk-open',
    'walking-readout', 'prefetch-open', 'prefetch-readout', 'prefetch-next']) {
    assert.equal(main.includes(`id="${id}"`), false, `${id} must not cover the scene`);
    assert.equal(dialog.includes(`id="${id}"`), true, `${id} must remain available in settings`);
  }
  assert.doesNotMatch(main, /class="view-tabs"/);
  assert.match(dialog, /class="view-tabs"[\s\S]*?data-view="source"[\s\S]*?data-view="pano"[\s\S]*?data-view="world"/);
  assert.match(dialog, /value="gps" selected/);
  assert.doesNotMatch(dialog, /Pause motion|Set up walking|Walking is off/);
  const standalone = app(); standalone.bindEvents(); standalone.renderPlan(plan());
  assert.equal(standalone.elements.get('view-tabs').hidden, false);
  assert.equal(standalone.elements.get('source-toggle').hidden, true);
});

test('an east-facing source panorama rotates provider world axes into real east and north', async () => {
  const view = app({ fetch: () => response() }); authorised(view); view.state.engine = fakeEngine();
  view.state.plan = plan({ source_panorama: { metadata: { heading: 90 } } });
  view.state.job = { assets: [{ kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  await view.showView('world');
  const geographic = view.state.engine.current, splat = geographic.children[0].children[0];
  geographic.updateMatrixWorld(true);
  // The panorama's forward ray (+Z in provider coordinates) points east.
  const east = new THREE.Vector3(0, 0, 1).transformDirection(splat.matrixWorld);
  assert.ok(east.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-7);
  // Its left ray (-X) points north, matching the compass camera's north ray.
  const north = new THREE.Vector3(-1, 0, 0).transformDirection(splat.matrixWorld);
  assert.ok(north.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-7);
  assert.ok(Math.abs(cameraBearing(view.state.engine.camera).heading - 90) < 1e-7);
  setCameraBearing(view.state.engine.camera, 0);
  assert.ok(view.state.engine.camera.getWorldDirection(new THREE.Vector3()).distanceTo(north) < 1e-7);
});


function hostMessage(view, data = {}, envelope = {}) {
  return view.receiveHostState({ source: view.parent, origin: 'https://example.test',
    data: { type: 'century:host-state', active: true, mode: 'streetview', year: 1926, ...data }, ...envelope });
}

for (const [mode, kind, filename, expectedView] of [
  ['streetview', 'historical_pano', 'historical_panorama.jpg', 'pano'],
  ['world', 'spz', 'scene.spz', 'world'],
]) {
  test(`saved ${mode} opens and switches tabs while the browser never answers GPS`, async () => {
    const assetURL = `/world-jobs/${JOB}/assets/${filename}`;
    const view = app({ visibility: 'visible',
      location: { search: `?embedded=1&world=${JOB}`, hostname: 'localhost' },
      gps() {}, fetch: (url) => {
        if (url === `/world-jobs/${JOB}`) return response({ job_id: JOB, plan_id: PLAN, stage: 'ready',
          assets: [{ kind, url: assetURL }] });
        if (url === `/world-plans/${PLAN}`) return response(plan({ input_kind: 'streetview_panorama' }));
        if (url === assetURL) return response('saved asset');
      } });
    view.state.engine = fakeEngine();
    await view.boot();
    let settled = false;
    const loading = hostMessage(view, { mode }).then(() => { settled = true; });
    await new Promise(setImmediate);
    assert.equal(settled, true, 'viewer boot must not depend on a location permission response');
    await loading;
    assert.equal(view.state.view, expectedView);
    assert.ok(view.state.engine.current);
    assert.equal(view.state.locationBusy, true);
    assert.ok(view.requests.some((request) => request.url === assetURL));
    assert.ok(view.requests.every((request) => request.method === 'GET'
      || mode === 'streetview' && request.method === 'POST' && request.url === `/world-jobs/${JOB}/hotspots`));
    await hostMessage(view, { active: false, mode: 'camera' });
    assert.equal(view.state.active, false);
    view.stopLiveLocation();
  });
}

test('invalid Street View setup is explained on the scene while GPS permission is pending', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1', hostname: 'localhost' },
    gps() {}, fetch: (url) => url === '/world-config' ? response({ configured: true,
      streetview: { configured: false, available: false, ai_authorized: true, error_code: 'invalid_key' } }) : undefined });
  await view.boot();
  void hostMessage(view);
  await new Promise(setImmediate);
  assert.match(view.elements.get('streetview-status').textContent, /credentials.*invalid format/i);
  assert.match(view.elements.get('message').textContent, /credentials.*invalid format/i);
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 0);
  view.stopLiveLocation();
});

test('embedded boot waits for the same-origin parent and never requests resources in hidden host modes', async () => {
  let motionPermissions = 0;
  const view = app({ visibility: 'visible', location: { search: '?embedded=1', hostname: 'localhost' },
    orientation: { requestPermission() { motionPermissions++; return Promise.resolve('granted'); } } });
  await view.boot();
  assert.equal(view.requests.length, 0); assert.equal(view.gpsCalls(), 0); assert.equal(view.watches.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(view.parentMessages)), [
    { data: { type: 'century:world-ready' }, origin: 'https://example.test' }]);
  await hostMessage(view, {}, { source: {} });
  await hostMessage(view, {}, { origin: 'https://untrusted.test' });
  await hostMessage(view, { year: '1926' });
  await hostMessage(view, { active: true, mode: 'camera' });
  await view.emitDocument('click', { isTrusted: true });
  await view.generateForYear(); await view.togglePrefetch();
  assert.equal(view.requests.length, 0); assert.equal(view.gpsCalls(), 0); assert.equal(motionPermissions, 0);
  await hostMessage(view);
  assert.equal(view.state.bootReady, true); assert.equal(view.elements.get('year').value, '1926');
  assert.equal(view.gpsCalls(), 1); assert.equal(motionPermissions, 0);
  assert.ok(view.requests.some((request) => request.url === '/world-config'));
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 0);
  view.stopLiveLocation();
});

test('host can supply access in a trusted message before boot without putting it in a URL', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' } });
  await view.boot(); await hostMessage(view, { access: TOKEN });
  assert.equal(view.state.token, TOKEN);
  assert.ok(view.requests.some((request) => request.url === PROBE && request.headers.get('Authorization') === `Bearer ${TOKEN}`));
  assert.ok(view.requests.every((request) => !request.url.includes(TOKEN)));
  assert.ok(view.rewrites.every((rewrite) => !String(rewrite[2]).includes(TOKEN)));
  assert.equal(view.elements.get('access').value, '');
  view.stopLiveLocation();
});

test('embedded Street View has an explicit image-only action without enabling paid walking or a world provider', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' }, fetch: (url) => url === '/world-jobs'
    ? response({ id: JOB, plan_id: PLAN, kind: 'panorama', stage: 'queued', assets: [] }) : undefined });
  authorised(view); view.state.active = true;
  view.state.config = { configured: false, panorama_editor_configured: true };
  view.renderPlan(plan({ target_year: 1926, input_kind: 'streetview_panorama' }));
  view.elements.get('year').value = '1926';
  await view.generateForYear(); await view.generateForYear();
  const posts = view.requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { plan_id: PLAN, kind: 'panorama' });
  assert.equal(view.state.prefetchEnabled, false);
  assert.equal(view.state.mode, 'streetview');
});

test('world generation reuses the completed panorama plan and only follows an explicit action', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' }, fetch: (url) => url === '/world-jobs'
    ? response({ id: JOB, plan_id: PLAN, kind: 'world', stage: 'queued', model: 'marble-1.1', assets: [] }) : undefined });
  authorised(view); view.state.active = true; view.state.mode = 'world';
  view.state.plan = plan({ target_year: 1926, input_kind: 'streetview_panorama' });
  view.elements.get('year').value = '1926';
  view.state.job = { id: JOB, plan_id: PLAN, kind: 'panorama', stage: 'ready', assets: [] };
  assert.equal(view.requests.length, 0);
  await view.generateForYear();
  const posts = view.requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), { plan_id: PLAN, model: 'marble-1.1' });
});

test('embedded world completion respects Street View selection and never asks the host to switch tabs', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' }, fetch: () => response('asset') });
  authorised(view); view.state.active = true; view.state.bootReady = true; view.state.engine = fakeEngine();
  view.state.plan = plan({ target_year: 1926, input_kind: 'streetview_panorama' });
  view.applyJob({ id: JOB, stage: 'ready', assets: [
    { kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` },
    { kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] });
  await new Promise(setImmediate);
  assert.equal(view.state.view, 'pano');
  assert.equal(view.state.engine.current.userData.kind, 'panorama');
  assert.equal(view.requests.some((request) => request.url.endsWith('scene.spz')), false);
  assert.deepEqual(JSON.parse(JSON.stringify(view.parentMessages.map((message) => message.data))), [
    { type: 'century:world-state', jobId: JOB }]);
  const object = view.state.engine.current;
  view.state.active = false;
  view.applyJob({ ...view.state.job });
  await new Promise(setImmediate);
  assert.equal(view.state.engine.current, object); assert.equal(view.parentMessages.length, 1);
});

test('outer tab suspension stops sensors, GPS, render and speculation while retaining assets and job polling', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1', hostname: 'localhost' },
    orientation: {}, fetch: (url) => url.startsWith('/world-jobs/') ? response('pano') : undefined });
  await view.boot(); await hostMessage(view);
  view.state.engine = fakeEngine(); view.state.engine.current = new THREE.Group();
  view.state.engine.look = { enabled: true, pointers: new Map() };
  const loops = []; view.state.engine.frame = () => {};
  view.state.engine.renderer.setAnimationLoop = (frame) => loops.push(frame);
  view.state.view = 'pano'; view.state.plan = plan({ target_year: 1926, input_kind: 'streetview_panorama' });
  view.applyJob({ id: JOB, stage: 'generating_world', assets: [] });
  const object = view.state.engine.current;
  const contexts = []; view.state.prefetchEnabled = true;
  view.state.config.prefetch = { available: true };
  view.state.prefetch = { setContext: (context) => contexts.push(context) };
  view.state.keys.add('forward'); view.state.touchMoves.add('right');
  await hostMessage(view, { active: false, mode: 'photo' });
  assert.equal(view.state.active, false); assert.equal(view.watches.size, 0);
  assert.equal(view.state.orientation.getStatus().enabled, false);
  assert.equal(loops.at(-1), null); assert.equal(contexts.at(-1).active, false);
  assert.equal(view.state.engine.current, object);
  assert.equal(view.state.keys.size + view.state.touchMoves.size, 0);
  const before = view.requests.length;
  await view.emitDocument('click', { isTrusted: true });
  await view.emitWindow('focus'); await view.maybePrepareCurrent(); await view.togglePrefetch();
  assert.equal(view.requests.length, before); assert.equal(view.watches.size, 0);
  await hostMessage(view);
  assert.equal(loops.at(-1), view.state.engine.frame);
  assert.equal(view.state.engine.current, object);
  view.stopLiveLocation(); view.state.orientation.stop();
});

test('global target-year updates do not relabel existing historical assets or echo back to the host', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1', hostname: 'localhost' } });
  await view.boot(); await hostMessage(view);
  view.state.plan = plan({ target_year: 1926 });
  view.state.view = 'pano'; view.state.engine = fakeEngine(); view.state.engine.current = new THREE.Group();
  view.elements.get('view-caption').textContent = '1926 · Reimagined panorama';
  const messages = view.parentMessages.length;
  await hostMessage(view, { year: 1950 });
  assert.equal(view.elements.get('year').value, '1950');
  assert.equal(view.elements.get('view-caption').textContent, '1926 · Reimagined panorama');
  assert.match(view.elements.get('selected-year-note').textContent, /Viewing 1926.*1950 selected/);
  assert.equal(view.parentMessages.length, messages);
  view.state.yearWheel.setValue(1970, { emit: true });
  assert.equal(view.parentMessages.length, messages + 1);
  assert.equal(view.parentMessages.at(-1).data.type, 'century:world-state');
  assert.equal(view.parentMessages.at(-1).data.year, 1970);
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 0);
  view.stopLiveLocation();
});

test('returning from panorama to the same world preserves its camera position', async () => {
  const view = app({ visibility: 'visible', fetch: () => response('asset') });
  authorised(view); view.state.engine = fakeEngine();
  view.state.plan = plan({ target_year: 1926 });
  view.state.job = { id: JOB, stage: 'ready', assets: [
    { kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` },
    { kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  await view.showView('world');
  view.state.engine.camera.position.set(7, 2, -4);
  setCameraBearing(view.state.engine.camera, 123, 10);
  view.state.engine.controls.target.copy(view.state.engine.camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(view.state.engine.camera.quaternion));
  const position = view.state.engine.camera.position.clone(), quaternion = view.state.engine.camera.quaternion.clone();
  await view.showView('pano'); await view.showView('world');
  assert.ok(view.state.engine.camera.position.equals(position));
  assert.ok(view.state.engine.camera.quaternion.angleTo(quaternion) < 1e-7);
});


test('leaving an embedded mode while its new location loads prevents a later paid submission', async () => {
  let releasePlan;
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' }, fetch: (url) => url === '/world-plans'
    ? new Promise((resolve) => { releasePlan = () => resolve(response(plan({ target_year: 1950, input_kind: 'streetview_panorama' }))); })
    : undefined });
  authorised(view); view.state.active = true; view.state.plan = plan();
  view.elements.get('year').value = '1950';
  const starting = view.generateForYear();
  for (let i = 0; i < 20 && !releasePlan; i++) await Promise.resolve();
  assert.ok(releasePlan);
  await hostMessage(view, { active: false, mode: 'photo', year: 1950 });
  releasePlan(); await starting;
  assert.equal(view.requests.filter((request) => request.url === '/world-jobs' && request.method === 'POST').length, 0);
  assert.equal(view.watches.size, 0); assert.equal(view.state.active, false);
});

test('switching embedded modes or global year never submits paid jobs and deliberate local navigation asks the host', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1', hostname: 'localhost' },
    fetch: (url) => url.startsWith('/world-jobs/') ? response('asset') : undefined });
  await view.boot(); await hostMessage(view);
  view.state.engine = fakeEngine();
  view.state.plan = plan({ target_year: 1926 });
  view.state.job = { id: JOB, stage: 'ready', assets: [
    { kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` },
    { kind: 'spz', url: `/world-jobs/${JOB}/assets/scene.spz` }] };
  await hostMessage(view, { mode: 'world' }); assert.equal(view.state.view, 'world');
  await hostMessage(view, { mode: 'streetview', year: 1950 }); assert.equal(view.state.view, 'pano');
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 0);
  const before = view.parentMessages.length;
  await view.tabs.find((tab) => tab.dataset.view === 'world').emit('click');
  assert.equal(view.state.mode, 'streetview');
  assert.equal(view.parentMessages.length, before + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(view.parentMessages.at(-1).data)), { type: 'century:request-mode', mode: 'world' });
  view.stopLiveLocation();
});


test('replacing and clearing an embedded saved job publishes link metadata without hidden year or mode changes', () => {
  const replacement = '33333333333333333333333333333333';
  const view = app({ location: { search: `?embedded=1&world=${JOB}` } });
  authorised(view); view.state.active = true;
  view.setJobURL(JOB);
  view.state.active = false;
  view.applyJob({ id: replacement, stage: 'generating_world', assets: [] });
  view.applyJob({ id: replacement, stage: 'ready', assets: [] });
  assert.match(view.rewrites.at(-1)[2], new RegExp(`world=${replacement}`));
  assert.equal(view.parentMessages.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(view.parentMessages.at(-1).data)), {
    type: 'century:world-state', jobId: replacement });
  view.setJobURL(); view.setJobURL();
  assert.equal(view.parentMessages.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(view.parentMessages.at(-1).data)), {
    type: 'century:world-state', jobId: null });
  assert.doesNotMatch(view.rewrites.at(-1)[2], /world=/);
  assert.equal(view.state.active, false);
});


test('embedded generation settings describe image-only Street View and restore world quality in the world tab', () => {
  const view = app({ location: { search: '?embedded=1' } });
  authorised(view); view.state.active = true;
  const sourcePlan = plan({ target_year: 1926, input_kind: 'streetview_panorama' });
  view.renderPlan(sourcePlan);
  assert.equal(view.elements.get('view-tabs').hidden, true);
  assert.equal(view.elements.get('source-toggle').hidden, true);
  assert.equal(view.elements.get('world-model-control').hidden, true);
  assert.match(view.elements.get('generation-quality').textContent, /Image editing.*no World Labs world-generation credits.*Immersive World tab/);
  assert.doesNotMatch(view.elements.get('generation-quality').textContent, /1,500|1,500 credits|quality selected above/);
  assert.match(view.elements.get('generation-description').textContent, /360° image/);
  assert.doesNotMatch(view.elements.get('generation-description').textContent, /then World Labs/);
  view.state.job = { id: JOB, kind: 'world', model: 'marble-1.0-draft', stage: 'ready', assets: [] };
  view.renderPlan(sourcePlan);
  assert.match(view.elements.get('job-quality').textContent, /Existing world job.*Quick draft/);
  assert.equal(view.elements.get('world-model-control').hidden, true);
  view.state.mode = 'world'; view.renderPlan(sourcePlan);
  assert.equal(view.elements.get('view-tabs').hidden, true);
  assert.equal(view.elements.get('source-toggle').hidden, true);
  assert.equal(view.elements.get('world-model-control').hidden, false);
  assert.match(view.elements.get('generation-quality').textContent, /Current job: Quick draft/);
  assert.match(view.elements.get('generation-description').textContent, /then World Labs generates a 3D world/);
  assert.doesNotMatch(view.elements.get('job-quality').textContent, /Existing world job/);
  view.state.job = null; view.renderPlan(sourcePlan);
  assert.match(view.elements.get('generation-quality').textContent, /1,500 credits/);
});

test('Street View original comparison preserves its tab and heading without generating', async () => {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' }, fetch: () => response('asset') });
  authorised(view); view.state.active = true; view.bindEvents(); view.state.engine = fakeEngine();
  view.renderPlan(plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 90 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` },
  }));
  view.state.job = { id: JOB, stage: 'ready', assets: [
    { kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` },
  ] };
  await view.showView('pano');
  const toggle = view.elements.get('source-toggle');
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.textContent, 'Show original Street View');
  setCameraBearing(view.state.engine.camera, 137);
  await toggle.emit('click');
  assert.equal(view.state.view, 'source');
  assert.equal(view.state.sourceSelected, true);
  assert.ok(Math.abs(cameraBearing(view.state.engine.camera).heading - 137) < 1e-6);
  assert.equal(toggle.textContent, 'Return to historical panorama');
  assert.equal(toggle.disabled, false);
  await toggle.emit('click');
  assert.equal(view.state.view, 'pano');
  assert.equal(view.state.sourceSelected, false);
  assert.ok(Math.abs(cameraBearing(view.state.engine.camera).heading - 137) < 1e-6);
  assert.equal(view.state.mode, 'streetview');
  assert.equal(view.parentMessages.length, 0);
  assert.equal(view.requests.filter((request) => request.method === 'POST' && request.url === '/world-jobs').length, 0);
});

const WHITE_DOTS = { revision: 'a'.repeat(64), provisional: false, fallback: false, items: [
  { id: 'h0', label: 'Stone facade', point: [.5, .5], bbox: [.45, .4, .55, .6] },
] };

async function streetDots(options = {}) {
  const view = app({ visibility: 'visible', location: { search: '?embedded=1' },
    fetch: (url, init) => options.fetch?.(url, init) ?? response(url.endsWith('/hotspots') ? WHITE_DOTS : 'asset'),
  });
  authorised(view); view.state.active = true; view.bindEvents(); view.state.engine = fakeEngine();
  view.renderPlan(plan({ input_kind: 'streetview_panorama', source_panorama: { metadata: { heading: 90 } },
    assets: { 'source_panorama.jpg': `/world-plans/${PLAN}/assets/source_panorama.jpg` } }));
  view.state.job = { id: JOB, plan_id: PLAN, assets: [
    { kind: 'historical_pano', url: `/world-jobs/${JOB}/assets/historical_panorama.jpg` } ] };
  await view.showView('pano'); await new Promise(setImmediate);
  return view;
}

test('Street View dots project on the panorama and explain its saved year with authenticated text-only content', async () => {
  const view = await streetDots({ fetch: (url) => url.endsWith('/explain') ? response({
    label: '<img onerror=alert(1)>', distinctive: 'Cut stone', past: 'A classroom facade', uncertainty: 'Identity unverified',
  }) : undefined });
  const layer = view.elements.get('street-hotspot-layer'), dot = layer.children[0];
  assert.equal(layer.hidden, false); assert.equal(dot.hidden, false);
  assert.ok(Math.abs(parseFloat(dot.style.left) - 50) < 1e-6);
  view.elements.get('year').value = '2026';
  await dot.emit('click'); await new Promise(setImmediate);
  assert.equal(view.elements.get('street-hotspot-kicker').textContent, 'Around 1925');
  assert.equal(view.elements.get('street-hotspot-title').textContent, '<img onerror=alert(1)>');
  assert.equal(view.elements.get('street-hotspot-body').children.length, 2);
  const request = view.requests.find((request) => request.url.endsWith('/explain'));
  assert.equal(request.headers.get('Authorization'), `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(request.body), { hotspot_id: 'h0', revision: WHITE_DOTS.revision });
  setCameraBearing(view.state.engine.camera, 270); view.state.hotspots.update();
  assert.equal(dot.hidden, true);
  await view.elements.get('street-hotspot-close').emit('click');
  assert.equal(view.elements.get('street-hotspot-card').hidden, true);
});

test('original comparison and a new location clear dots and discard late explanations', async () => {
  let release;
  const view = await streetDots({ fetch: (url) => url.endsWith('/explain')
    ? new Promise((resolve) => { release = () => resolve(response({ label: 'Old place' })); }) : undefined });
  await view.elements.get('street-hotspot-layer').children[0].emit('click');
  await view.showView('source');
  assert.equal(view.elements.get('street-hotspot-layer').hidden, true);
  assert.equal(view.elements.get('street-hotspot-card').hidden, true);
  const pending = view.requests.find((request) => request.url.endsWith('/explain'));
  assert.equal(pending.signal.aborted, true);
  release(); await new Promise(setImmediate);
  assert.notEqual(view.elements.get('street-hotspot-title').textContent, 'Old place');
  await view.showView('pano'); await new Promise(setImmediate);
  assert.equal(view.elements.get('street-hotspot-layer').hidden, false);
  view.renderPlan(plan({ plan_id: '33333333-3333-3333-3333-333333333333', input_kind: 'streetview_panorama' }));
  assert.equal(view.elements.get('street-hotspot-layer').hidden, true);
});

test('late detection cannot add dots to a hidden tab, and refinement polls stop in the background', async () => {
  let release;
  const view = await streetDots({ fetch: (url) => url.endsWith('/hotspots')
    ? new Promise((resolve) => { release = () => resolve(response({ ...WHITE_DOTS, provisional: true })); }) : undefined });
  await view.receiveHostState({ source: view.parent, origin: 'https://example.test', data: {
    type: 'century:host-state', active: false, mode: 'photo', year: 1925,
  } });
  release(); await new Promise(setImmediate);
  assert.equal(view.elements.get('street-hotspot-layer').hidden, true);
  assert.equal([...view.timers.values()].some((timer) => timer.milliseconds === 1500), false);

  const refining = await streetDots({ fetch: (url) => url.endsWith('/hotspots')
    ? response({ ...WHITE_DOTS, provisional: true }) : undefined });
  assert.equal([...refining.timers.values()].some((timer) => timer.milliseconds === 1500), true);
  refining.document.visibilityState = 'hidden'; await refining.emitDocument('visibilitychange');
  assert.equal(refining.elements.get('street-hotspot-layer').hidden, true);
  assert.equal([...refining.timers.values()].some((timer) => timer.milliseconds === 1500), false);
});

test('white dot requests can be retried after failure and refinement replaces provisional regions', async () => {
  let attempts = 0;
  const view = await streetDots({ fetch: (url, init) => {
    if (!url.endsWith('/hotspots')) return;
    if (++attempts === 1) return response({ detail: 'Unavailable' }, 503);
    if (init.method === 'POST') return response({ ...WHITE_DOTS, provisional: true });
    return response({ ...WHITE_DOTS, revision: 'b'.repeat(64), items: [{ ...WHITE_DOTS.items[0], label: 'Updated detail' }] });
  } });
  assert.match(view.elements.get('street-hotspot-hint').textContent, /retry/);
  await view.elements.get('street-hotspot-hint').emit('click'); await new Promise(setImmediate);
  const timer = [...view.timers.values()].find((timer) => timer.milliseconds === 1500);
  timer.callback(); await new Promise(setImmediate);
  assert.equal(view.elements.get('street-hotspot-layer').children[0].children[0].textContent, 'Updated detail');
});

test('Street View waits for grounded detections and never renders old fallback regions', async () => {
  for (const data of [
    { ...WHITE_DOTS, items: [], provisional: true, status: 'detecting', progress: { completed: 0, total: 6 } },
    { ...WHITE_DOTS, fallback: true, status: 'error', retryable: true },
  ]) {
    const view = await streetDots({ fetch: (url) => url.endsWith('/hotspots') ? response(data) : undefined });
    assert.equal(view.elements.get('street-hotspot-layer').children.length, 0);
    assert.equal(view.elements.get('street-hotspot-layer').hidden, true);
    const hint = view.elements.get('street-hotspot-hint');
    if (data.provisional) {
      assert.match(hint.textContent, /Finding.*0\/6/);
      assert.equal(hint.disabled, true);
      const count = view.requests.length;
      await hint.emit('click'); await new Promise(setImmediate);
      assert.equal(view.requests.length, count);
    } else {
      assert.match(hint.textContent, /retry/);
      assert.equal(hint.disabled, false);
      assert.equal([...view.timers.values()].some((timer) => timer.milliseconds === 1500), false);
    }
  }
});

test('additional Street View directions keep a selected dot and its in-flight explanation', async () => {
  let attempts = 0, release;
  const item = { ...WHITE_DOTS.items[0], revision: 'c'.repeat(64) };
  const view = await streetDots({ fetch: (url) => {
    if (url.endsWith('/explain')) return new Promise((resolve) => {
      release = () => resolve(response({ label: item.label, distinctive: 'Carved stone trim' }));
    });
    if (!url.endsWith('/hotspots')) return;
    if (++attempts === 1) return response({ ...WHITE_DOTS, items: [item], provisional: true, status: 'detecting' });
    return response({ ...WHITE_DOTS, revision: 'b'.repeat(64), status: 'ready', items: [item,
      { ...item, id: 'h6', label: 'Timber door', point: [.52, .55], revision: 'd'.repeat(64) }] });
  } });
  const layer = view.elements.get('street-hotspot-layer'), dot = layer.children[0];
  await dot.emit('click'); await new Promise(setImmediate);
  const request = view.requests.find((request) => request.url.endsWith('/explain'));
  assert.equal(JSON.parse(request.body).revision, item.revision);
  const [id, timer] = [...view.timers].find(([, timer]) => timer.milliseconds === 1500);
  view.timers.delete(id); timer.callback(); await new Promise(setImmediate);
  assert.equal(layer.children.length, 2);
  assert.equal(layer.children[0], dot);
  assert.equal(dot.attributes['aria-pressed'], 'true');
  assert.equal(view.elements.get('street-hotspot-card').hidden, false);
  assert.equal(request.signal.aborted, false);
  release(); await new Promise(setImmediate);
  assert.equal(view.elements.get('street-hotspot-body').children[0].children[1].textContent, 'Carved stone trim');
  assert.equal([...view.timers.values()].some((timer) => timer.milliseconds === 1500), false);
});

test('partial Street View detections retain real dots and offer explicit retry without a request loop', async () => {
  let attempts = 0;
  const view = await streetDots({ fetch: (url) => url.endsWith('/hotspots') ? response(++attempts === 1
    ? { ...WHITE_DOTS, status: 'partial', retryable: true }
    : { ...WHITE_DOTS, status: 'detecting', provisional: true, progress: { completed: 4, total: 6 } }) : undefined });
  const hint = view.elements.get('street-hotspot-hint'), layer = view.elements.get('street-hotspot-layer');
  const dot = layer.children[0];
  assert.match(hint.textContent, /retry the rest/);
  assert.equal(hint.disabled, false);
  assert.equal([...view.timers.values()].some((timer) => timer.milliseconds === 1500), false);
  await hint.emit('click'); await new Promise(setImmediate);
  assert.equal(attempts, 2);
  assert.equal(view.requests.at(-1).method, 'POST');
  assert.equal(layer.children[0], dot);
  assert.equal(layer.hidden, false);
  assert.match(hint.textContent, /Finding.*4\/6/);
  assert.equal(hint.disabled, true);
  assert.equal([...view.timers.values()].some((timer) => timer.milliseconds === 1500), true);
});


test('host mode changes update generation settings immediately while initial config and GPS are pending', async () => {
  let releaseConfig, releaseGPS;
  const view = app({ visibility: 'visible', location: { search: '?embedded=1', hostname: 'localhost' },
    gps(success) { releaseGPS = () => success({ coords: { latitude: 1, longitude: 2, accuracy: 12 }, timestamp: Date.now() }); },
    fetch: (url) => url === '/world-config' ? new Promise((resolve) => {
      releaseConfig = () => resolve(response({ configured: true, min_year: 1800, max_year: 2026 }));
    }) : undefined });
  await view.boot();
  const first = hostMessage(view);
  assert.ok(releaseConfig); assert.ok(releaseGPS); assert.equal(view.state.bootReady, false);
  await view.elements.get('settings-open').emit('click');
  assert.equal(view.elements.get('settings-dialog').attributes.open, '');
  assert.equal(view.elements.get('world-model-control').hidden, true);
  const switching = hostMessage(view, { mode: 'world' });
  assert.equal(view.state.bootReady, false);
  assert.equal(view.elements.get('world-model-control').hidden, false);
  assert.match(view.elements.get('generation-quality').textContent, /1,500 credits/);
  assert.match(view.elements.get('generation-description').textContent, /then World Labs generates a 3D world/);
  assert.equal(view.elements.get('settings-dialog').attributes.open, undefined);
  await view.elements.get('settings-open').emit('click');
  const changingYear = hostMessage(view, { mode: 'world', year: 1950 });
  assert.equal(view.elements.get('settings-dialog').attributes.open, '');
  assert.equal(view.elements.get('year').value, '1950');
  releaseConfig(); releaseGPS(); await Promise.all([first, switching, changingYear]);
  assert.equal(view.state.bootReady, true);
  assert.equal(view.elements.get('world-model-control').hidden, false);
  view.stopLiveLocation();
});
