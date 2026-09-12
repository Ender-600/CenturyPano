const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { headingFromOrientation, shortestDelta } = vm.runInThisContext(`(function(module) { ${readFileSync(require.resolve('../web/motion.js'), 'utf8')}\nreturn globalThis.CenturyMotion; })(undefined)`);
delete global.CenturyMotion;

function close(actual, expected) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(shortestDelta(actual, expected)) < 1e-8, `${actual} should equal ${expected}`);
}

test('portrait camera heading follows physical right and left turns', () => {
  close(headingFromOrientation({ alpha: 0, beta: 90, gamma: 0 }), 0);
  close(headingFromOrientation({ alpha: 330, beta: 90, gamma: 0 }), 30);
  close(headingFromOrientation({ alpha: 30, beta: 90, gamma: 0 }), 330);
});

test('both landscape grips give the same heading and turn direction as portrait', () => {
  for (const heading of [0, 10, 90, 180, 270, 359]) {
    close(headingFromOrientation({ alpha: 270 - heading, beta: 0, gamma: 90 }), heading);
    close(headingFromOrientation({ alpha: 90 - heading, beta: 0, gamma: -90 }), heading);
  }
});

test('uses the complete pose when Euler alpha alone misses an upright turn', () => {
  close(headingFromOrientation({ alpha: 0, beta: 90, gamma: -25 }), 25);
  close(headingFromOrientation({ alpha: 0, beta: 90, gamma: 25 }), 335);
  close(headingFromOrientation({ alpha: 180, beta: 90, gamma: 0 }), 180);
});

test('tilting an upright portrait phone preserves its horizontal heading', () => {
  for (const beta of [20, 45, 80, 90, 100, 135, 160]) {
    close(headingFromOrientation({ alpha: 320, beta, gamma: 0 }), 40);
  }
});

test('returns no unstable heading when the camera points straight up or down', () => {
  for (const alpha of [0, 30, 180, 359]) {
    for (const beta of [0, 1, -1, 179, 180, -180]) {
      assert.equal(headingFromOrientation({ alpha, beta, gamma: 0 }), null);
    }
  }
  assert.equal(headingFromOrientation({ alpha: 0, beta: 1, gamma: 1 }), null);
  close(headingFromOrientation({ alpha: 0, beta: 6, gamma: 0 }), 0);
});

test('accepts alpha-only devices without treating missing data as zero', () => {
  close(headingFromOrientation({ alpha: 0 }), 0);
  close(headingFromOrientation({ alpha: 90, beta: null, gamma: null }), 270);
  close(headingFromOrientation({ alpha: 370 }), 350);
  assert.equal(headingFromOrientation({ alpha: 45, beta: 90 }), null);
  assert.equal(headingFromOrientation({ alpha: 45, gamma: 0 }), null);
});

test('rejects missing, non-numeric and non-finite sensor readings', () => {
  for (const orientation of [null, undefined, {}, { alpha: null }, { alpha: '0' }, { alpha: NaN }, { alpha: Infinity }]) {
    assert.equal(headingFromOrientation(orientation), null);
  }
  for (const invalid of [NaN, Infinity, -Infinity, '90']) {
    assert.equal(headingFromOrientation({ alpha: 0, beta: invalid, gamma: 0 }), null);
    assert.equal(headingFromOrientation({ alpha: 0, beta: 90, gamma: invalid }), null);
  }
});

test('takes the short direction through the 359/0 seam and handles complete turns', () => {
  assert.equal(shortestDelta(1, 359), 2);
  assert.equal(shortestDelta(359, 1), -2);
  assert.equal(shortestDelta(360, 0), 0);
  assert.equal(shortestDelta(721, -1), 2);
  assert.equal(shortestDelta(180, 0), -180);
  assert.equal(shortestDelta(0, 180), -180);
});

test('multiple physical revolutions accumulate without a half-turn jump', () => {
  let previous = headingFromOrientation({ alpha: 0, beta: 90, gamma: 0 });
  let total = 0;
  for (let turn = 20; turn <= 800; turn += 20) {
    const heading = headingFromOrientation({ alpha: -turn, beta: 90, gamma: 0 });
    total += shortestDelta(heading, previous);
    previous = heading;
  }
  assert.ok(Math.abs(total - 800) < 1e-8);
});

test('shortestDelta guards invalid values and stays finite for finite inputs', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) {
    assert.equal(shortestDelta(value, 0), null);
    assert.equal(shortestDelta(0, value), null);
  }
  const result = shortestDelta(Number.MAX_VALUE, -Number.MAX_VALUE);
  assert.ok(Number.isFinite(result));
  assert.ok(result >= -180 && result < 180);
});

test('exports the same helpers when loaded as a normal browser script', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(require.resolve('../web/motion.js'), 'utf8'), context);
  close(context.CenturyMotion.headingFromOrientation({ alpha: 270, beta: 90, gamma: 0 }), 90);
  assert.equal(context.CenturyMotion.shortestDelta(1, 359), 2);
});
