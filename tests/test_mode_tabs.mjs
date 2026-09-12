import assert from 'node:assert/strict';
import test from 'node:test';
import { createModeHost, modeFromURL } from '../web/mode-tabs.js';

class Element {
  constructor() { this.listeners = {}; this.attributes = {}; this.children = []; this.dataset = {}; this.hidden = false; this.style = { setProperty() {} }; this.clientWidth = 390; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  emit(type, details = {}) { for (const callback of this.listeners[type] || []) callback({ preventDefault() {}, ...details }); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  appendChild(child) { this.children.push(child); }
  focus() { this.focused = true; }
}
function fixture(url = 'https://example.test/') {
  const elements = new Map();
  const element = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const tabs = ['camera', 'photo', 'streetview', 'world'].map((mode) => { const node = element(`tab-${mode}`); node.dataset.mode = mode; return node; });
  const listeners = {}, messages = [], actions = [], frames = [];
  const window = {
    location: new URL(url), addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
    history: { replaceState(_a, _b, next) { window.location = new URL(next, window.location); } },
  };
  const document = {
    body: { dataset: {} }, getElementById: element, querySelectorAll: () => tabs, querySelector: () => element('camera-home'),
    createElement(tag) { assert.equal(tag, 'iframe'); const node = new Element(); node.contentWindow = { postMessage(data, origin) { messages.push({ data, origin }); } }; frames.push(node); return node; },
  };
  const photo = {
    getState: () => ({ screen: 'capture', year: 1926, min: 1800, max: 2026 }),
    setActive: (active) => actions.push(['active', active]),
    setTargetYear: (year) => actions.push(['year', year]), selectYear: (year) => actions.push(['selectYear', year]),
    capture: () => actions.push(['capture']), upload: () => actions.push(['upload']), archive: () => actions.push(['archive']), options: () => actions.push(['options']),
  };
  const wheels = [];
  const wheelFactory = (options) => { const wheel = { options, setValue(value) { this.value = value; }, setRange() {}, setDisabled(value) { this.disabled = value; }, commit() {} }; wheels.push(wheel); return wheel; };
  const host = createModeHost({ window, document, photo, wheelFactory });
  const emit = (type, data) => { for (const callback of listeners[type] || []) callback(data); };
  const childMessage = (data, override = {}) => emit('message', { data, origin: window.location.origin, source: frames[0]?.contentWindow, ...override });
  return { host, elements, tabs, actions, frames, messages, wheels, window, emit, childMessage };
}

test('the default Camera panel does not create or contact the world viewer', () => {
  const f = fixture();
  assert.deepEqual(f.host.getState(), { mode: 'camera', year: 1926, childReady: false });
  assert.equal(f.frames.length, 0);
  assert.equal(f.elements.get('camera-mode-panel').hidden, false);
  assert.equal(f.elements.get('main').hidden, true);
  f.host.setMode('photo'); f.host.setMode('camera');
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.actions.filter(([type]) => !['active', 'year'].includes(type)), []);
});

test('gateway sessions open the shared world frame in cookie mode without a credential in its URL', () => {
  const f = fixture();
  f.window.CenturyAccess = { sessionRequired: true, authenticated: true };
  f.host.setMode('world');
  const query = new URL(f.frames[0].src, f.window.location).searchParams;
  assert.equal(query.get('session'), '1');
  assert.equal(query.has('access'), false);
  f.childMessage({ type: 'century:world-ready' });
  assert.equal('access' in f.messages.at(-1).data, false);
});

test('Street View and world reuse one frame and deactivate it when leaving', () => {
  const f = fixture();
  f.host.setMode('streetview'); assert.equal(f.frames.length, 1);
  assert.match(f.frames[0].src, /^\/world\/\?embedded=1/);
  assert.equal(f.messages.length, 0);
  f.childMessage({ type: 'century:world-ready' });
  assert.deepEqual(f.messages.at(-1).data, { type: 'century:host-state', mode: 'streetview', year: 1926, active: true });
  f.host.setMode('world'); assert.equal(f.frames.length, 1);
  assert.equal(f.messages.at(-1).data.mode, 'world');
  f.host.setMode('photo'); assert.equal(f.messages.at(-1).data.active, false);
  f.childMessage({ type: 'century:request-mode', mode: 'world' });
  assert.equal(f.host.getState().mode, 'photo', 'an inactive child cannot pull the user back');
});

test('capture and upload open Photo history without resetting the photo model', () => {
  const f = fixture();
  f.elements.get('camera-shoot').emit('click');
  assert.deepEqual(f.actions.at(-1), ['capture']);
  f.host.onPhotoState({ reason: 'screen', screen: 'preview', year: 1926, activate: true });
  assert.equal(f.host.getState().mode, 'photo');
  f.host.setMode('camera'); f.elements.get('camera-upload').emit('click');
  assert.deepEqual(f.actions.at(-1), ['upload']);
  f.host.onPhotoState({ reason: 'screen', screen: 'result', year: 1926, activate: true });
  assert.equal(f.host.getState().mode, 'photo');
});

test('year changes are shared without generation calls and untrusted messages are rejected', () => {
  const f = fixture(); f.host.setMode('world'); f.childMessage({ type: 'century:world-ready' });
  f.childMessage({ type: 'century:world-state', year: 1950 }, { origin: 'https://attacker.test' });
  f.childMessage({ type: 'century:world-state', year: 1950 }, { source: {} });
  assert.equal(f.host.getState().year, 1926);
  const before = f.messages.length;
  f.childMessage({ type: 'century:world-state', year: 1950 });
  assert.equal(f.host.getState().year, 1950);
  assert.equal(f.wheels[0].value, 1950); assert.equal(f.wheels[1].value, 1950);
  assert.equal(f.messages.length, before, 'a child year notification is not echoed');
  assert.deepEqual(f.actions.at(-1), ['year', 1950]);
  f.childMessage({ type: 'century:world-state', year: 9999 });
  assert.equal(f.host.getState().year, 1950);
});

test('saved deep links survive Camera selection; access is sent only in trusted messages', () => {
  const job = 'a'.repeat(32), access = 'secret_token_'.repeat(3);
  const f = fixture(`https://example.test/?world=${job}#access=${access}`);
  assert.equal(f.host.getState().mode, 'world');
  assert.equal(f.window.location.hash, '');
  assert.equal(f.frames[0].src.includes(access), false);
  assert.equal(f.frames[0].src.includes(job), true);
  f.childMessage({ type: 'century:world-ready' });
  assert.equal(f.messages.at(-1).data.access, access);
  f.host.setMode('camera');
  assert.equal(modeFromURL(f.window.location.search), 'camera');
  assert.equal(f.window.location.searchParams.get('world'), job);
});

test('tab navigation supports arrow keys and preserves one selected tab', () => {
  const f = fixture();
  f.tabs[0].emit('keydown', { key: 'ArrowRight' });
  assert.equal(f.host.getState().mode, 'photo');
  assert.equal(f.tabs[1].focused, true);
  assert.equal(f.tabs.filter((tab) => tab.attributes['aria-selected'] === 'true').length, 1);
  assert.equal(f.tabs[1].tabIndex, 0); assert.equal(f.tabs[0].tabIndex, -1);
  assert.equal(modeFromURL('?replay=saved-journey'), 'photo');
  assert.equal(modeFromURL('?mode=invalid'), 'camera');
});

test('a late photo submission does not take over the tab chosen while it was pending', () => {
  const f = fixture();
  f.host.onPhotoState({ reason: 'screen', screen: 'preview', activate: true });
  assert.equal(f.host.getState().mode, 'photo');
  f.host.setMode('camera');
  f.host.onPhotoState({ reason: 'screen', screen: 'result', activate: false });
  assert.equal(f.host.getState().mode, 'camera');
});

test('background world job metadata refreshes saved links without changing mode or year', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  const f = fixture(`https://example.test/?world=${a}&replay=photo-a&mode=world`);
  f.childMessage({ type: 'century:world-ready' }); f.host.setMode('camera');
  f.childMessage({ type: 'century:world-state', jobId: b, year: 1800 });
  assert.equal(f.window.location.searchParams.get('world'), b);
  assert.equal(f.window.location.searchParams.get('replay'), 'photo-a');
  assert.equal(f.host.getState().year, 1926); assert.equal(f.host.getState().mode, 'camera');
  f.childMessage({ type: 'century:world-state', jobId: '../bad' });
  assert.equal(f.window.location.searchParams.get('world'), b);
  f.childMessage({ type: 'century:world-state', jobId: null });
  assert.equal(f.window.location.searchParams.has('world'), false);
  assert.equal(modeFromURL(f.window.location.search), 'camera');
});
