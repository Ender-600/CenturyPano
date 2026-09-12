import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildVercel, validateBackendOrigin } from '../scripts/build-vercel.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://backend.example.com'; // Offline fixture; no test sends HTTP requests.
const SENTINEL = 'fixture-private-value-never-publish';
let fixture, output, config, files;

async function fileList(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await fileList(path.join(directory, entry.name), name));
    else found.push(name);
  }
  return found.sort();
}

before(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), 'century-vercel-test-'));
  for (const source of ['web', 'node_modules/three/build', 'node_modules/three/examples/jsm', 'node_modules/@sparkjsdev/spark/dist']) {
    await mkdir(path.dirname(path.join(fixture, source)), { recursive: true });
    await cp(path.join(ROOT, source), path.join(fixture, source), { recursive: true });
  }
  await mkdir(path.join(fixture, 'deploy'));
  await writeFile(path.join(fixture, 'deploy/vercel-backend.json'), JSON.stringify({ origin: ORIGIN }));
  await mkdir(path.join(fixture, '.vercel/output/static'), { recursive: true });
  await writeFile(path.join(fixture, '.vercel/project.json'), '{"projectId":"keep-this-metadata"}');
  for (const name of ['.env', 'web/.env', 'web/private.key', '.vercel/output/static/stale.txt']) {
    await writeFile(path.join(fixture, name), SENTINEL);
  }
  output = await buildVercel({ root: fixture, env: { OPENAI_API_KEY: SENTINEL, WORLD_ACCESS_TOKEN: SENTINEL } });
  config = JSON.parse(await readFile(path.join(output, 'config.json'), 'utf8'));
  files = new Set(await fileList(path.join(output, 'static')));
});

after(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

// Evaluate the documented subset used in this build (headers, regex rewrites,
// redirects, filesystem and final status). Live Vercel forwarding is verified
// separately; this checks accidental exposure and missing static resources.
function resolveRoute(url, method = 'GET') {
  const pathname = new URL(url, 'https://frontend.example.com').pathname;
  const headers = {};
  for (const route of config.routes) {
    if (route.handle === 'filesystem') {
      if (files.has(pathname.slice(1))) return { status: 200, destination: pathname, headers };
      continue;
    }
    if (route.methods && !route.methods.includes(method)) continue;
    const expression = new RegExp(route.src, route.caseSensitive === false ? 'i' : '');
    if (!expression.test(pathname)) continue;
    Object.assign(headers, route.headers);
    if (route.continue) continue;
    return {
      status: route.status ?? 200,
      destination: route.dest ? pathname.replace(expression, route.dest) : null,
      headers,
    };
  }
  assert.fail(`No route for ${pathname}`);
}

test('produces only static Build Output API files and preserves Vercel project metadata', async () => {
  assert.equal(config.version, 3);
  assert.deepEqual((await readdir(output)).sort(), ['config.json', 'static']);
  assert.equal(await readFile(path.join(fixture, '.vercel/project.json'), 'utf8'), '{"projectId":"keep-this-metadata"}');
  for (const name of ['index.html', 'world/index.html', 'mode-tabs.js', 'vendor/leaflet/leaflet.js',
    'world-vendor/three/build/three.core.js', 'world-vendor/three/examples/jsm/loaders/GLTFLoader.js',
    'world-vendor/@sparkjsdev/spark/dist/spark.module.js']) assert.ok(files.has(name), `Missing ${name}`);
  for (const name of files) {
    assert.ok(!name.split('/').some((segment) => segment.startsWith('.')), name);
    assert.ok(!/\.(?:md|pem|key|env)$/i.test(name), name);
    assert.ok(!name.startsWith('app/') && !name.startsWith('data/') && !name.startsWith('node_modules/'), name);
  }
  assert.ok(!files.has('stale.txt'));
  assert.ok(!JSON.stringify(config).includes(SENTINEL));
  const projectConfig = JSON.parse(await readFile(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(projectConfig.framework, null);
  assert.equal(projectConfig.installCommand, 'npm ci');
  assert.equal(projectConfig.buildCommand, 'npm run build:vercel');
  assert.ok(!projectConfig.outputDirectory, 'Build Output API owns its output directory');
});

test('root remains the full app, standalone world still loads, and unknown paths return 404', () => {
  assert.equal(resolveRoute('/').destination, '/index.html');
  assert.equal(resolveRoute('/').status, 200);
  assert.equal(resolveRoute('/world').status, 307);
  assert.equal(resolveRoute('/world').headers.Location, '/world/');
  assert.equal(resolveRoute('/world/').destination, '/world/index.html');
  assert.equal(resolveRoute('/world/app.js?v=current').destination, '/world/app.js');
  for (const url of ['/does-not-exist', '/world/not-found', '/.env', '/app/main.py', '/data/worlds/private.json',
    '/docs', '/openapi.json', '/world-jobs-evil', '/world-config/extra', '/world-session/extra',
    '/jobs-evil', '/app-session/extra', '/location/resolve/extra', '/World-jobs/example',
    '/world-jobs//private', '/world-jobs/%2fprivate', '/world-jobs/%252e%252e/private']) {
    assert.equal(resolveRoute(url).status, 404, url);
  }
});

test('all permitted API families proxy with no-store while static responses revalidate', () => {
  for (const url of ['/app-session', '/world-config', '/world-session', '/world-auth',
    '/world-plans', '/world-plans/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/assets/source_panorama.jpg',
    '/world-jobs', '/world-jobs/0123456789abcdef0123456789abcdef/assets/world.spz',
    '/world-jobs/0123456789abcdef0123456789abcdef/resume', '/world-prefetch',
    '/health', '/preview', '/jobs', '/jobs/abc/manifest', '/jobs/abc/tiles/0',
    '/jobs/abc/explain', '/jobs/abc/hotspots', '/out/abc/hotspots/example.jpg', '/replays', '/location/resolve']) {
    for (const method of ['GET', 'POST']) {
      const result = resolveRoute(url, method);
      assert.equal(result.destination, ORIGIN + url);
      assert.match(result.headers['Cache-Control'], /no-store/);
      assert.equal(result.headers['CDN-Cache-Control'], 'no-store');
      assert.equal(result.headers['Vercel-CDN-Cache-Control'], 'no-store');
    }
  }
  const headers = resolveRoute('/world/style.css').headers;
  assert.equal(headers['Cache-Control'], 'public, max-age=0, must-revalidate');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Permissions-Policy'], /geolocation=\(self\)/);
  assert.match(headers['Permissions-Policy'], /camera=\(self\)/);
  assert.match(headers['Permissions-Policy'], /gyroscope=\(self\)/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('HTML, CSS, import maps and reachable static or literal dynamic imports resolve in output', async () => {
  const modules = new Set();
  const missingAssets = new Set();
  let imports = {};
  const publicPath = (specifier, parent) => new URL(specifier, `https://frontend.example.com${parent}`).pathname;
  const exists = (url) => {
    const resolved = url === '/' ? '/index.html' : url.endsWith('/') ? `${url}index.html` : url;
    if (!files.has(resolved.slice(1))) missingAssets.add(url);
  };
  for (const htmlPath of ['/index.html', '/world/index.html']) {
    const html = await readFile(path.join(output, 'static', htmlPath.slice(1)), 'utf8');
    const importMap = html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/);
    if (importMap) imports = { ...imports, ...JSON.parse(importMap[1]).imports };
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (/^(?:https?:|data:|#)/.test(match[1])) continue;
      const url = publicPath(match[1], htmlPath);
      exists(url);
      if (url.endsWith('.css')) {
        const css = await readFile(path.join(output, 'static', url.slice(1)), 'utf8');
        for (const asset of css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
          if (!/^(?:https?:|data:|#)/.test(asset[1])) exists(publicPath(asset[1], url));
        }
      }
    }
    for (const script of html.matchAll(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/g)) {
      modules.add(publicPath(script[1], htmlPath));
    }
  }
  for (const [name, url] of Object.entries(imports)) {
    if (!name.endsWith('/')) { exists(url); modules.add(url); }
  }
  const seen = new Set();
  while (modules.size) {
    const url = modules.values().next().value;
    modules.delete(url);
    if (seen.has(url)) continue;
    exists(url);
    seen.add(url);
    const source = await readFile(path.join(output, 'static', url.slice(1)), 'utf8');
    const declarations = /(?:^|\n)\s*(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+)(['"])([^'"\n]+)\1/g;
    const dynamicImports = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g;
    // The authenticated entry point also inserts these classic scripts only
    // after connecting, so they are not all present as HTML script elements.
    for (const script of source.matchAll(/['"](\/[^'"\n]+\.js(?:\?[^'"\n]*)?)['"]/g)) {
      modules.add(publicPath(script[1], url));
    }
    for (const declaration of [...source.matchAll(declarations), ...source.matchAll(dynamicImports)]) {
      const specifier = declaration[2];
      let destination;
      if (specifier.startsWith('.') || specifier.startsWith('/')) destination = publicPath(specifier, url);
      else {
        const key = Object.keys(imports).sort((a, b) => b.length - a.length)
          .find((key) => key === specifier || key.endsWith('/') && specifier.startsWith(key));
        assert.ok(key, `Unmapped module ${specifier} imported by ${url}`);
        destination = imports[key] + (key.endsWith('/') ? specifier.slice(key.length) : '');
      }
      modules.add(destination);
    }
  }
  assert.ok(seen.has('/world/app.js'));
  assert.ok(seen.has('/mode-tabs.js'));
  assert.ok(seen.has('/world-vendor/three/build/three.core.js'));
  assert.ok(seen.has('/world-vendor/three/examples/jsm/utils/BufferGeometryUtils.js'));
  assert.ok(seen.has('/world-vendor/three/examples/jsm/postprocessing/Pass.js'));
  assert.deepEqual([...missingAssets], [], 'Every HTML, CSS and static module reference must resolve');
});

test('origin validation rejects secrets, non-origins, private hosts and frontend proxy loops', () => {
  for (const value of [null, '', 'http://backend.example.com', '//backend.example.com',
    'https://user:secret@backend.example.com', 'https://backend.example.com/path',
    'https://backend.example.com/?secret=value', 'https://backend.example.com/#secret',
    'https://backend.example.com?', 'https://backend.example.com#', 'https://backend.example.com/..',
    'https://backend.example.com\\private', 'https://backend.example.com:99999',
    ' https://backend.example.com', 'https://backend.example.com\n',
    'https://localhost', 'https://127.0.0.1', 'https://10.0.0.1', 'https://[::1]',
    'https://backend.local', 'https://backend.internal', 'https://century-pano.vercel.app']) {
    assert.throws(() => validateBackendOrigin(value), /WORLD_BACKEND_ORIGIN/);
  }
  for (const key of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL']) {
    assert.throws(() => validateBackendOrigin(ORIGIN, { [key]: 'backend.example.com' }), /cannot point/);
  }
  assert.equal(validateBackendOrigin('https://BACKEND.example.com/'), ORIGIN);
  assert.equal(validateBackendOrigin('https://backend.example.com:8443'), `${ORIGIN}:8443`);
  assert.throws(() => validateBackendOrigin(`https://backend.example.com/?token=${SENTINEL}`), (error) => !error.message.includes(SENTINEL));
});

test('missing origin and unsafe input fail before replacing existing output; env can override fallback', async () => {
  const previous = await readFile(path.join(output, 'config.json'), 'utf8');
  await assert.rejects(buildVercel({ root: fixture, env: { WORLD_BACKEND_ORIGIN: '' } }), /WORLD_BACKEND_ORIGIN/);
  assert.equal(await readFile(path.join(output, 'config.json'), 'utf8'), previous);
  await writeFile(path.join(fixture, 'deploy/vercel-backend.json'), '{"origin":null}');
  await assert.rejects(buildVercel({ root: fixture, env: {} }), /WORLD_BACKEND_ORIGIN/);
  await symlink(path.join(fixture, '.env'), path.join(fixture, 'web/secret-link.txt'));
  await assert.rejects(buildVercel({ root: fixture, env: { WORLD_BACKEND_ORIGIN: ORIGIN } }), /symbolic links/);
  assert.equal(await readFile(path.join(output, 'config.json'), 'utf8'), previous);
  await rm(path.join(fixture, 'web/secret-link.txt'));
  await buildVercel({ root: fixture, env: { WORLD_BACKEND_ORIGIN: 'https://override.example.com' } });
  const overridden = await readFile(path.join(output, 'config.json'), 'utf8');
  assert.ok(overridden.includes('https://override.example.com'));
  assert.ok(!overridden.includes(ORIGIN));
  assert.ok((await lstat(path.join(fixture, '.vercel/project.json'))).isFile());
});
