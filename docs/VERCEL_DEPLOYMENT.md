# Vercel deployment

The full four-mode frontend is served by Vercel. Camera and photo history use
`/`; Street View and Marble worlds use the embedded viewer at `/world/`.
FastAPI and generation workers run on a separate backend. The production site
opens directly without a visitor account or access code.

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

The origin points to the **full-app gateway**, which runs with `--public` for
this deployment. The gateway uses the private backend token only on its local
connection to Uvicorn; browsers receive neither that token nor provider keys.

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
uv run python scripts/serve_app_access.py --port 8005 --upstream http://127.0.0.1:8010 --public-origin https://century-pano.vercel.app --public --env-file .env
cloudflared tunnel --url http://127.0.0.1:8005 --protocol http2
```

Use the tunnel's HTTPS origin as `WORLD_BACKEND_ORIGIN`. Preview deployments
need their exact origin added to the gateway's allowed public origins before
POST requests can work there.

## Public access

Production uses `--public --env-file .env`. Anyone can open all four modes,
upload photos, read the shared archive and request image/world generation.
Generation uses the configured OpenAI and World Labs accounts. This public mode
was explicitly selected for the demo.

`/app-session` returns `{"authenticated":true,"access_mode":"public"}` so both
the full app and standalone world viewer open automatically. No visitor session
cookie or access code is needed. The gateway reads `WORLD_ACCESS_TOKEN` from
the private environment and sends it only to the local backend. Provider keys
and that token are never included in frontend files, URLs or responses.

The gateway retains the explicit route allowlist, upload limits, browser-origin
checks on writes and `Cache-Control: no-store` on API responses. `/world-session`
remains blocked so it cannot disclose the local development token. A backend
credential/configuration failure returns a service error, not a visitor login.

Running the gateway without `--public` retains the optional private access-code
mode. Local loopback/LAN development still works directly with FastAPI. Public
offline caching remains disabled so API responses reflect the live backend.

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

Expect HTML and JavaScript, a public session state, and working API reads
without cookies or Authorization. `/world-session` must still return 403. A successful build or `Ready`
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
