import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createAccessGate, isLocalDevelopment, removeGatewayOfflineCaches } from '../web/access.js';

const response = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function fixture(replies, hostname = 'century-pano.vercel.app', overrides = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: true,
      listeners: {}, addEventListener(type, action) { this.listeners[type] = action; }, focus() { this.focused = true; } });
    return elements.get(id);
  };
  const calls = [], actions = [];
  const document = { body: { dataset: { access: 'locked' } }, getElementById: element };
  const window = { location: { hostname } };
  const gate = createAccessGate({ window, document,
    fetch: async (path, init) => {
      calls.push({ path, ...init });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    }, startApp: async () => actions.push('app'), clearOfflineCaches: async () => actions.push('clear'), ...overrides });
  return { gate, elements, element, document, window, calls, actions };
}

test('entry HTML loads only the access gate before authentication', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.deepEqual([...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]), ['/access.js']);
  assert.match(html, /data-access="locked"/);
  assert.match(html, /type="password"/);
});

test('unauthenticated visitors cannot start camera, location, world or photo code', async () => {
  const f = fixture([response(401, { authenticated: false })]);
  await f.gate.check();
  assert.equal(f.gate.state.authenticated, false);
  assert.deepEqual(f.actions, []);
  assert.equal(f.document.body.dataset.access, 'locked');
  assert.equal(f.element('app-access-code').disabled, false);
  assert.deepEqual(f.calls.map((request) => request.path), ['/app-session']);
});

test('a session unlocks once, clears old offline data, and passes no token to app scripts', async () => {
  const f = fixture([response(200, { authenticated: true })]);
  f.element('app-access-code').value = 'old-code';
  await f.gate.check(); await f.gate.check();
  assert.deepEqual(f.actions, ['clear', 'app']);
  assert.deepEqual(f.gate.state, { authenticated: true, sessionRequired: true });
  assert.equal(f.document.body.dataset.access, 'ready');
  assert.equal(f.element('app-access-code').value, '');
  assert.equal(f.element('app-access').hidden, true);
  assert.equal(f.calls[0].credentials, 'same-origin');
  assert.equal(f.calls[0].redirect, 'error');
  assert.equal(f.calls[0].cache, 'no-store');
});

test('a rejected code stays locked and valid retry sends it only as JSON', async () => {
  const f = fixture([response(401), response(200, { authenticated: true })]);
  await f.gate.submit('incorrect-code');
  assert.deepEqual(f.actions, []);
  assert.match(f.element('app-access-status').textContent, /not accepted/);
  await f.gate.submit('private-code');
  assert.equal(f.calls[1].path, '/app-session');
  assert.equal(f.calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[1].body), { access_code: 'private-code' });
  assert.equal(f.gate.state.authenticated, true);
  assert.equal('access_code' in f.gate.state, false);
});

test('network failures, malformed success and public 404 never unlock; retry can recover', async () => {
  for (const reply of [new Error('offline'), response(502), response(200, { authenticated: 'true' }), response(404)]) {
    const f = fixture([reply, response(200, { authenticated: true })]);
    await f.gate.check();
    assert.deepEqual(f.actions, []);
    assert.equal(f.gate.state.authenticated, false);
    assert.equal(f.element('app-access-retry').hidden, false);
    await f.gate.check();
    assert.deepEqual(f.actions, ['clear', 'app']);
  }
});

test('only loopback and literal RFC1918 development addresses accept an absent session endpoint', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', '10.0.0.2', '192.168.1.10', '172.16.0.1', '172.31.255.254']) {
    const f = fixture([response(404)], hostname);
    await f.gate.check();
    assert.deepEqual(f.actions, ['app']);
    assert.equal(f.gate.state.sessionRequired, false);
  }
  for (const hostname of ['localhost.evil.test', '127.0.0.1.evil.test', 'century-pano.vercel.app', '10.attacker.com',
    '10.0.0.2.attacker.com', '192.168.1.10.attacker.com', '172.15.255.255', '172.32.0.1', '192.169.1.1', '8.8.8.8',
    '10.256.0.1', '192.168.1', '192.168.1.1.1']) {
    assert.equal(isLocalDevelopment(hostname), false, hostname);
    const f = fixture([response(404)], hostname);
    await f.gate.check();
    assert.deepEqual(f.actions, [], hostname);
  }
  const offline = fixture([new Error('offline')], 'localhost');
  await offline.gate.check();
  assert.deepEqual(offline.actions, []);
});

test('old gateway service worker and journey caches are removed before loading the app', async () => {
  const actions = [];
  await removeGatewayOfflineCaches({
    location: { origin: 'https://century-pano.vercel.app' },
    navigator: { serviceWorker: { getRegistrations: async () => [
      { scope: 'https://century-pano.vercel.app/', unregister: async () => actions.push('unregister') },
    ] } },
    caches: { keys: async () => ['century-shell-v7-four-modes', 'century-journeys-v1', 'unrelated'], delete: async (name) => actions.push(name) },
  });
  assert.deepEqual(actions, ['unregister', 'century-shell-v7-four-modes', 'century-journeys-v1']);
});

test('an offline browser can reopen local cached journeys but cannot bypass a public gateway', async () => {
  for (const hostname of ['localhost', '192.168.1.10', '10.0.0.2', '172.16.0.1']) {
    const f = fixture([new Error('offline')], hostname);
    f.window.navigator = { onLine: false };
    await f.gate.check();
    assert.deepEqual(f.actions, ['app']);
    assert.equal(f.gate.state.sessionRequired, false);
  }
  for (const hostname of ['century-pano.vercel.app', '10.attacker.com', '172.32.0.1']) {
    const f = fixture([new Error('offline')], hostname);
    f.window.navigator = { onLine: false };
    await f.gate.check();
    assert.deepEqual(f.actions, []);
  }
  const online = fixture([new Error('service down')], '192.168.1.10');
  online.window.navigator = { onLine: true };
  await online.gate.check();
  assert.deepEqual(online.actions, []);
});
