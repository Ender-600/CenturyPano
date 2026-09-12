# Vercel deployment

The full four-mode frontend is served by Vercel. Camera and photo history use
`/`; Street View and Marble worlds use the embedded viewer at `/world/`.
FastAPI and generation workers run on a separate authenticated backend.

## Project settings

Connect `Ender-600/CenturyPano`, production branch `main`, with the repository
root as Root Directory. The committed `vercel.json` supplies:

- Framework: Other (`null` in JSON)
- Install: `npm ci`
- Build: `npm run build:vercel`
- Output: generated `.vercel/output`, using Build Output API v3

Keep dashboard command and output-directory overrides disabled. Vercel needs
no model API keys or application access code. The build copies frontend files
and Three.js / Spark dependencies, not `.env`, Python source or generated user
assets. An explicit static build avoids starting the disk-based Python app as
a Vercel Function.

## Backend origin

Set **WORLD_BACKEND_ORIGIN** in Vercel's Environment Variables, or set the
public demo origin in `deploy/vercel-backend.json`. Use an HTTPS origin without
a path, credentials, query string or fragment. Redeploy after a change: routing
is generated during the build. This is a public server address, not a secret.

The origin must point to the authenticated **full-app gateway**, not directly
to Uvicorn and not to the older world-only gateway. It must expose `/app-session`
and protect photo uploads, generated assets, archives and world APIs.

The initial demo backend runs on the development computer through a temporary
Cloudflare tunnel. The computer, FastAPI, gateway and tunnel must remain running.
A new tunnel gets a new URL; update the origin and redeploy. The Vercel hostname
is stable, but it does not make this backend independent of the computer.

For permanent hosting, run the backend and gateway on a server with HTTPS and
persistent `IN_DIR`, `OUT_DIR`, `WORLD_DIR` storage. Keep one Uvicorn worker. Set
provider credentials and a persistent `WORLD_ACCESS_TOKEN` on that server,
then update Vercel's backend origin.

## Running the demo backend

Use a dedicated checkout and private `.env`. Never commit the environment file.
Install Python dependencies with `uv sync` and frontend dependencies with
`npm ci`. Start the backend and gateway in separate terminals:

```bash
uv run python scripts/serve_worlds.py --env-file .env --port 8010
uv run python scripts/serve_app_access.py --port 8005 --upstream http://127.0.0.1:8010 --public-origin https://century-pano.vercel.app
cloudflared tunnel --url http://127.0.0.1:8005 --protocol http2
```

Use the tunnel's HTTPS origin as `WORLD_BACKEND_ORIGIN`. Preview deployments
need their exact origin added to the gateway's allowed public origins before
cookie-authenticated POST requests can work there.

## Access code

On the public site, enter the existing application access code. This is separate
from all provider API keys. `/app-session` validates it against the backend's
protected `/world-auth` endpoint and establishes an HttpOnly, Secure, SameSite
session cookie. Browser requests and images then use the same session. Codes
are not embedded in Vercel files or asset URLs.

The gateway verifies authentication before forwarding private requests and
checks allowed origins for cookie-authenticated writes. `/world-session` remains
blocked remotely; it never returns the development token. API responses use
`Cache-Control: no-store`. Unknown routes do not fall through to arbitrary
backend endpoints.

Local loopback development can still run the full app without the public gate.
Public offline caching is disabled so a later signed-out browser does not use
previously saved private photo assets as an authenticated response.

## Verification

```bash
npm ci
npm run build:vercel
node --test tests/test_vercel_build.mjs tests/test_app_access.mjs
uv run pytest tests/test_app_access.py
curl -I https://century-pano.vercel.app/
curl -I https://century-pano.vercel.app/world/
curl -i https://century-pano.vercel.app/app-session
curl -i https://century-pano.vercel.app/replays
curl -i https://century-pano.vercel.app/world-session
```

Expect HTML and JavaScript, an unauthenticated session state before login, and
rejection of private API access without a session. A successful build or `Ready`
status alone is not application verification. Read-only checks and photo
previews do not submit a paid generation request; real generation and physical
phone camera/GPS/motion checks remain separate acceptance tests.

Vercel's external proxy timeout is 120 seconds. Generation jobs continue on the
backend, but plan creation and prefetch still perform some preparation before
returning. Slow preparation can exceed the proxy limit. Longer preparation
should become a background job with status polling. After a timeout, inspect
the existing job before submitting generation again.

References: [Build Output API](https://vercel.com/docs/build-output-api),
[routing configuration](https://vercel.com/docs/build-output-api/configuration),
[external proxy timeout](https://vercel.com/docs/errors/router_external_target_error).
