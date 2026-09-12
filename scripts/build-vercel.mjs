import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATIC_SOURCES = [
  ['web', ''],
  ['node_modules/three/build', 'world-vendor/three/build'],
  ['node_modules/three/examples/jsm', 'world-vendor/three/examples/jsm'],
  ['node_modules/@sparkjsdev/spark/dist', 'world-vendor/@sparkjsdev/spark/dist'],
];
const ORIGIN_ERROR = 'WORLD_BACKEND_ORIGIN must be a public HTTPS origin without credentials, path, query, or fragment.';
const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};
const PUBLIC_HEADERS = {
  'Cache-Control': 'public, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
};

export function validateBackendOrigin(value, env = {}) {
  // Do not echo invalid input: it might be a mistakenly pasted credential.
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/?$/i.test(value)) {
    throw new Error(ORIGIN_ERROR);
  }
  let url;
  try { url = new URL(value); } catch { throw new Error(ORIGIN_ERROR); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !host.includes('.') || /^[\d.]+$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal)$/.test(host)
      || !host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) {
    throw new Error(ORIGIN_ERROR);
  }
  const selfHosts = new Set(['century-pano.vercel.app']);
  for (const key of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL']) {
    if (!env[key]) continue;
    try { selfHosts.add(new URL(`https://${env[key]}`).hostname.toLowerCase()); } catch { /* Not an origin. */ }
  }
  if (selfHosts.has(host)) throw new Error('WORLD_BACKEND_ORIGIN cannot point to this Vercel frontend.');
  return url.origin;
}

export function createRoutingConfig(origin) {
  // Every API terminates at the authenticated gateway. Never replace this
  // allowlist with a catch-all proxy to the Python application.
  const exact = ['app-session', 'world-config', 'world-session', 'world-auth', 'health', 'preview', 'replays', 'location/resolve'];
  const families = ['world-plans', 'world-jobs', 'world-prefetch', 'jobs', 'out'];
  const paths = [...exact, ...families.map((name) => `${name}(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*`)];
  return {
    version: 3,
    routes: [
      { src: '^/.*$', headers: PUBLIC_HEADERS, continue: true },
      ...paths.map((pattern) => ({
        src: `^/(${pattern})$`, dest: `${origin}/$1`, headers: NO_STORE, caseSensitive: true,
      })),
      { src: '^/world$', methods: ['GET', 'HEAD'], status: 307, headers: { Location: '/world/' }, caseSensitive: true },
      { src: '^/$', methods: ['GET', 'HEAD'], dest: '/index.html' },
      { src: '^/world/$', methods: ['GET', 'HEAD'], dest: '/world/index.html', caseSensitive: true },
      { handle: 'filesystem' },
      { src: '^/.*$', status: 404, headers: NO_STORE },
    ],
  };
}

function publicFile(source) {
  const name = path.basename(source);
  return !name.startsWith('.') && !/\.(?:md|pem|key|env)$/i.test(name);
}

async function checkPublicTree(directory) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink()) throw new Error('Static deployment inputs must not contain symbolic links.');
  if (stat.isDirectory()) {
    for (const entry of await readdir(directory)) {
      if (publicFile(entry)) await checkPublicTree(path.join(directory, entry));
    }
  } else if (!stat.isFile()) {
    throw new Error('Static deployment inputs must be regular files.');
  }
}

export async function buildVercel({ root = ROOT, env = process.env } = {}) {
  let fallback;
  try { fallback = JSON.parse(await readFile(path.join(root, 'deploy/vercel-backend.json'), 'utf8')).origin; }
  catch { throw new Error('Cannot read deploy/vercel-backend.json.'); }
  const origin = validateBackendOrigin(env.WORLD_BACKEND_ORIGIN ?? fallback, env);
  for (const [source] of STATIC_SOURCES) await checkPublicTree(path.join(root, source));
  const output = path.join(root, '.vercel/output');
  // Preserve .vercel/project.json and CLI metadata. Replace generated output
  // only after configuration and public source trees have validated.
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'static'), { recursive: true });
  for (const [source, destination] of STATIC_SOURCES) {
    await cp(path.join(root, source), path.join(output, 'static', destination), {
      recursive: true, filter: publicFile,
    });
  }
  await writeFile(path.join(output, 'config.json'), `${JSON.stringify(createRoutingConfig(origin), null, 2)}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await buildVercel();
    console.log('Built the static app and authenticated API proxy in .vercel/output.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
