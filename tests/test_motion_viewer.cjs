const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// Run the shipping scripts without test-only exports. This is an event/DOM
// contract test; real sensor availability and browser permission prompts still
// require a physical phone. Images, networking, clocks and layout are fixtures.
function viewer({ ios = false, permissions = ['granted'], touch = true, secure = true } = {}) {
  const pending = [], elements = [], ids = new Map(), raf = new Map(), timers = new Map();
  let nextHandle = 1, now = 0, permissionCalls = 0;
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatch(type, detail = {}) {
      const event = { type, target: this, button: 0, cancelable: true, preventDefault() {}, stopPropagation() {}, ...detail };
      for (const callback of [...(this.listeners.get(type) || [])]) {
        const result = callback(event);
        if (result?.then) pending.push(result);
      }
    }
    count(type) { return this.listeners.get(type)?.size || 0; }
  }
  class Element extends Events {
    constructor(tag = 'div', attrs = '') {
      super(); this.tagName = tag.toUpperCase(); this.attributes = new Map();
      for (const match of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) this.attributes.set(match[1], match[2]);
      this.id = this.attributes.get('id') || '';
      this.dataset = {};
      for (const [name, value] of this.attributes) if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
      const classes = new Set((this.attributes.get('class') || '').split(/\s+/));
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force = !classes.has(name)) => { if (force) classes.add(name); else classes.delete(name); return force; },
      };
      this.style = { setProperty(name, value) { this[name] = value; } };
      this.hidden = /\shidden(?:\s|>|$)/.test(attrs); this.open = false; this.disabled = false;
      this.clientWidth = 390; this.clientHeight = 844;
      this.naturalWidth = 1536; this.naturalHeight = 1024;
      this.value = ''; this.children = []; this.capture = new Set();
      if (this.id) ids.set(this.id, this);
      elements.push(this);
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches(selector) {
      return selector.split(',').some((part) => {
        const s = part.trim();
        if (s.startsWith('#')) return this.id === s.slice(1);
        if (s.startsWith('.')) return this.classList.contains(s.slice(1));
        if (s === '[data-year]') return 'year' in this.dataset;
        return this.tagName.toLowerCase() === s;
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelector(selector) { return this.children.find((child) => child.matches(selector)) || null; }
    appendChild(child) { this.children.push(child); child.parent = this; }
    get firstElementChild() { return this.children[0] ||= new Element('span'); }
    get lastElementChild() { return this.children.at(-1) || this.firstElementChild; }
    set innerHTML(value) {
      this._html = value; this.children = [];
      if (/<img\b/.test(value)) this.appendChild(new Element('img'));
    }
    get innerHTML() { return this._html || ''; }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    checkValidity() { return true; }
    getBoundingClientRect() { return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture(id) { this.capture.add(id); }
    hasPointerCapture(id) { return this.capture.has(id); }
    releasePointerCapture(id) { this.capture.delete(id); }
    getContext() { return { drawImage() {}, fillRect() {} }; }
  }
  const html = readFileSync(require.resolve('../web/index.html'), 'utf8');
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) new Element(match[1], match[2]);
  const document = new Events();
  document.body = elements.find((element) => element.tagName === 'BODY');
  document.hidden = false;
  document.getElementById = (id) => { assert.ok(ids.has(id), `actual HTML must contain #${id}`); return ids.get(id); };
  document.querySelectorAll = (selector) => elements.filter((element) => element.matches(selector === '#year-options [data-year]' ? '[data-year]' : selector));
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null;
  document.createElement = (tag) => new Element(tag);
  const window = new Events();
  window.isSecureContext = secure; window.scrollTo = () => {};
  window.screen = { orientation: new Events() };
  window.DeviceOrientationEvent = class {};
  if (ios) window.DeviceOrientationEvent.requestPermission = () => {
    permissionCalls++;
    const response = permissions[Math.min(permissionCalls - 1, permissions.length - 1)];
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  const storage = new Map();
  const requests = [];
  const manifest = { job_id: 'motion-test', status: 'running', target_year: 1925, place: 'Pittsburgh', provider: 'demo', geometry: { W: 3000, H: 750, wrap: false, n: 1 }, tiles: [], metrics: {} };
  const context = vm.createContext({
    console, document, window, navigator: { onLine: true, maxTouchPoints: touch ? 5 : 0 },
    matchMedia: (query) => ({ matches: query.includes('pointer: coarse') ? touch : false }),
    location: { search: '', pathname: '/' }, history: { replaceState() {} },
    URL: { createObjectURL: () => 'blob:motion-fixture', revokeObjectURL() {} }, URLSearchParams,
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Image: class { constructor() { this.naturalWidth = 3000; this.naturalHeight = 750; } set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); } },
    FormData: class { append() {} }, ResizeObserver: class { observe() {} },
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || 'GET' });
      const body = url === '/health' ? { configured: true, provider: 'demo', min_year: 1800, max_year: 2026, default_year: 1920 } : url === '/jobs' ? { job_id: manifest.job_id } : url.endsWith('/manifest') ? manifest : [];
      return { ok: true, json: async () => body, blob: async () => ({}) };
    },
    setTimeout: (callback, delay = 0) => { const handle = nextHandle++; timers.set(handle, { callback, due: now + delay }); return handle; },
    clearTimeout: (handle) => timers.delete(handle),
    requestAnimationFrame: (callback) => { const handle = nextHandle++; raf.set(handle, callback); return handle; },
    cancelAnimationFrame: (handle) => raf.delete(handle), performance: { now: () => now },
  });
  for (const script of ['motion.js', 'app.js']) vm.runInContext(readFileSync(require.resolve(`../web/${script}`), 'utf8'), context, { filename: script });
  const api = {
    element: (id) => ids.get(id), document, window, requests,
    permissionCalls: () => permissionCalls,
    click: (id) => ids.get(id).click(),
    frames(count = 100) { for (let frame = 0; frame < count; frame++) { now += 16; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach((callback) => callback(now)); } },
    advance(milliseconds) {
      now += milliseconds;
      for (const [handle, timer] of [...timers]) if (timer.due <= now) { timers.delete(handle); timer.callback(); }
    },
    async settle() { for (let n = 0; n < 12; n++) { await Promise.resolve(); const jobs = pending.splice(0); if (jobs.length) await Promise.all(jobs); } api.frames(); },
    sensor(alpha, beta = 90, gamma = 0) { window.dispatch('deviceorientation', { alpha, beta, gamma }); },
    x(id = 'hero-image') { const transform = ids.get(id).style.transform; assert.ok(transform, `#${id} must render`); return Number(transform.match(/translate3d\(([-\d.e+]+)px/)[1]); },
    home() { document.querySelector('.brand').click(); api.frames(); },
    async upload() {
      const file = { name: 'panorama.jpg', type: 'image/jpeg', size: 100, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) };
      ids.get('album-input').dispatch('change', { target: { files: [file] } });
      await api.settle();
    },
  };
  return api;
}

test('Android starts sensor listening on the landing screen and turns the real hero image', async () => {
  const app = viewer(); await app.settle();
  assert.equal(app.window.count('deviceorientation'), 1);
  assert.equal(app.element('gyro-button').getAttribute('aria-pressed'), 'true');
  const before = app.x();
  app.sensor(0); app.frames();
  assert.equal(app.x(), before, 'the first reading establishes the current view');
  app.sensor(350); app.frames();
  assert.ok(app.x() < before - 20, 'turning the phone right reveals scene content to the right');
});

test('iOS asks only from a tap, exposes denial, and lets the user retry successfully', async () => {
  const app = viewer({ ios: true, permissions: ['denied', 'granted'] }); await app.settle();
  assert.equal(app.permissionCalls(), 0);
  assert.equal(app.window.count('deviceorientation'), 0);
  assert.equal(app.element('motion-button').hidden, false, 'the permission action is discoverable on the home screen');
  app.click('motion-button');
  assert.equal(app.permissionCalls(), 1, 'permission is invoked synchronously within the tap');
  await app.settle();
  assert.equal(app.window.count('deviceorientation'), 0);
  assert.equal(app.element('motion-button').hidden, false);
  assert.equal(app.element('motion-button').disabled, false);
  assert.match(app.element('gyro-hint').textContent, /permission/);
  app.click('motion-button'); await app.settle();
  assert.equal(app.permissionCalls(), 2);
  assert.equal(app.window.count('deviceorientation'), 1);
  const before = app.x(); app.sensor(0); app.sensor(350); app.frames();
  assert.ok(app.x() < before - 20);
});

test('sensor following survives upload, generation and return home without another permission request', async () => {
  const app = viewer({ ios: true }); await app.settle();
  app.click('motion-button'); await app.settle();
  await app.upload();
  assert.equal(app.document.body.dataset.screen, 'preview');
  let before = app.x('preview-image'); app.sensor(0); app.sensor(350); app.frames();
  assert.ok(app.x('preview-image') < before - 20);
  app.click('generate-button'); await app.settle();
  assert.equal(app.document.body.dataset.screen, 'result');
  assert.ok(app.requests.some((request) => request.url === '/jobs' && request.method === 'POST'));
  before = app.x('original-layer'); app.sensor(0); app.sensor(350); app.frames();
  assert.ok(app.x('original-layer') < before - 20);
  assert.equal(app.x('original-layer'), app.x('past-layer'), 'both comparison layers follow the same physical direction');
  app.home();
  before = app.x(); app.sensor(0); app.sensor(350); app.frames();
  assert.ok(app.x() < before - 20);
  app.click('sample-button'); await app.settle();
  assert.equal(app.element('replay-list').children.length, 1);
  app.element('replay-list').children[0].click(); await app.settle();
  assert.equal(app.document.body.dataset.screen, 'result', 'opening an archived journey also retains motion');
  before = app.x('original-layer'); app.sensor(0); app.sensor(350); app.frames();
  assert.ok(app.x('original-layer') < before - 20);
  assert.equal(app.window.count('deviceorientation'), 1, 'screen transitions do not duplicate listeners');
  assert.equal(app.permissionCalls(), 1);
});

test('crossing 359/1 degrees moves a small distance in either direction', async () => {
  const app = viewer(); await app.settle();
  app.sensor(1); app.frames(); const start = app.x();
  app.sensor(359); app.frames(); const right = app.x();
  assert.ok(start - right > 1 && start - right < 50, 'two-degree crossing must not become a full turn');
  app.sensor(1); app.frames();
  assert.ok(Math.abs(app.x() - start) < 0.001, 'crossing back restores the same view');
});

test('dragging establishes a new sensor origin without snapping back to an old target', async () => {
  const app = viewer(); await app.settle();
  app.sensor(0); app.sensor(350); app.frames();
  const viewport = app.element('capture-screen');
  viewport.dispatch('pointerdown', { pointerId: 1, clientX: 200, clientY: 300 });
  viewport.dispatch('pointermove', { pointerId: 1, clientX: 260, clientY: 300 });
  const dragged = app.x();
  app.sensor(340); app.frames();
  assert.equal(app.x(), dragged, 'sensor motion cannot fight an active drag');
  viewport.dispatch('pointerup', { pointerId: 1, clientX: 260, clientY: 300 });
  app.sensor(330); app.frames();
  assert.equal(app.x(), dragged, 'first reading after release keeps the dragged view');
  app.sensor(325); app.frames();
  assert.ok(app.x() < dragged - 10, 'following resumes from the dragged view');
});

test('screen rotation and foregrounding reset the origin instead of applying a stale heading', async () => {
  const app = viewer(); await app.settle();
  app.sensor(0); app.sensor(350); app.frames();
  for (const reset of [
    () => app.window.dispatch('orientationchange'),
    () => app.window.screen.orientation.dispatch('change'),
    () => app.document.dispatch('visibilitychange'),
  ]) {
    reset(); const before = app.x();
    app.sensor(180); app.frames();
    assert.equal(app.x(), before, 'a changed device pose establishes a new baseline');
    app.sensor(175); app.frames();
    assert.ok(app.x() < before - 10);
  }
});

test('a desktop does not automatically request or start motion sensing', async () => {
  const app = viewer({ touch: false, ios: true }); await app.settle();
  assert.equal(app.permissionCalls(), 0);
  assert.equal(app.window.count('deviceorientation'), 0);
  assert.equal(app.element('motion-button').hidden, true);
});

test('insecure mobile contexts show an actionable fallback without attaching a sensor listener', async () => {
  const app = viewer({ secure: false }); await app.settle();
  app.click('motion-button'); await app.settle();
  assert.equal(app.window.count('deviceorientation'), 0);
  assert.equal(app.element('motion-button').disabled, false);
  assert.match(app.element('gyro-hint').textContent, /HTTPS/);
});

test('a silent sensor can be retried and manually paused without duplicate listeners', async () => {
  const app = viewer(); await app.settle();
  app.advance(6100);
  assert.equal(app.element('motion-button').hidden, false);
  assert.match(app.element('motion-label').textContent, /retry/);
  app.click('motion-button'); await app.settle();
  assert.equal(app.window.count('deviceorientation'), 1);
  app.sensor(0); app.sensor(350); app.frames();
  app.click('gyro-button');
  const stopped = app.x(); app.sensor(340); app.frames();
  assert.equal(app.window.count('deviceorientation'), 0);
  assert.equal(app.x(), stopped);
  app.click('gyro-button'); await app.settle();
  app.sensor(340); app.frames();
  assert.equal(app.x(), stopped, 'resuming does not catch up to motion while paused');
  app.sensor(335); app.frames();
  assert.ok(app.x() < stopped - 10);
});

test('actual landscape viewport resize keeps the view stable until the phone turns again', async () => {
  const app = viewer(); await app.settle();
  app.sensor(0);
  const viewport = app.element('capture-screen');
  viewport.clientWidth = 844; viewport.clientHeight = 390;
  app.window.dispatch('resize'); app.frames();
  const landscape = app.x();
  app.sensor(270, 0, 90); app.frames();
  assert.equal(app.x(), landscape);
  app.sensor(265, 0, 90); app.frames();
  assert.ok(app.x() < landscape - 10);
});

test('pure mode keeps following while an open options sheet pauses and recenters it', async () => {
  const app = viewer(); await app.settle();
  app.click('clean-button');
  const before = app.x(); app.sensor(0); app.sensor(350); app.frames();
  assert.ok(app.x() < before - 20);
  app.click('restore-button'); app.click('menu-button');
  const paused = app.x(); app.sensor(330); app.frames();
  assert.equal(app.x(), paused);
  app.click('close-options'); app.sensor(320); app.frames();
  assert.equal(app.x(), paused, 'closing a sheet does not apply phone movement made while using its controls');
  app.sensor(315); app.frames();
  assert.ok(app.x() < paused - 10);
});

test('the Camera tab shares phone orientation and pauses it while a world tab is active', async () => {
  const app = viewer({ ios: true }); await app.settle();
  const headings = [];
  app.window.CenturyModes = { onPhotoState() {}, syncPhotoControls() {}, resetCameraHeading() {}, onMotionState() {}, onCameraHeading(value) { headings.push(value); } };
  app.window.CenturyPhoto.setActive(true, 'camera');
  await app.window.CenturyPhoto.toggleMotion(); await app.settle();
  app.sensor(0); app.sensor(350);
  assert.deepEqual(headings, [0, 10]);
  assert.equal(app.permissionCalls(), 1);
  app.window.CenturyPhoto.setActive(false, 'world');
  assert.equal(app.window.count('deviceorientation'), 0);
  app.sensor(340); assert.deepEqual(headings, [0, 10]);
  app.window.CenturyPhoto.setActive(true, 'camera');
  assert.equal(app.window.count('deviceorientation'), 1);
  assert.equal(app.permissionCalls(), 1, 'returning to a granted sensor does not prompt again');
  app.sensor(330); assert.equal(headings.at(-1), 30);
});
