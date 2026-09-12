import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanoramaPrefetch, createTravelPredictor } from '../web/world/prefetch.js';

const NOW = 1800000000000, METRE = 180 / (Math.PI * 6371000);
const tick = async () => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
function fix(north, east = 0, seconds = 0, accuracy = 5) {
  return { lat: north * METRE, lon: east * METRE, accuracy_m: accuracy, timestamp_ms: NOW + seconds * 1000 };
}
function plan(id, north, year = 1900) {
  return { plan_id: id, input_kind: 'streetview_panorama', target_year: year,
    panorama_editor: { model: 'test' }, source_panorama: { sha256: id,
      metadata: { pano_id: id, lat: north * METRE, lon: 0 } } };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture({ request, preload, activate } = {}) {
  let clock = NOW, timerId = 0;
  const timers = new Map(), calls = [], statuses = [], resources = [], activations = [];
  const initial = plan('origin', 0);
  const controller = createPanoramaPrefetch({ now: () => clock,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id); },
    request: async (path, options) => { calls.push({ path, options });
      return request ? request(path, options) : { plan: plan('next', 65), job: { job_id: 'next-job', stage: 'ready' } }; },
    preload: async (p, j) => {
      if (preload) return preload(p, j);
      const resource = { disposed: false, dispose() { this.disposed = true; } };
      resources.push(resource); return resource;
    },
    activate: async (entry) => { activations.push(entry); return activate ? activate(entry) : true; },
    onStatus: (status) => statuses.push(status),
  });
  controller.setContext({ enabled: true, active: true, allowSwitch: true, plan: initial, year: 1900 });
  return { controller, calls, statuses, resources, activations, timers, initial,
    async advance(seconds) {
      const target = clock + seconds * 1000;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        clock = next[1].at; timers.delete(next[0]); next[1].callback(); await tick();
      }
      clock = target; await tick();
    },
    async location(north, east = 0, seconds = (clock - NOW) / 1000, accuracy = 5) {
      await this.advance(seconds - (clock - NOW) / 1000);
      controller.receiveFix(fix(north, east, seconds, accuracy)); await tick();
    },
    async walk() { await this.location(0, 0, 0); await this.location(7, 0, 5); await this.location(14, 0, 10); },
  };
}

test('travel prediction uses three coherent GPS fixes and handles north across zero degrees', () => {
  let clock = NOW;
  const predictor = createTravelPredictor({ now: () => clock });
  assert.equal(predictor.receiveFix(fix(0)), null);
  clock += 5000; assert.equal(predictor.receiveFix(fix(7, -0.05, 5)), null);
  clock += 5000; const north = predictor.receiveFix(fix(14, 0, 10));
  assert.ok(north.heading_deg < 1 || north.heading_deg > 359);
  assert.ok(Math.abs(north.speed_mps - 1.4) < 0.01);
  clock += 5000; const northeast = predictor.receiveFix(fix(21, 0.05, 15));
  assert.ok(northeast.heading_deg < 1);
});

test('prediction rejects poor accuracy, old or unordered fixes, jumps, stationary drift and stop', () => {
  let clock = NOW + 10000;
  const predictor = createTravelPredictor({ now: () => clock });
  for (const bad of [fix(0, 0, -11), fix(0, 0, 16), fix(0, 0, 0, 36), { ...fix(0), lat: NaN }]) {
    assert.equal(predictor.receiveFix(bad), null);
    assert.equal(predictor.latestFix(), null);
  }
  predictor.receiveFix(fix(0, 0, 0)); predictor.receiveFix(fix(7, 0, 5));
  assert.equal(predictor.receiveFix(fix(90, 0, 6)), null);
  assert.equal(predictor.latestFix().timestamp_ms, NOW + 5000);
  assert.ok(predictor.receiveFix(fix(14, 0, 10)));
  assert.equal(predictor.receiveFix(fix(10, 0, 9)), null);
  assert.equal(predictor.latestFix().timestamp_ms, NOW + 10000);
  clock += 5000; predictor.receiveFix(fix(14.2, 0, 15));
  clock += 5000; predictor.receiveFix(fix(14.1, 0, 20));
  clock += 5000; assert.equal(predictor.receiveFix(fix(14.1, 0, 25)), null);
  predictor.reset();
  for (let i = 0; i < 12; ++i) {
    clock = NOW + i * 3000;
    assert.equal(predictor.receiveFix(fix(i % 2 ? 2 : -2, i % 3, i * 3, 12)), null);
  }
});

test('predictor recovers a reversed walking direction without using compass headings', () => {
  let clock = NOW; const predictor = createTravelPredictor({ now: () => clock });
  let motion;
  for (const [seconds, north] of [[0, 0], [5, 7], [10, 14], [15, 21], [20, 14], [25, 7], [30, 0]]) {
    clock = NOW + seconds * 1000; motion = predictor.receiveFix({ ...fix(north, 0, seconds), heading_deg: 0 });
  }
  assert.ok(Math.abs(motion.heading_deg - 180) < 0.01);
});

test('one speculative request sends adaptive lead distance and switches only near the actual capture', async () => {
  const f = fixture(); await f.walk();
  assert.equal(f.calls.length, 1);
  const body = f.calls[0].options.body;
  assert.equal(f.calls[0].path, '/world-prefetch');
  assert.equal(body.plan_id, 'origin');
  assert.ok(Math.abs(body.lookahead_m - 77) < 0.1);
  assert.equal(f.controller.status.state, 'ready');
  assert.equal(f.resources.length, 1); assert.equal(f.activations.length, 0);
  for (const [seconds, north] of [[15, 21], [20, 28], [25, 35], [30, 42], [35, 49], [40, 56]]) await f.location(north, 0, seconds);
  assert.equal(f.activations.length, 1); assert.equal(f.activations[0].plan.plan_id, 'next');
  assert.equal(f.calls.length, 1); assert.equal(f.resources[0].disposed, false);
  f.controller.dispose(); assert.equal(f.resources[0].disposed, false, 'activated resource belongs to viewer');
});

test('stationary arrival can switch when a pending panorama finishes', async () => {
  let ready = false;
  const f = fixture({ request: (path) => path === '/world-prefetch'
    ? { plan: plan('nearby', 30), job: { job_id: 'j', stage: 'queued' } }
    : { job_id: 'j', stage: ready ? 'ready' : 'editing_panorama' } });
  await f.walk();
  await f.location(21, 0, 15); await f.location(28, 0, 20);
  await f.location(28, 0, 25); await f.location(28, 0, 30); await f.location(28, 0, 35);
  assert.equal(f.activations.length, 0);
  ready = true; await f.advance(2);
  assert.equal(f.activations.length, 1); f.controller.dispose();
});

test('3D view permits preparation but blocks automatic switching; manual arrival switch works', async () => {
  const f = fixture({ request: () => ({ plan: plan('nearby', 20), job: { job_id: 'j', stage: 'ready' } }) });
  f.controller.setContext({ allowSwitch: false });
  await f.walk(); assert.equal(f.activations.length, 0);
  assert.equal(await f.controller.activateReady(), true); assert.equal(f.activations.length, 1);
  f.controller.dispose();
});

test('current capture distance, timestamp and accuracy protect automatic and manual switching', async () => {
  const f = fixture({ request: () => ({ plan: plan('nearby', 10), job: { job_id: 'j', stage: 'ready' } }) });
  f.controller.setContext({ allowSwitch: false }); await f.walk();
  await f.advance(21); assert.equal(await f.controller.activateReady(), false);
  await f.location(14, 0, 32, 40); assert.equal(await f.controller.activateReady(), false);
  f.controller.dispose();
  const g = fixture({ request: () => ({ plan: plan('behind', 5), job: { job_id: 'j', stage: 'ready' } }) });
  g.controller.setContext({ plan: plan('origin', 15) }); await g.walk();
  assert.equal(g.activations.length, 0); assert.equal(await g.controller.activateReady(), false); g.controller.dispose();
});

test('late POST after stop is cancelled and never decoded or activated', async () => {
  const response = deferred();
  const f = fixture({ request: (path) => path === '/world-prefetch' ? response.promise : {} });
  await f.walk(); f.controller.setContext({ enabled: false });
  response.resolve({ plan: plan('next', 20), job: { job_id: 'late', stage: 'queued', can_cancel: true } }); await tick();
  assert.deepEqual(f.calls.map((call) => call.path), ['/world-prefetch', '/world-jobs/late/cancel']);
  assert.equal(f.resources.length, 0); assert.equal(f.activations.length, 0);
  assert.equal(f.controller.status.state, 'off'); f.controller.dispose();
});

test('invalidated downloads release their texture and do not overwrite new-year state', async () => {
  const loaded = deferred(), resource = { disposed: false, dispose() { this.disposed = true; } };
  const f = fixture({ preload: () => loaded.promise }); await f.walk();
  assert.equal(f.controller.status.state, 'loading'); f.controller.setContext({ year: 1920, plan: plan('other-year', 0, 1920) });
  loaded.resolve(resource); await tick();
  assert.equal(resource.disposed, true); assert.equal(f.activations.length, 0);
  assert.equal(f.controller.status.state, 'tracking'); f.controller.dispose();
});

test('a U-turn cancels unstarted work and does not duplicate a still-in-flight request', async () => {
  const f = fixture({ request: (path) => path === '/world-prefetch'
    ? { plan: plan('next', 65), job: { job_id: 'j', stage: 'queued', can_cancel: true } }
    : { job_id: 'j', stage: path.endsWith('/cancel') ? 'cancelled' : 'queued', can_cancel: true } });
  await f.walk(); await f.location(21, 0, 15); await f.location(14, 0, 20); await f.location(7, 0, 25);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
  assert.equal(f.calls.filter((call) => call.path === '/world-prefetch').length, 1);
  f.controller.dispose();
});

test('unknown POST outcomes lock paid retries until the user explicitly starts a new session', async () => {
  const f = fixture({ request: () => { throw new Error('timeout'); } }); await f.walk();
  assert.equal(f.controller.status.state, 'paused');
  for (const [seconds, north] of [[15, 21], [20, 28], [25, 35], [30, 42], [35, 49]]) await f.location(north, 0, seconds);
  assert.equal(f.calls.length, 1);
  f.controller.setContext({ active: false }); f.controller.setContext({ active: true });
  assert.equal(f.controller.status.state, 'paused'); assert.match(f.controller.status.detail, /unconfirmed/);
  await f.location(56, 0, 40); await f.location(63, 0, 45); await f.location(70, 0, 50);
  assert.equal(f.calls.length, 1);
  f.controller.setContext({ enabled: false }); f.controller.setContext({ enabled: true });
  await f.location(77, 0, 55); await f.location(84, 0, 60); await f.location(91, 0, 65);
  assert.equal(f.calls.length, 2); f.controller.dispose();
});

test('completed cached candidates survive pause and reuse without another paid submission', async () => {
  const f = fixture(); await f.walk(); f.controller.setContext({ active: false });
  f.controller.setContext({ active: true });
  await f.location(21, 0, 15); await f.location(28, 0, 20); await f.location(35, 0, 25);
  assert.equal(f.calls.length, 1); assert.equal(f.resources.length, 1);
  assert.equal(f.controller.status.state, 'ready'); f.controller.dispose(); assert.equal(f.resources[0].disposed, true);
});

test('decoded panoramas expire and release resources after five minutes', async () => {
  const f = fixture(); await f.walk(); assert.equal(f.resources[0].disposed, false);
  await f.advance(299); assert.equal(f.resources[0].disposed, false);
  await f.advance(1); assert.equal(f.resources[0].disposed, true);
  assert.equal(f.controller.status.state, 'tracking'); f.controller.dispose();
});

test('skipped candidates are throttled and do not consume the generation budget', async () => {
  const f = fixture({ request: () => ({ status: 'skipped', reason: 'ambiguous_junction' }) }); await f.walk();
  assert.equal(f.controller.status.remaining, 6);
  await f.location(21, 0, 15); await f.location(28, 0, 20); await f.location(35, 0, 25);
  assert.equal(f.calls.length, 1); await f.location(42, 0, 30);
  assert.equal(f.calls.length, 2); assert.equal(f.controller.status.remaining, 6); f.controller.dispose();
});

test('explicit session budget stops after six new panoramas', async () => {
  let sequence = 0;
  const f = fixture({ request: () => ({ plan: plan(`p-${++sequence}`, 1000 + sequence), job: { job_id: `j-${sequence}`, stage: 'error' } }) });
  for (let i = 0; i < 45; ++i) await f.location(i * 7, 0, i * 5);
  assert.equal(f.calls.length, 6); assert.equal(f.controller.status.state, 'paused');
  assert.match(f.controller.status.detail, /session has reached its six-panorama limit/);
  assert.equal(f.controller.status.remaining, 0); f.controller.dispose();
});

test('poll failures retain the same job with backoff instead of creating paid retries', async () => {
  let reads = 0;
  const f = fixture({ request: (path) => {
    if (path === '/world-prefetch') return { plan: plan('next', 65), job: { job_id: 'retry', stage: 'queued' } };
    if (path.endsWith('/cancel')) return {};
    if (++reads <= 2) throw new Error('offline');
    return { job_id: 'retry', stage: 'ready' };
  } });
  await f.walk(); await f.location(21, 0, 15); await f.location(28, 0, 20); await f.location(35, 0, 25);
  assert.equal(f.calls.filter((call) => call.path === '/world-prefetch').length, 1);
  assert.equal(reads, 3); assert.equal(f.controller.status.state, 'ready'); f.controller.dispose();
});

test('cancellation and restarted sessions serialize behind an in-flight status request', async () => {
  const read = deferred(); let inflight = 0, maximum = 0, reads = 0;
  const f = fixture({ request: async (path) => {
    ++inflight; maximum = Math.max(maximum, inflight);
    try {
      if (path === '/world-prefetch') return { plan: plan('next', 65), job: { job_id: 'serial', stage: 'queued', can_cancel: true } };
      if (path.endsWith('/cancel')) return {};
      ++reads; return await read.promise;
    } finally { --inflight; }
  } });
  await f.walk(); await f.advance(2); assert.equal(reads, 1);
  f.controller.setContext({ enabled: false }); f.controller.setContext({ enabled: true });
  await f.location(21, 0, 15); await f.location(28, 0, 20); await f.location(35, 0, 25);
  assert.equal(f.calls.filter((call) => call.path === '/world-prefetch').length, 1);
  read.resolve({ job_id: 'serial', stage: 'ready' }); await tick();
  assert.equal(maximum, 1); assert.equal(f.resources.length, 0);
  assert.equal(f.calls.at(-1).path, '/world-jobs/serial/cancel'); f.controller.dispose();
});

test('ready cache holds only three textures and rejects incompatible generation profiles', async () => {
  let sequence = 0, year = 1900;
  const f = fixture({ request: () => ({ plan: plan(`cached-${++sequence}`, 170, year), job: { job_id: `cached-job-${sequence}`, stage: 'ready' } }) });
  for (let round = 0; round < 4; ++round) {
    year = 1900 + round;
    const source = plan(`origin-${round}`, 0, 1900 + round);
    f.controller.setContext({ plan: source, year: source.target_year });
    // Unique years isolate cached candidates while retaining their textures.
    const start = round * 20;
    await f.location(0, 0, start); await f.location(7, 0, start + 5); await f.location(14, 0, start + 10);
  }
  assert.equal(f.resources.length, 4); assert.equal(f.resources[0].disposed, true);
  assert.equal(f.resources.filter((resource) => !resource.disposed).length, 3);
  f.controller.dispose(); assert.ok(f.resources.every((resource) => resource.disposed));
  const g = fixture(); await g.walk();
  const changed = { ...g.initial, plan_id: 'changed-model', panorama_editor: { model: 'new-test' } };
  g.controller.setContext({ plan: changed });
  await g.location(21, 0, 15); await g.location(28, 0, 20); await g.location(35, 0, 25); await g.location(42, 0, 30);
  assert.equal(g.calls.length, 2); g.controller.dispose();
});

test('ready server cache is reusable after its old speculative queue expiry', async () => {
  const f = fixture({ request: () => ({ reused: true, plan: plan('saved', 65),
    job: { job_id: 'old', stage: 'ready', expires_at: NOW / 1000 - 3600 } }) });
  await f.walk(); assert.equal(f.controller.status.state, 'ready');
  assert.equal(f.resources.length, 1); assert.equal(f.controller.status.remaining, 6);
  await f.advance(299); assert.equal(f.resources[0].disposed, false);
  await f.advance(1); assert.equal(f.resources[0].disposed, true); f.controller.dispose();
});

test('turning while candidate discovery is pending invalidates and cancels its late result', async () => {
  const discovery = deferred();
  const f = fixture({ request: (path) => path === '/world-prefetch' ? discovery.promise : {} });
  await f.walk(); await f.location(21, 0, 15); await f.location(14, 0, 20); await f.location(7, 0, 25);
  discovery.resolve({ plan: plan('wrong-way', 65), job: { job_id: 'wrong-way', stage: 'queued', can_cancel: true } }); await tick();
  assert.equal(f.resources.length, 0); assert.equal(f.activations.length, 0);
  assert.equal(f.calls.at(-1).path, '/world-jobs/wrong-way/cancel'); f.controller.dispose();
});

test('predicted walking speed respects the service limit of 3.5 metres per second', async () => {
  let clock = NOW; const predictor = createTravelPredictor({ now: () => clock });
  predictor.receiveFix(fix(0)); clock += 5000; predictor.receiveFix(fix(16, 0, 5));
  clock += 5000; const accepted = predictor.receiveFix(fix(32, 0, 10));
  assert.ok(accepted.speed_mps <= 3.5);
  predictor.reset(); clock = NOW;
  predictor.receiveFix(fix(0)); clock += 5000; predictor.receiveFix(fix(20, 0, 5));
  clock += 5000; assert.equal(predictor.receiveFix(fix(40, 0, 10)), null);
  const f = fixture();
  for (let index = 0; index < 8; ++index) await f.location(index * 20, 0, index * 5);
  assert.equal(f.calls.length, 0); f.controller.dispose();
});

test('an old POST timeout explicitly pauses a restarted session instead of silently locking it', async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise }); await f.walk();
  f.controller.setContext({ enabled: false }); f.controller.setContext({ enabled: true });
  await f.location(21, 0, 15); await f.location(28, 0, 20); await f.location(35, 0, 25);
  pending.reject(new Error('network timeout')); await tick();
  assert.equal(f.controller.status.state, 'paused');
  assert.match(f.controller.status.detail, /earlier request.*unconfirmed/);
  for (let index = 0; index < 8; ++index) await f.location(42 + index * 7, 0, 30 + index * 5);
  assert.equal(f.calls.length, 1); f.controller.dispose();
});

test('definite service rejection refunds the budget and waits for fresh movement without an unknown lock', async () => {
  let count = 0;
  const f = fixture({ request: () => {
    if (++count === 1) throw Object.assign(new Error('invalid fix'), { status: 422 });
    return { status: 'skipped', reason: 'no_coverage' };
  } }); await f.walk();
  assert.equal(f.controller.status.state, 'error'); assert.equal(f.controller.status.remaining, 6);
  assert.match(f.controller.status.detail, /rejected \(422\).*No generation/);
  assert.doesNotMatch(f.controller.status.detail, /unconfirmed/);
  for (const [seconds, north] of [[15, 21], [20, 28], [25, 35]]) await f.location(north, 0, seconds);
  assert.equal(f.calls.length, 1); await f.location(42, 0, 30);
  assert.equal(f.calls.length, 2); assert.equal(f.controller.status.remaining, 6); f.controller.dispose();
});

test('late rejection from an old session cannot refund or change the restarted session', async () => {
  const pending = deferred();
  const f = fixture({ request: () => pending.promise }); await f.walk();
  f.controller.setContext({ enabled: false }); f.controller.setContext({ enabled: true });
  pending.reject(Object.assign(new Error('rate limited'), { status: 429 })); await tick();
  assert.equal(f.controller.status.state, 'tracking'); assert.equal(f.controller.status.remaining, 6);
  await f.location(21, 0, 15); await f.location(28, 0, 20); await f.location(35, 0, 25);
  assert.equal(f.calls.length, 2); assert.equal(f.controller.status.remaining, 6); f.controller.dispose();
});

test('rate limiting waits at least one minute and uses a new reliable position before retrying', async () => {
  const f = fixture({ request: () => { throw Object.assign(new Error('rate limited'), { status: 429 }); } }); await f.walk();
  assert.equal(f.controller.status.state, 'paused'); assert.equal(f.controller.status.remaining, 6);
  for (let seconds = 15; seconds < 70; seconds += 5) await f.location(seconds * 1.4, 0, seconds);
  assert.equal(f.calls.length, 1); await f.location(98, 0, 70);
  assert.equal(f.calls.length, 2); assert.equal(f.controller.status.remaining, 6); f.controller.dispose();
});

test('HTTP request timeout remains an unknown paid submission outcome', async () => {
  const f = fixture({ request: () => { throw Object.assign(new Error('request timed out'), { status: 408 }); } }); await f.walk();
  assert.equal(f.controller.status.state, 'paused'); assert.match(f.controller.status.detail, /unconfirmed/);
  assert.equal(f.controller.status.remaining, 5); f.controller.dispose();
});

test('allowSwitch toggles do not activate a ready candidate during a view transition', async () => {
  const f = fixture({ request: () => ({ plan: plan('nearby', 20), job: { job_id: 'j', stage: 'ready' } }) });
  f.controller.setContext({ allowSwitch: false }); await f.walk();
  assert.equal(f.activations.length, 0); assert.equal(f.controller.status.state, 'ready');
  f.controller.setContext({ allowSwitch: false }); await tick(); assert.equal(f.activations.length, 0);
  f.controller.setContext({ allowSwitch: true }); await tick(); assert.equal(f.activations.length, 1);
  f.controller.dispose();
});

test('fast server cache hits retain measured image-edit latency for the next cold panorama', async () => {
  let year = 1900, sequence = 0;
  const f = fixture({
    request: () => ({ reused: true, plan: plan(`timed-${++sequence}`, 170, year),
      job: { job_id: `timed-job-${sequence}`, stage: 'ready', timing_s: { image_edit: 50, total_to_assets: 10000 } } }),
    preload: async () => { await f.advance(2); return { dispose() {} }; },
  });
  for (let round = 0; round < 4; ++round) {
    year = 1900 + round;
    f.controller.setContext({ plan: plan(`origin-${round}`, 0, year), year });
    const start = round * 20;
    await f.location(0, 0, start); await f.location(7, 0, start + 5); await f.location(14, 0, start + 10);
    await tick();
    assert.equal(f.controller.status.state, 'ready');
  }
  assert.equal(f.calls.length, 4);
  for (const call of f.calls.slice(1)) {
    assert.ok(Math.abs(call.options.body.lookahead_m - 1.4 * (50 + 2 + 10)) < 0.1,
      `lookahead ${call.options.body.lookahead_m} includes real image editing plus current download, not the cached job total`);
  }
  f.controller.dispose();
});
