import assert from 'node:assert/strict';
import test from 'node:test';
import { createYearWheel } from '../web/world/year-wheel.js';

function fixture({ min = 1800, max = 2026, value = '1925', initialRowHeight = 36 } = {}) {
  const timers = new Map(), observers = [];
  let nextTimer = 0, rowHeight = initialRowHeight;
  const document = { defaultView: {
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(element) { this.element = element; }
      disconnect() { this.disconnected = true; }
    },
  } };
  class Element {
    constructor() {
      this.ownerDocument = document;
      this.attributes = {};
      this.dataset = {};
      this.children = [];
      this.handlers = new Map();
      this.classes = new Set();
      this.value = '';
      this.scrollTop = 0;
      this.clientHeight = 3 * rowHeight;
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        contains: (name) => this.classes.has(name),
      };
    }
    get offsetHeight() { return rowHeight; }
    set className(value) { this.classes = new Set(value.split(' ')); }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(child) { this.children.push(child); child.parent = this; }
    replaceChildren(...children) { this.children = []; for (const child of children) this.append(child); }
    contains(child) { return child === this || this.children.some((item) => item.contains(child)); }
    closest() { return this.dataset.year === undefined ? this.parent?.closest() : this; }
    addEventListener(type, handler) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(handler); }
    removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
    emit(type, details = {}) {
      const event = { target: this, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...details };
      for (const handler of this.handlers.get(type) || []) handler(event);
      return event;
    }
  }
  document.createElement = () => new Element();
  const element = new Element(), input = new Element(), changes = [];
  input.value = value;
  const wheel = createYearWheel({ element, input, min, max, onChange: (year) => changes.push(year) });
  return { wheel, element, input, changes, timers, observers,
    settle() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    resize(height) { rowHeight = height; element.clientHeight = 3 * height; for (const observer of observers) observer.callback(); },
    scroll(year) { element.scrollTop = (year - Number(input.min)) * rowHeight; element.emit('scroll'); },
  };
}

test('initial selection and server range update keep value, visible selection, and accessible bounds consistent', () => {
  const { wheel, element, input, changes } = fixture();
  assert.equal(input.value, '1925');
  assert.equal(element.attributes.role, 'spinbutton');
  assert.equal(element.attributes['aria-valuetext'], '1925 年');
  assert.equal(element.children[0].children[125].classList.contains('is-selected'), true);
  wheel.setRange(1950, 2025);
  assert.equal(input.value, '1950');
  assert.equal(element.attributes['aria-valuemin'], '1950');
  assert.equal(element.attributes['aria-valuemax'], '2025');
  assert.equal(element.scrollTop, 0);
  assert.equal(element.children[0].children.length, 76);
  assert.deepEqual(changes, []);
});

test('keyboard uses spinbutton controls, including boundaries and decade jumps, without bubbling into scene movement', () => {
  const { element, input, changes } = fixture();
  const event = element.emit('keydown', { key: 'ArrowUp' });
  assert.equal(input.value, '1926');
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  element.emit('keydown', { key: 'PageDown' });
  assert.equal(input.value, '1916');
  element.emit('keydown', { key: 'Home' });
  element.emit('keydown', { key: 'ArrowDown' });
  assert.equal(input.value, '1800');
  element.emit('keydown', { key: 'End' });
  element.emit('keydown', { key: 'ArrowUp' });
  assert.equal(input.value, '2026');
  assert.deepEqual(changes, [1926, 1916, 1800, 2026]);
});

test('touch scrolling previews adjacent years but publishes only the final settled year', () => {
  const view = fixture();
  view.element.emit('touchstart');
  view.scroll(1930);
  assert.equal(view.input.value, '1925');
  assert.equal(view.element.attributes['aria-valuenow'], '1930');
  view.settle();
  assert.deepEqual(view.changes, []);
  view.scroll(1940);
  view.element.emit('touchend');
  view.scroll(1942.4);
  view.settle();
  assert.equal(view.input.value, '1942');
  assert.equal(view.element.scrollTop, 142 * 36);
  assert.deepEqual(view.changes, [1942]);
  view.element.emit('scrollend');
  assert.deepEqual(view.changes, [1942]);
});

test('programmatic restoration replaces pending scroll selection without a stale change callback', () => {
  const view = fixture();
  view.scroll(2000);
  view.wheel.setValue(1899);
  view.settle();
  assert.equal(view.input.value, '1899');
  assert.equal(view.element.attributes['aria-valuenow'], '1899');
  assert.deepEqual(view.changes, []);
  view.wheel.setValue(1900, { emit: true });
  view.wheel.setValue(1900, { emit: true });
  assert.deepEqual(view.changes, [1900]);
});

test('generate can commit the visible year immediately while touch or inertia is still pending', () => {
  const view = fixture();
  view.element.emit('touchstart');
  view.scroll(1940.7);
  assert.equal(view.input.value, '1925');
  assert.equal(view.wheel.commit(), 1941);
  assert.equal(view.input.value, '1941');
  assert.equal(view.element.scrollTop, 141 * 36);
  view.element.emit('touchend');
  view.settle();
  assert.deepEqual(view.changes, [1941]);
});

test('repeated enabled and range synchronization preserves an in-progress touch selection', () => {
  const view = fixture();
  const originalTrack = view.element.children[0];
  view.element.emit('touchstart');
  view.scroll(1950.4);
  const previousScrollTop = view.element.scrollTop;
  view.wheel.setDisabled(false);
  view.wheel.setRange(1800, 2026);
  assert.equal(view.element.scrollTop, previousScrollTop);
  assert.equal(view.element.children[0], originalTrack);
  assert.equal(view.input.value, '1925');
  view.element.emit('touchend');
  view.settle();
  assert.equal(view.input.value, '1950');
  assert.deepEqual(view.changes, [1950]);
});

test('busy state cancels uncommitted scroll and prevents touch, keyboard, click, and wheel changes', () => {
  const view = fixture();
  view.scroll(1940);
  view.wheel.setDisabled(true);
  view.element.emit('keydown', { key: 'ArrowUp' });
  view.element.emit('click', { target: view.element.children[0].children[150] });
  assert.equal(view.element.emit('wheel', { deltaY: 100 }).prevented, true);
  view.scroll(1900);
  view.settle();
  assert.equal(view.input.value, '1925');
  assert.equal(view.element.scrollTop, 125 * 36);
  assert.equal(view.input.disabled, true);
  assert.equal(view.element.tabIndex, -1);
  assert.deepEqual(view.changes, []);
  view.wheel.setDisabled(false);
  view.element.emit('keydown', { key: 'ArrowUp' });
  assert.equal(view.input.value, '1926');
  assert.equal(view.element.tabIndex, 0);
});

test('clicking an adjacent year commits it, and resizing keeps the selected year centered', () => {
  const view = fixture();
  view.element.emit('click', { target: view.element.children[0].children[124] });
  assert.equal(view.input.value, '1924');
  view.resize(30);
  assert.equal(view.element.scrollTop, 124 * 30);
  assert.equal(view.input.value, '1924');
  assert.deepEqual(view.changes, [1924]);
});

test('initializing before CSS layout retains the chosen year when real row dimensions arrive', () => {
  const view = fixture({ initialRowHeight: 0 });
  assert.equal(view.input.value, '1925');
  assert.equal(view.element.scrollTop, 125 * 36);
  view.resize(30);
  assert.equal(view.element.scrollTop, 125 * 30);
  assert.equal(view.element.attributes['aria-valuenow'], '1925');
  assert.deepEqual(view.changes, []);
});

test('values clamp to valid years, malformed values are ignored, and invalid ranges fail before changing state', () => {
  const view = fixture();
  assert.equal(view.wheel.setValue(9999), 2026);
  assert.equal(view.wheel.setValue('bad'), 2026);
  assert.equal(view.wheel.setValue(1900.8), 1901);
  assert.throws(() => view.wheel.setRange(2026, 1800), RangeError);
  assert.throws(() => view.wheel.setRange(1800.5, 2026), RangeError);
  assert.equal(view.input.value, '1901');
  assert.equal(view.input.min, '1800');
  assert.equal(view.input.max, '2026');
  view.wheel.setRange(1925, 1925);
  assert.equal(view.input.value, '1925');
  assert.equal(view.element.children[0].children.length, 1);
});

test('dispose cancels pending work, detaches handlers and observers, and cannot publish later', () => {
  const view = fixture();
  view.scroll(2000);
  view.wheel.dispose();
  view.wheel.dispose();
  view.settle();
  view.element.emit('keydown', { key: 'ArrowUp' });
  view.element.emit('scrollend');
  view.wheel.setValue(1950, { emit: true });
  assert.equal(view.input.value, '1925');
  assert.deepEqual(view.changes, []);
  assert.equal(view.timers.size, 0);
  assert.equal([...view.element.handlers.values()].every((handlers) => handlers.size === 0), true);
  assert.equal(view.observers[0].disconnected, true);
});
