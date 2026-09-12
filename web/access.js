/** Keep app requests and device permissions behind the gateway session. */
export function isLocalDevelopment(hostname) {
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.some((part) => part > 255)) return false;
  return octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
    || octets[0] === 192 && octets[1] === 168;
}

export async function removeGatewayOfflineCaches(window) {
  const registrations = await window.navigator?.serviceWorker?.getRegistrations?.() || [];
  await Promise.all(registrations.filter((entry) => new URL(entry.scope).origin === window.location.origin)
    .map((entry) => entry.unregister()));
  const names = await window.caches?.keys() || [];
  await Promise.all(names.filter((name) => name.startsWith('century-')).map((name) => window.caches.delete(name)));
}

export function createAccessGate({ window, document, fetch = window.fetch.bind(window), startApp,
  clearOfflineCaches = () => removeGatewayOfflineCaches(window) }) {
  const $ = (id) => document.getElementById(id);
  let busy = false, started = false;
  const state = { authenticated: false, sessionRequired: true };
  window.CenturyAccess = state;

  function render(message, { entry = false, retry = false } = {}) {
    $('app-access-status').textContent = message;
    $('app-access-code').disabled = !entry || busy;
    $('app-access-submit').disabled = !entry || busy;
    $('app-access-submit').textContent = busy ? 'Connecting…' : 'Enter';
    $('app-access-retry').hidden = !retry;
    $('app-access-retry').disabled = busy;
  }

  async function unlock(sessionRequired) {
    state.authenticated = true;
    state.sessionRequired = sessionRequired;
    $('app-access-code').value = '';
    render('Opening your window…');
    if (sessionRequired) await clearOfflineCaches();
    if (!started) {
      await startApp();
      started = true;
    }
    document.body.dataset.access = 'ready';
    $('app-access').hidden = true;
  }

  async function request(method = 'GET', code) {
    if (busy || started) return;
    busy = true;
    render(method === 'GET' ? 'Checking your access…' : 'Checking your access code…');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      let response;
      try {
        response = await fetch('/app-session', {
          method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_code: code }) } : {}),
        });
      } catch (error) {
        if (method === 'GET' && isLocalDevelopment(window.location.hostname) && window.navigator?.onLine === false) {
          await unlock(false);
          return;
        }
        throw error;
      }
      if (method === 'GET' && response.status === 404 && isLocalDevelopment(window.location.hostname)) {
        await unlock(false);
        return;
      }
      if (response.status === 401) {
        state.authenticated = false;
        busy = false;
        render(method === 'POST' ? 'That access code was not accepted. Please try again.' : 'Enter your access code to continue.', { entry: true });
        $('app-access-code').focus();
        return;
      }
      if (!response.ok || (await response.json()).authenticated !== true) throw new Error('Session unavailable');
      await unlock(true);
    } catch {
      state.authenticated = false;
      busy = false;
      render('Unable to connect. Check your connection and try again.', { retry: true });
    } finally {
      busy = false;
      clearTimeout(timeout);
    }
  }

  $('app-access-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const code = $('app-access-code').value.trim();
    if (!code) { render('Enter your access code to continue.', { entry: true }); return; }
    void request('POST', code);
  });
  $('app-access-retry').addEventListener('click', () => { void request(); });
  return { check: () => request(), submit: (code) => request('POST', code), state };
}

const loadedScripts = new Set();
async function loadApplication() {
  for (const source of ['/vendor/leaflet/leaflet.js', '/capture.js', '/motion.js', '/app.js']) {
    if (loadedScripts.has(source)) continue;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = () => { loadedScripts.add(source); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('Unable to load the application')); };
      document.head.appendChild(script);
    });
  }
  await import('./mode-tabs.js');
}

if (globalThis.document?.getElementById('app-access')) {
  const gate = createAccessGate({ window, document, startApp: loadApplication });
  void gate.check();
}
