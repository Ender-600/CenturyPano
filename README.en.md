# CENTURY PANO

For the full four-mode frontend and authenticated backend, see [Vercel deployment](docs/VERCEL_DEPLOYMENT.md). Provider keys stay on the Python backend; the public site uses a separate application access code.

**Language / 语言:** [English](README.en.md) · [中文](README.md)

The same place, another era. The four top modes are, in order: panorama camera, your own historical panorama, Street View historical panorama, and Marble immersive worlds. The camera opens by default. All four modes share the year wheel, defaulting to **1926**, with any whole year from 1800 through the current year.

**Imagined reconstruction, not archival footage.** HackCMU 2026 · Traveling.

## What runs today

The mobile four-mode UI, FastAPI image pipeline, multi-provider photo editing, exact-year and place-based history reasoning, weather variants, hotspot explanations, map archive, disk cache, progressive tiles, then/now compare, phone motion following, and offline photo replay are implemented. Google Street View 360° historical edits, Marble 3D worlds, GPS / native walking, and along-route panorama preload are also supported. Mode and merge behavior: [four modes](docs/FOUR_MODES.md).

What ships in the repo is an **engineering sample**: a program-drawn street illustration with a local tone shift, no AI calls, not a real photograph, and not a claim about historical reconstruction quality. Real model quality, real model performance, and physical iPhone sensor acceptance still require configured keys; do not treat the local demo numbers below as Gemini results.

## Local setup

Python 3.11+ and Node.js/npm are required; `uv` is recommended. The frontend has no build step. Three.js and Spark come from local npm dependencies, not a runtime CDN.

```bash
uv sync --python 3.11
npm ci
cp .env.example .env
PROVIDER=demo uv run python scripts/seed_demo.py
./scripts/serve.sh
```

Open <http://localhost:8000>. In the default camera mode, capture or upload to enter photo-history mode, preview, pick a year on the wheel, then explicitly tap generate. The third mode generates a historical panorama from the current Google Street View location by itself; the fourth mode explicitly generates a Marble world and can reuse the same historical panorama. Switching tabs or scrolling the year does not start a paid generation. The menu still opens the engineering sample and the photo archive.

`seed_demo.py` only allows `PROVIDER=demo`. It creates city, campus-street, and 360 illustration replays plus a serial baseline for each. Re-uploading the same input, exact year, place, prompt version, and provider hits the cache, keeps the original metrics, and shows a replay badge. Before going offline, open each needed replay once in the same browser and confirm the archive shows “saved on this device.”

## Fullscreen window frontend

The panorama fills the phone screen; year and controls float lightly. Explore left/right, switch original / past / compare, and use clean mode. Upload preview stays on the original; after generation the UI shows progressive backend tiles and the final stitch. Changing year on the result screen restores the same photo’s preview first; the user must start a new generation explicitly. The archive stores the working image with EXIF stripped and keeps known capture coordinates or a manually entered city.

Capture, city and 360° settings, historical context, generation metrics, and download live in the top-right menu. Upload reads photo GPS; “Use current location” requests device location. A manually entered city overrides photo location and device GPS. After leaving the generation screen, the same browser’s archive can reopen an in-progress job. Clean mode hides chrome; tap the eye at the top right or press Escape to restore.

Phone motion following covers home, photo preview, and results, and stays on across screen changes. Use an HTTPS link: on iPhone, tap “Tap to enable motion view” in the center once and allow access; browsers that do not need an explicit permission prompt start listening automatically. Hold the phone upright with the rear camera facing forward, then turn left and right. The top-right menu can pause or re-zero the current heading. The view uses a horizontal projection of phone camera heading and supports portrait and landscape; drag, orientation changes, and briefly leaving the page re-establish the direction baseline to avoid jumps.

Node regression tests run the real frontend scripts and cover orientation math, simulated sensors, permission request and denial retry, home / preview / result / replay, portrait/landscape, drag, clean mode and pause/resume, plus exact year and place behavior. They do not replace acceptance on a physical phone.

## Historical street workbench

The full four-mode UI is the main app at `/`. `/world/` keeps a standalone Street View / Marble viewer for existing shares and native clients. You can also run the same backend with `uv run python scripts/serve_worlds.py --port 8001`.

The third mode needs `GOOGLE_MAPS_API_KEY`, `OPENAI_API_KEY`, and Street View AI use enabled; the fourth mode also needs `WORLDLAB_API_KEY`. The world image model is set with `WORLD_OPENAI_IMAGE_MODEL`; photo models still follow `PROVIDER` and its keys. See `.env.example`. Access codes follow the existing world API auth.

World data lives under `data/worlds/` (override with `WORLD_DIR`). Do not commit vendor keys, access codes, or generated assets. Phone follow and walking: [viewer notes](docs/WORLD_VIEWER.md), [real walking](docs/REAL_WALKING.md), and [predictive preload](docs/PREDICTIVE_WALKING.md). The legacy world proxy still exposes only world routes; the full app needs the main server.

## Frontend design demos

The adopted design reference is the [fullscreen window](http://localhost:8000/designs/window/). The main page follows that look and wires exact-year, place-based history generation. Compare all four proposals at <http://localhost:8000/designs/>. Standalone demos use a concept image and local tone simulation; the main home screen uses the same concept image, while upload preview and results use real photos and backend output. See [web/designs/README.md](web/designs/README.md).

## Connect real models

Put keys in a local `.env` only—not in the frontend, and not in Git. Restart the server after config changes.

```dotenv
PROVIDER=gemini
PROVIDER_FALLBACK=fal
GEMINI_API_KEY=your-key
XAI_API_KEY=your-key
FAL_KEY=your-key
K2_API_KEY=your-IFM-key
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
GEMINI_TEXT_MODEL=gemini-3.6-flash
GROK_IMAGE_MODEL=grok-imagine-image-2.0
K2_BASE_URL=https://api.ifm.ai/v1
K2_MODEL=IFM/K2-Horizon-375B-A23B
MAX_CONCURRENCY=6
```

K2 here is HackCMU sponsor **IFM K2**. Without a full K2 setup, Gemini text can be used; when history reasoning is unavailable, exact-year generic constraints apply and place history is marked unconfirmed. VLM failure falls back to a default scene; anchor failure still continues tiles. Real image-service failures do not silently fall back to local tone shifting: failed tiles keep the original crop and mark `done_partial`.

For Grok Imagine, set `PROVIDER=grok` and `XAI_API_KEY`. Default model is `grok-imagine-image-2.0` (`GROK_IMAGE_MODEL` overrides).

Probe a single call before preparing real-photo replays. These commands use your configured services and incur usage; baseline runs one extra full pass.

```bash
uv run python scripts/probe_providers.py /absolute/path/panorama.jpg
uv run python scripts/make_replay.py /absolute/path/panorama.jpg 1945 --place "Pittsburgh, Pennsylvania, US"
# Skip baseline: add --no-baseline
# Run serial baseline alone:
uv run python scripts/baseline.py JOB_ID
```

Official docs: [Gemini image editing](https://ai.google.dev/gemini-api/docs/generate-content/image-generation), [Grok Imagine image editing](https://docs.x.ai/developers/rest-api-reference/inference/images), [fal img2img](https://fal.ai/models/fal-ai/flux/dev/image-to-image/api), [IFM quickstart](https://docs.ifm.ai/#/quickstart), [IFM JSON output](https://docs.ifm.ai/#/structured-output).

## Phone HTTPS demo

Phone sensors and geolocation need a secure context. Run the server on a computer, then open an HTTPS tunnel:

```bash
cloudflared tunnel --url http://localhost:8000 --protocol http2
uv run python scripts/make_qr.py https://the-url-from-the-terminal.trycloudflare.com
```

The QR code is written to `data/demo-qr.png`. Quick Tunnel is a temporary demo entrance; keep both the computer and the tunnel process running. For lasting service, use Docker plus your own HTTPS reverse proxy. Tunnel setup: [Cloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

```bash
docker build -t century-pano .
docker run --rm -p 8000:8000 --env-file .env -v "$PWD/data:/data" century-pano
```

This is a single-instance contest app: job state and locks live in one Uvicorn worker. Do not add `--workers`. Public real generation should sit behind your access control; model cost is billed to the server keys.

## Architecture and data

```text
Upload original → EXIF / offline city → preprocess → VLM present-day scene
                                                      ↓
                        Exact year + GPS/city → local history and parcel change
                                                      ↓
                              Freeze shared prompt → Gemini anchor
                                                      ↓
                     Viewport-first parallel tiles → Lab color match → cosine feather stitch
                                                      ↓                              ↓
                                          raw / matched tiles                  result + metrics
                                                      └──── manifest.json ──────────┘
                                                                   ↓ every 500ms
                                                     Progressive UI / compare / replay
```

- `app/main.py`: HTTP, upload checks, privacy boundary, job start.
- `app/pipeline.py`: parallel pipeline, disk cache, isolated baseline jobs.
- `app/geometry.py`, `consistency.py`, `stitch.py`, `metrics.py`: imagery and metrics.
- `app/editors/`, `scene.py`, `constraints.py`: model adapters and failure recovery.
- `web/`: no-build mobile UI and Service Worker.
- `data/in/`: original uploads, keep files and EXIF, never served over HTTP.
- `data/out/JOB_ID/`: atomic manifest, band, anchor, `tN_raw.jpg`, `tN.jpg`, result.
- `data/out/.cache/`: exact cache keys and a request index that avoids repeat text-model calls.

All manifest writes go through one job lock and temp-file replace. The frontend only reads generated outputs and a scaled preview. Location priority: manual place override, original EXIF, browser geolocation, none. Browser location is only a fallback for capture place—check that it matches the photo. Available GPS and resolved city/state/country feed history reasoning and image prompts; coordinates do not prove parcel history. Manual cities are not disguised as precise GPS; disambiguate same names with state/country; unknown manual text is display-only and does not enter model prompts.

## Year and place history

All four modes share the target year (default 1926). The year wheel moves one year at a time with touch, mouse, and keyboard, and still supports exact entry. Generated images keep the year they were actually made for; choosing another target year requires an explicit new generation. Each year uses **1 July** as the reference date so events from different parts of the year are not blended into one frame. 1945 and 1950 are reasoned separately for the location—do not reuse the same decade style, and do not apply one wartime condition to every city.

The history model receives the exact year, capture place, and present scene, and returns period context, events, whether the parcel was developed, suggested building change, and uncertainty. All history modes may change building height, silhouette, roads, and land use from that context; camera pose, direction, and projection stay fixed. Photo-pipeline `STRUCTURE_LOCK` is off by default; set it to `1` only for the older structure-lock experiment. Undeveloped parcels may show natural terrain or farmland. Anchor and every tile share one prompt.

Reasoning currently uses model knowledge only—**no historical maps, cadastre, or archive retrieval**. The UI shows evidence basis and open uncertainties; city-level place does not prove a specific parcel’s past. Demo mode still only simulates tone and does not represent architectural reconstruction. Full contract: [historical context](docs/HISTORICAL_CONTEXT.md).

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/jobs` | multipart `image`, `target_year`, `lat`, `lon`, `place`, `heading`, `is_360` |
| GET | `/jobs/{id}/manifest` | single source of truth, `Cache-Control: no-store` |
| GET | `/jobs/{id}/preview` | EXIF-stripped working image |
| GET | `/jobs/{id}/tiles/{i}?raw=1` | raw tile; omit `raw` for color-matched |
| GET | `/jobs/{id}/result` | final stitch |
| POST | `/jobs/{id}/baseline` | background serial rerun, 202, progress via the same manifest |
| GET | `/replays` | completed replay list |
| POST | `/preview` | server JPEG preview when HEIC fails in the browser |
| POST | `/location/resolve` | offline city lookup |
| GET | `/health` | provider and config status plus year range, no secrets |

`target_year` accepts integers from 1800 through the current year and takes priority over the legacy `decade` field. Old four-era requests and stored replays still load; manifest `target_year` and `anchor_year` are the real target year, and `decade` is only for grouping.

## Tests and measured numbers

```bash
uv run pytest -q
uv run ruff check app scripts tests
node --check web/app.js
node --check web/sw.js
node --test tests/*.mjs tests/*.cjs
```

Automation covers the four tile widths from the spec; narrow, ultra-wide, and 360 inputs; raw/matched tiles; timestamps; controlled color-match experiments; missing-tile fallback; zero model-call cache hits; isolated serial baseline; real API request shapes; retry/circuit break; privacy boundaries; invalid uploads and concurrent atomic writes.

Numbers below were recorded on this machine on 2026-09-12 with the local **demo tone simulator** (about 0.5 s of async wait to exercise progressive UI). They are not AI-service performance and are not evidence of reconstruction quality:

| Engineering sample | First tile / s | Total / s | Serial / s | Speedup |
|---|---:|---:|---:|---:|
| City street | 1.9130 | 2.8679 | 6.1963 | 2.161 |
| Campus block | 1.9765 | 3.0154 | 6.2509 | 2.073 |
| 360 loop | 2.1925 | 4.7950 | 9.9622 | 2.078 |

The local simulator uses the same grading, so the city sample has `seam_err.raw=0` and `after_color_match=0.35617` and therefore **does not validate seam improvement on a real image job**. Real acceptance needs at least one live job with `raw > after_color_match`, plus measured Gemini/fal wall time versus baseline.

## Spec edges and remaining on-device checks

- To keep at most 8 tiles with overlap, ultra-wide working width is capped at 7114 px (360 keeps extra wrap margin); full horizontal content is kept. Inputs narrower than one tile scale up to 1024 px without inventing pixels.
- 360 stitch folds wrap-region contribution back so a simple crop does not drop end blend.
- Audio is an original local WAV, not MP3—no external asset license and no runtime download.
- System `<input capture>` cannot guarantee every phone camera UI exposes panorama mode; shoot a panorama in the system camera, then pick it from the library. HEIC preview is handled on the server when needed.
- Physical iPhone Safari/Chrome still needs on-device checks for slider, drag, camera, sensor permission, heading sign, and audio unlock.
- Live Gemini/fal probes, real panoramas, real seam improvement, real speedup, and 3–4 real replays still need keys and photos.

Do not treat unmet original H0–H4 gates as done. Without keys, everything else that can be verified independently is finished; real acceptance results are never faked.

## 3-minute demo outline

1. **0:00–0:30**: Time travel at one place; one line that this is imagined reconstruction, not archival film.
2. **0:30–1:30**: Prefer a cached real replay; say the timings belong to that earlier run; drag, turn the phone, use the slider.
3. **1:30–2:30**: Show real first-view time, total time, and serial speedup; compare raw vs matched seam numbers and explain the global anchor plus color match.
4. **2:30–3:00**: Show your own panorama upload and preview; continue to a live generation if network and quota allow.

Use the live-performance lines only after a real-photo replay is ready; call out engineering samples as pipeline simulation only.
