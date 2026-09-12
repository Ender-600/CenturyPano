import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveLocation, locationDistance, positionFix } from '../web/world/location.js';

const NOW = 1800000000000;
function position({ lat = 40.4433, lon = -79.9436, accuracy = 7, timestamp = NOW } = {}) {
  return { coords: { latitude: lat, longitude: lon, accuracy }, timestamp };
}
function near(actual, expected, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}
function fixture() {
  let clock = NOW, sequence = 0;
  const watches = new Map(), registrations = [], cleared = [], fixes = [], errors = [];
  const geolocation = {
    watchPosition(success, failure, options) {
      const id = sequence++;
      const watch = { id, success, failure, options };
      watches.set(id, watch); registrations.push(watch); return id;
    },
    clearWatch(id) { cleared.push(id); watches.delete(id); },
  };
  const live = createLiveLocation({ geolocation, now: () => clock,
    onFix: (fix) => fixes.push(fix), onError: (error) => errors.push(error) });
  return { live, watches, registrations, cleared, fixes, errors,
    advance(ms) { clock += ms; },
    get latestWatch() { return registrations.at(-1); } };
}

test('positionFix returns the validated coordinates and their original accuracy and timestamp', () => {
  const fix = positionFix(position(), NOW);
  assert.deepEqual(fix, { lat: 40.4433, lon: -79.9436, accuracy_m: 7, timestamp_ms: NOW });
  assert.deepEqual(positionFix(position({ lat: 0, lon: 0, accuracy: 0 }), NOW),
    { lat: 0, lon: 0, accuracy_m: 0, timestamp_ms: NOW });
});

test('positionFix accepts bounded locations and rejects latitude, longitude, and accuracy outside them', () => {
  for (const lat of [-85, 85]) for (const lon of [-180, 180]) {
    assert.equal(positionFix(position({ lat, lon, accuracy: 1000 }), NOW).lat, lat);
  }
  for (const values of [{ lat: -85.001 }, { lat: 85.001 }, { lon: -180.001 }, { lon: 180.001 },
    { accuracy: -0.001 }, { accuracy: 1000.001 }]) {
    assert.throws(() => positionFix(position(values), NOW), /位置无效/);
  }
});

test('positionFix does not coerce null, strings, NaN, or infinity into valid coordinates', () => {
  for (const key of ['lat', 'lon', 'accuracy', 'timestamp']) {
    for (const value of [null, '0', NaN, Infinity, -Infinity]) {
      assert.throws(() => positionFix(position({ [key]: value }), NOW), /位置无效/);
    }
  }
  for (const malformed of [null, undefined, {}, { coords: null, timestamp: NOW }, { coords: {}, timestamp: NOW }]) {
    assert.throws(() => positionFix(malformed, NOW));
  }
});

test('positionFix rejects expired or implausibly future timestamps at exact freshness boundaries', () => {
  assert.equal(positionFix(position({ timestamp: NOW - 60000 }), NOW).timestamp_ms, NOW - 60000);
  assert.equal(positionFix(position({ timestamp: NOW + 10000 }), NOW).timestamp_ms, NOW + 10000);
  assert.throws(() => positionFix(position({ timestamp: NOW - 60001 }), NOW), /过期/);
  assert.throws(() => positionFix(position({ timestamp: NOW + 10001 }), NOW), /位置无效/);
});

test('haversine distances agree with equatorial arc lengths and realistic city distances', () => {
  near(locationDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111194.926645, 0.001);
  near(locationDistance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111194.926645, 0.001);
  // New York to London is about 5,570 km on a 6,371 km spherical Earth.
  const ny = { lat: 40.7128, lon: -74.0060 }, london = { lat: 51.5074, lon: -0.1278 };
  near(locationDistance(ny, london), 5570222.180, 0.01);
  near(locationDistance(london, ny), locationDistance(ny, london));
  assert.equal(locationDistance(ny, ny), 0);
});

test('distance wraps longitude across the date line and remains finite at antipodes', () => {
  const a = { lat: 0, lon: 179.999 }, b = { lat: 0, lon: -179.999 };
  near(locationDistance(a, b), 222.389853, 0.001);
  near(locationDistance({ lat: 60, lon: 179.999 }, { lat: 60, lon: -179.999 }), 111.194927, 0.001);
  near(locationDistance({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }), Math.PI * 6371000);
});

test('distance treats missing or nonfinite locations as unavailable', () => {
  for (const invalid of [null, undefined, {}, { lat: 0 }, { lat: null, lon: 0 }, { lat: '0', lon: 0 },
    { lat: NaN, lon: 0 }, { lat: 0, lon: Infinity }]) {
    assert.equal(locationDistance(invalid, { lat: 0, lon: 0 }), Infinity);
    assert.equal(locationDistance({ lat: 0, lon: 0 }, invalid), Infinity);
  }
});

test('live location starts only on request and registers a single accurate watch, including watch id zero', () => {
  const f = fixture();
  assert.equal(f.live.active, false); assert.equal(f.registrations.length, 0);
  f.live.start(); f.live.start(); f.live.start();
  assert.equal(f.live.active, true); assert.equal(f.registrations.length, 1);
  assert.equal(f.latestWatch.id, 0);
  assert.deepEqual(f.latestWatch.options, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  assert.deepEqual(f.fixes, []); f.live.stop();
});

test('newer accepted fixes cannot be replaced by out-of-order watch updates', () => {
  const f = fixture(); f.live.start();
  f.latestWatch.success(position()); f.advance(1000);
  f.latestWatch.success(position({ lat: 40.4440, timestamp: NOW + 1000 }));
  f.latestWatch.success(position({ lat: 40.4400, timestamp: NOW + 500 }));
  assert.equal(f.fixes.length, 2);
  assert.equal(f.fixes.at(-1).lat, 40.4440);
  assert.equal(f.errors.length, 0); f.live.stop();
});

test('invalid fixes report an error without poisoning timestamp ordering or ending the watch', () => {
  const f = fixture(); f.live.start();
  f.latestWatch.success(position({ lat: 90, timestamp: NOW + 1000 }));
  f.latestWatch.success(position({ timestamp: NOW - 60001 }));
  assert.equal(f.fixes.length, 0); assert.equal(f.errors.length, 2);
  assert.equal(f.live.active, true);
  f.latestWatch.success(position());
  assert.equal(f.fixes.length, 1); assert.equal(f.fixes[0].timestamp_ms, NOW);
  f.live.stop();
});

test('temporary positioning errors keep the watch running so a subsequent fix can recover', () => {
  const f = fixture(); f.live.start();
  for (const code of [2, 3]) {
    const error = { code, message: 'Temporary positioning problem' };
    f.latestWatch.failure(error); assert.equal(f.errors.at(-1), error);
    assert.equal(f.live.active, true);
  }
  f.latestWatch.success(position());
  assert.equal(f.fixes.length, 1); assert.equal(f.registrations.length, 1);
  assert.deepEqual(f.cleared, []); f.live.stop();
});

test('permission denial clears the native watch and permits an explicit later restart', () => {
  const f = fixture(); f.live.start(); const deniedWatch = f.latestWatch;
  const denial = { code: 1, message: 'Permission denied' };
  deniedWatch.failure(denial);
  assert.equal(f.live.active, false); assert.equal(f.watches.size, 0);
  assert.deepEqual(f.cleared, [0]); assert.equal(f.errors[0], denial);
  deniedWatch.success(position()); deniedWatch.failure(denial);
  assert.equal(f.fixes.length, 0); assert.equal(f.errors.length, 1);
  f.live.start(); assert.equal(f.live.active, true);
  assert.equal(f.registrations.length, 2); f.latestWatch.success(position());
  assert.equal(f.fixes.length, 1); f.live.stop();
});

test('stop is idempotent and late callbacks from stopped or prior sessions are ignored', () => {
  const f = fixture(); f.live.start(); const old = f.latestWatch;
  f.live.stop(); f.live.stop();
  assert.deepEqual(f.cleared, [0]); assert.equal(f.live.active, false);
  old.success(position()); old.failure({ code: 2 });
  assert.equal(f.fixes.length, 0); assert.equal(f.errors.length, 0);
  f.live.start(); const next = f.latestWatch;
  old.success(position({ lat: 40.44 })); old.failure({ code: 1 });
  assert.equal(f.live.active, true); assert.equal(f.errors.length, 0);
  next.success(position()); assert.equal(f.fixes.length, 1);
  f.live.stop(); assert.deepEqual(f.cleared, [0, 1]); assert.equal(f.watches.size, 0);
});

test('timestamp ordering is retained across an explicit watch restart', () => {
  const f = fixture(); f.live.start(); f.latestWatch.success(position());
  f.live.stop(); f.live.start();
  f.latestWatch.success(position({ timestamp: NOW - 1000 }));
  assert.equal(f.fixes.length, 1);
  f.advance(1000); f.latestWatch.success(position({ timestamp: NOW + 1000 }));
  assert.equal(f.fixes.length, 2); f.live.stop();
});

test('missing geolocation capability does not pretend to have an active watch', () => {
  for (const geolocation of [undefined, null, {}]) {
    const live = createLiveLocation({ geolocation, onFix() { assert.fail('No geolocation available'); }, onError() {} });
    live.start(); assert.equal(live.active, false); live.stop(); assert.equal(live.active, false);
  }
});
