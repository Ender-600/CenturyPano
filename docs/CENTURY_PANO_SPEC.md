# CENTURY PANO — Build Spec for Coding Agent

**Product:** A mobile web app. User shoots a panorama on their phone, picks a decade, and within ~4–6 s sees the tile they are facing re-rendered as that decade; remaining tiles fill in; a before/after wipe reveals the full result; the panorama pans as the phone rotates.

**Track:** HackCMU 2026 · Traveling. **Deadline:** 2026-09-12 16:00 EDT.

**How to read this document**
- Sections marked **[NORMATIVE]** are contracts. Implement exactly. Do not rename fields, change types, or "improve" them.
- Sections marked **[GUIDANCE]** describe intended behavior; you may choose implementation details.
- Section 3 (**NON-GOALS**) lists things you MUST NOT build even if they seem helpful.
- Build in the order given in Section 14. Stop at each gate and verify.

---

## 1. Constants [NORMATIVE]

```python
TILE = 1024                 # tile width and height, px
H = 1024                    # working band height, px
STEP_TARGET = 870           # target horizontal step between tiles, px
N_MIN, N_MAX = 3, 8         # tile count clamp
BAND_FRAC_360 = 1/3         # vertical band kept from an equirect (middle third ≈ ±30° elevation)
ANCHOR_MAX_ASPECT = 21/9    # anchor image max width:height after anisotropic squeeze
COLOR_MATCH_K = 0.8         # Reinhard transfer strength
MAX_CONCURRENCY = 6         # parallel image-edit calls (env-overridable)
POLL_MS = 500               # frontend manifest polling interval
WIPE_MS = 1500              # auto-reveal wipe duration
GYRO_SMOOTH = 0.15          # low-pass factor per animation frame
PANO_FOV_PHONE_DEG = 120    # assumed sweep for non-360 phone panoramas (tunable)
MAX_UPLOAD_MB = 40

DECADE_ANCHOR = {"1900s": 1905, "1920s": 1925, "1950s": 1955, "1970s": 1975}
DEFAULT_DECADE = "1920s"
```

---

## 2. Scope [NORMATIVE]

### P0 (must ship)
- Web app only. Responsive. Must work in mobile Safari and Chrome. Served over HTTPS.
- Input: **one panorama image shot by the user** (phone panorama mode or a true 360 equirect). Nothing else.
- Preview-before-generate screen with a **Retake** button.
- Location chain: browser Geolocation → EXIF GPS → manual text → none. Reverse geocode **offline** with `reverse_geocoder` to **city level only**.
- Decade picker (UI shows decades; backend maps to an anchor year).
- Pipeline: preprocess → scene parse (VLM) → constraints (LLM) ∥ anchor generation → tiling → parallel tile generation with viewport priority → color match to anchor → feathered stitch → manifest.
- Progressive display via manifest polling.
- **Magic window**: panorama pans with device orientation (relative), falls back to drag.
- Auto-wipe reveal on completion, fullscreen during reveal, 2 s ambient audio.
- Before/after slider with an explicit handle.
- Full on-disk caching; **replay mode** loads a finished job with zero API calls.
- Metrics in manifest: first_view_s, total_s, seam_err (3 variants), serial baseline & speedup.
- Raw (pre-color-match) tiles retained and servable.

### P1 (only after all P0 gates pass)
- Multi-decade tabs on the same panorama (reuses geometry; new constraints + anchor per decade).
- Sphere viewer (three.js) for true-360 inputs only.
- Camera underlay (getUserMedia) beneath the past-panorama for a ghost-overlay effect.
- Street View historical-imagery comparison (generate "2011" from a 2023 pano, show real 2011 next to it). Attribution required.
- Ken Burns idle animation.

---

## 3. NON-GOALS — MUST NOT BUILD [NORMATIVE]

- ❌ Native iOS/Android app.
- ❌ Any Google Maps / Street View / 3D Tiles **as an input source** or as an automatic fallback. No API calls to Google in P0. (Manually downloaded Street View panoramas may be used only as pre-baked replay examples with attribution.)
- ❌ Automatic switching of input source based on location or coverage.
- ❌ Stitching multiple user photos into a panorama. Use the phone's native panorama mode via `<input capture>`.
- ❌ Extending / outpainting the panorama left or right.
- ❌ Video input.
- ❌ Depth estimation / RGBD / parallax / walkable scenes / world models (Marble etc.). Single-viewpoint panorama only.
- ❌ Any claim of historical accuracy. UI must show a "reconstruction, not historical imagery" notice.
- ❌ Street-level addresses in prompts. City level only.
- ❌ Per-tile prompt variation. `prompt_global` is one immutable string for all tiles.
- ❌ WebSockets. Polling only.
- ❌ Databases, queues, Redis. Filesystem is the state.
- ❌ API keys in frontend code.
- ❌ CV-based seam/quality detectors on the input. The preview screen + Retake button replaces them.
- ❌ Pre-recorded video as the demo. Replay must be the live page loading a real manifest.

---

## 4. Data Contracts [NORMATIVE]

### 4.1 `POST /jobs` (multipart/form-data)

| field | type | required | notes |
|---|---|---|---|
| `image` | file | yes | JPEG/PNG/HEIC. Server converts HEIC→JPEG **after** reading EXIF. |
| `decade` | string | no | one of `DECADE_ANCHOR` keys; default `"1920s"` |
| `lat`, `lon` | float | no | from Geolocation or EXIF |
| `place` | string | no | manual user text |
| `heading` | float 0–1 | no | viewport center as fraction of panorama width at submit time; default 0.5 |
| `is_360` | bool | no | if absent, infer: `abs(w/h - 2.0) < 0.1` |

Response: `201 {"job_id": "<uuid>"}`

### 4.2 `manifest.json` — single source of truth

```json
{
  "job_id": "abc123",
  "status": "running | done | done_partial | error",
  "mode": "live | replay",
  "source": {"path": "in/abc123.jpg", "w": 12000, "h": 3000, "is_360": false},
  "place": {"name": "Pittsburgh", "admin1": "Pennsylvania", "cc": "US",
            "lat": 40.44, "lon": -79.99, "source": "geolocation | exif | manual | none"},
  "decade": "1920s",
  "anchor_year": 1925,
  "geometry": {"H": 1024, "W": 4096, "W_ext": 4096, "tile_w": 1024, "n": 5,
               "step": 768, "overlap": 256, "wrap": false, "band": null,
               "x": [0, 768, 1536, 2304, 3072]},
  "scene": { "...SceneSpec...", "fallback": false },
  "constraints": { "...ConstraintSpec..." },
  "anchor": {"status": "pending | running | done | skipped | error",
             "path": "out/abc123/anchor.jpg", "ms": 4100},
  "tiles": [
    {"i": 0, "x": 0, "priority": 2, "status": "pending | running | done | error",
     "raw_path": "out/abc123/t0_raw.jpg", "path": "out/abc123/t0.jpg",
     "ms": 3120, "attempts": 1, "provider": "gemini", "error": null}
  ],
  "result": {"path": "out/abc123/result.jpg", "status": "pending | done"},
  "metrics": {
    "started_at": 1757731200.0,
    "anchor_done_at": 1757731204.1,
    "first_tile_at": 1757731207.3,
    "finished_at": 1757731212.8,
    "first_view_s": 7.3,
    "total_s": 12.8,
    "seam_err": {"raw": 18.4, "after_color_match": 6.1, "originals_floor": 2.3},
    "serial_baseline_s": null,
    "speedup": null,
    "image_calls": 6,
    "tokens": {"vlm": 1830, "llm": 640}
  }
}
```

Rules:
- Write atomically: write `manifest.json.tmp`, then `os.replace`. All writes go through one lock-guarded `update_manifest(job_id, fn)`.
- `first_tile_at` is set when the **first tile reaches status `done`** (after color match).
- `tiles[].x` are left edges in the extended canvas (`W_ext`).

### 4.3 `SceneSpec` (VLM output, strict JSON)

```json
{
  "summary": "string, ≤ 60 words",
  "modern_elements": ["cars", "traffic lights", "asphalt", "glass storefronts", "power lines", "LED signage"],
  "keep_structure": ["road alignment", "building footprints and heights", "skyline silhouette", "horizon line"],
  "sky_fraction": 0.35
}
```
On any failure (timeout, invalid JSON): use `DEFAULT_SCENE_SPEC` and set `scene.fallback = true`. Never block the pipeline.

### 4.4 `ConstraintSpec` (LLM output)

```json
{
  "decade": "1920s",
  "anchor_year": 1925,
  "era_facts": ["streetcars on rails, no buses", "brick or cobblestone paving",
                "gas or early electric lamps", "no traffic signals",
                "painted signboards", "horse carts alongside early autos"],
  "prompt_global": "Same viewpoint and composition. Re-render this as a photograph taken in 1925 in Pittsburgh, USA. <era_facts joined>. Remove: <modern_elements joined>. Keep: <keep_structure joined>. Period photograph, mild sepia, slight grain.",
  "negative": "modern cars, traffic lights, glass curtain wall, LED, asphalt sheen, power lines, plastic",
  "immutable": true
}
```
Rules:
- LLM reasons at **decade** granularity (`era_facts` must hold across the whole decade).
- `prompt_global` embeds the **specific** `anchor_year`.
- Location in the prompt is **city + country only**.
- `prompt_global` is constructed once and frozen (e.g. `types.MappingProxyType` or a frozen dataclass). Any code path that tries to modify it is a bug.

---

## 5. Interfaces [NORMATIVE]

### 5.1 Image editor adapter

```python
from typing import Protocol

class ImageEditor(Protocol):
    name: str
    async def edit(
        self,
        image: bytes,                 # JPEG, 1024x1024 tile or anchor image
        prompt: str,
        *,
        reference: bytes | None = None,   # style reference (anchor crop). May be ignored by provider.
        strength: float | None = None,    # img2img providers only
        seed: int | None = None,
        negative: str | None = None,
        timeout_s: float = 60.0,
    ) -> bytes: ...                       # JPEG bytes
```

Implement:
- `GeminiEditor` — primary. Multi-image prompt: image 1 = tile, image 2 = reference; instruction "Edit image 1 to match the era, lighting, palette and sky of image 2. Keep image 1's composition."
- `FalImg2ImgEditor` — fallback. SDXL/Flux img2img, `strength=0.45`, `seed=job_seed`.
- `get_editor(name) -> ImageEditor`; selection via env `PROVIDER`, `PROVIDER_FALLBACK`.
- Retry: 3 attempts, backoff 1 s / 2 s / 4 s. Circuit breaker: after 2 consecutive failures on primary, switch remaining tiles to fallback.

### 5.2 Geometry

```python
def plan_tiles(W_ext: int) -> tuple[int, float, float, list[int]]:
    """Returns (n, step, overlap, x_list)."""
    n = math.ceil((W_ext - TILE) / STEP_TARGET) + 1
    n = max(N_MIN, min(N_MAX, n))
    step = (W_ext - TILE) / (n - 1) if n > 1 else 0
    overlap = TILE - step
    x = [round(i * step) for i in range(n)]
    assert x[-1] + TILE == W_ext or abs(x[-1] + TILE - W_ext) <= 1
    return n, step, overlap, x
```

### 5.3 Reverse geocode (offline)

```python
import reverse_geocoder as rg
def city_from_latlon(lat, lon) -> dict:
    r = rg.search((lat, lon))[0]
    return {"name": r["name"], "admin1": r["admin1"], "cc": r["cc"]}
```
No network geocoding in P0.

---

## 6. Pipeline [NORMATIVE order, GUIDANCE details]

```
run_job(job_id):
  0  t0 = now(); manifest.status = running
  1  preprocess          → band image (H=1024, W), W_ext, wrap flag
  2  scene = parse_scene(band)            # VLM, 15 s timeout, fallback on failure
  3  ∥ constraints = build_constraints(place, decade, scene)     # LLM (K2)
     ∥ anchor = gen_anchor(band, generic_decade_prompt(decade))  # ImageEditor
        (these two run concurrently; anchor does NOT wait for constraints)
  4  n, step, overlap, x = plan_tiles(W_ext); write geometry
  5  tiles_raw[i] = crop(band_ext, x[i], TILE)
     anchor_crop[i] = crop_and_resize(anchor, corresponding region → 1024x1024)  (if anchor.done)
  6  priorities = viewport_priority(x, heading, W_ext, wrap)
  7  for each tile in priority order, up to MAX_CONCURRENCY at once:
        out = editor.edit(tiles_raw[i], prompt_global, reference=anchor_crop[i], seed=job_seed)
        save t{i}_raw.jpg
        out = color_match(out, anchor_crop[i], k=COLOR_MATCH_K)   (skip if anchor skipped)
        save t{i}.jpg; tile.status = done; set first_tile_at if unset
  8  result = stitch(tiles, x, overlap, wrap); save result.jpg
  9  metrics = compute_metrics(); manifest.status = done | done_partial
```

### 6.1 Preprocess
- Read EXIF (GPS) **before** any re-encode.
- If `is_360`: resize to height `3 * H`, crop the middle `H` rows → band. `geometry.band = [H, 2H]`.
- Else: resize to height `H` → band.
- If `is_360`: append the leftmost `overlap_est` px (use `TILE - STEP_TARGET`) to the right edge → `band_ext`; `wrap = true`; `W_ext = W + overlap_est`. Else `band_ext = band`, `W_ext = W`.
- Aspect check: if `w/h < 2.0` show a non-blocking warning ("this looks narrow"); still allow generation.

### 6.2 Anchor
- Anisotropically squeeze `band` to width `min(W, H * ANCHOR_MAX_ASPECT)` (height stays `H` or scales to ≤1024). Geometry distortion is acceptable; the anchor supplies only sky/lighting/palette/era style.
- One `editor.edit()` call with a generic decade prompt (no scene specifics). Save `anchor.jpg`.
- On failure: `anchor.status = skipped`; downstream skips reference and color match.

### 6.3 Viewport priority
```python
def viewport_priority(x, heading, W_ext, wrap):
    c = heading * W_ext
    out = []
    for xi in x:
        d = abs((xi + TILE/2) - c)
        if wrap: d = min(d, W_ext - d)
        out.append(0 if d < TILE else 1 if d < 2*TILE else 2)
    return out
```
Heading is **locked at submit time**. Do not re-prioritize while the job runs.

### 6.4 Color match (deterministic)
```python
def color_match(tile_rgb, ref_rgb, k=0.8):
    t = rgb2lab(tile_rgb); r = rgb2lab(ref_rgb)
    for c in range(3):
        mt, st = t[...,c].mean(), t[...,c].std() + 1e-6
        mr, sr = r[...,c].mean(), r[...,c].std() + 1e-6
        t[...,c] = (t[...,c] - mt) * (sr/st) * k + (mr*k + mt*(1-k))
    return lab2rgb(t)
```

### 6.5 Stitch
- Canvas `W_ext × H`, float accumulators for RGB and weight.
- Per tile weight `w(u)` across its width: 1 in non-overlap; in each overlap band ramp with `0.5 - 0.5*cos(pi*t)`, `t∈[0,1]`.
- Missing/error tiles contribute the **original** band crop with the same weights; mark job `done_partial`.
- If `wrap`: after normalization, crop canvas back to `W`.

### 6.6 Metrics
- `seam_err`: for each adjacent pair, mean ΔE (Lab Euclidean) between the two tiles' pixels inside their overlap region, **before blending**; average across seams. Compute three variants: `raw` (from `t{i}_raw`), `after_color_match` (from `t{i}`), `originals_floor` (from the original band crops).
- `serial_baseline_s`: populated by `POST /jobs/{id}/baseline` which re-runs the same job with `MAX_CONCURRENCY=1` and writes the total.
- `speedup = serial_baseline_s / total_s`.

---

## 7. HTTP API [NORMATIVE]

| method & path | behavior |
|---|---|
| `POST /jobs` | create job, start background task, return `job_id` |
| `GET /jobs/{id}/manifest` | return manifest.json; `Cache-Control: no-store` |
| `GET /jobs/{id}/tiles/{i}` | `t{i}.jpg`; with `?raw=1` return `t{i}_raw.jpg` |
| `GET /jobs/{id}/result` | `result.jpg` |
| `POST /jobs/{id}/baseline` | re-run with concurrency 1; write `serial_baseline_s`, `speedup` |
| `GET /replays` | list jobs with `mode=replay` |
| `GET /jobs/{id}/audio` | returns the ambient clip for the job's decade (static file) |

Stack: Python 3.11, FastAPI, asyncio, httpx, Pillow + pillow-heif, numpy, scikit-image (rgb2lab/lab2rgb), reverse_geocoder. No DB.

Config via env: `PROVIDER`, `PROVIDER_FALLBACK`, `GEMINI_API_KEY`, `FAL_KEY`, `K2_API_KEY`, `MAX_CONCURRENCY`, `OUT_DIR`.

---

## 8. Frontend [NORMATIVE behaviors, GUIDANCE implementation]

Single page. Vanilla JS acceptable. Must be served over **HTTPS**.

### 8.1 Screens
1. **Capture** — primary button "拍摄" using `<input type="file" accept="image/*" capture="environment">`. Secondary "从相册选择". Tertiary "试试示例" (loads a replay). Under the primary button, one line: *"慢慢转身约 90 度，5 秒就够"*.
   - MUST use `<input capture>` for capture (opens system camera where panorama mode is available). Do NOT use `getUserMedia` for capture.
2. **Preview** — shows the uploaded panorama full-width, pannable. Buttons: **重拍** / **继续**. Decade picker (chips: 1900s · 1920s · 1950s · 1970s; default 1920s). On mount, request Geolocation (5 s timeout, silent fail) and read EXIF client-side (`exifr`); show place name if resolved, else a text field "这是哪？".
   - Submit sends `heading` = current viewport center fraction.
3. **Result** — panorama viewport with progressive tiles, wipe reveal, slider, decade label, place label, notice text: *"想象重建，非历史影像"*, and "回放" badge when `mode=replay`.

### 8.2 Viewport
- Horizontal panning is **mandatory**. Container has `touch-action: pan-y`; in `touchmove`, if |dx| > |dy| call `preventDefault()` and pan.
- One state variable `offset` (px). Two input sources write to it: pointer drag, and device orientation. One render loop reads it.
- If `wrap`: render the panorama twice side by side and modulo the offset for seamless looping.

### 8.3 Magic window (device orientation)
```js
async function enableGyro() {
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    if (await DeviceOrientationEvent.requestPermission() !== 'granted') return false; // must be inside a click handler
  }
  window.addEventListener('deviceorientation', onOrient);
  return true;
}
let alpha0 = null, target = 0, smoothed = 0;
const PANO_FOV = isEquirect ? 360 : PANO_FOV_PHONE_DEG;
const pxPerDeg = W / PANO_FOV;
function onOrient(e) {
  if (e.alpha == null) { showOpenInBrowserHint(); disableGyro(); return; }   // in-app webview or no sensor
  if (alpha0 === null) alpha0 = e.alpha;
  let d = e.alpha - alpha0; d = ((d + 540) % 360) - 180;                     // shortest arc
  target = -d * pxPerDeg;                                                     // flip sign if inverted on device
}
function frame() { smoothed += (target - smoothed) * GYRO_SMOOTH; offset = clamp(smoothed, 0, W - vw); render(); requestAnimationFrame(frame); }
```
- Provide a small "以当前朝向为中心" button that resets `alpha0`.
- If permission denied / unavailable / `alpha == null`: fall back to drag and show hint "请在 Safari / Chrome 中打开以启用转动跟随".
- Enable gyro from a user gesture on the Result screen (e.g. tap "开启转动跟随"), not automatically.

### 8.4 Progressive display
- Poll `GET /jobs/{id}/manifest` every `POLL_MS`.
- For each tile whose status became `done`: load `path`, draw at `x` in the "past" layer.
- For `error` tiles: draw original crop with a subtle overlay.
- When `result.status == done`: swap the past layer to `result.jpg`, then trigger reveal.

### 8.5 Reveal
- Enter fullscreen-like mode: hide all chrome (chips, labels, buttons) with a 200 ms fade.
- Animate the slider position from 0 → 100% over `WIPE_MS` (ease-in-out). Play ambient audio (2 s clip for the decade) at wipe start; respect autoplay policy (audio unlocked by the earlier user gesture).
- After the wipe: restore chrome, leave slider at 100% (past), slider handle visible.

### 8.6 Slider
- Two layers share the same transform (offset). Top layer uses `clip-path: inset(0 0 0 Xpx)`.
- The slider is draggable **only via its explicit handle** (vertical line + round grip). Dragging anywhere else pans the panorama.

### 8.7 Replay
- "试试示例" lists `GET /replays`. Loading a replay uses the same Result screen and the same polling code; since all tiles are `done`, optionally **simulate** progressive arrival using `metrics` timestamps (delay each tile by `tile.ms` proportionally) — clearly show the "回放" badge. Zero API calls.

---

## 9. Failure handling [NORMATIVE]

| condition | behavior |
|---|---|
| Geolocation denied / no EXIF | show manual place field; if empty → `place.source=none`, constraints without location |
| VLM fails / invalid JSON | `DEFAULT_SCENE_SPEC`, `scene.fallback=true`, continue |
| Anchor fails | `anchor.status=skipped`; tiles run without reference; color match skipped; metrics still computed |
| Tile fails after retries + fallback | `status=error`; stitch uses original crop; job `done_partial` |
| Provider content refusal | retry once with `negative` removed |
| Rate limit | circuit-break to fallback; if fallback also limited → `MAX_CONCURRENCY=3`, two waves |
| Upload > `MAX_UPLOAD_MB` or non-image | 413 / 415 with a plain message |
| `alpha == null` on device | disable gyro, drag fallback, show "open in Safari/Chrome" hint |
| Network down at demo | use replay jobs; nothing else required |

---

## 10. Caching & replay [NORMATIVE]

- Cache key: `sha256(image_bytes + decade + provider + prompt_global)`. On hit, copy prior job outputs into the new job dir, set `mode=replay`, keep original `metrics`.
- `scripts/make_replay.py <image> <decade>`: runs a job end-to-end, then runs baseline, then marks `mode=replay`.
- Prepare 3–4 replay jobs before the demo (campus, downtown, one true 360, one example with strong modern elements).

---

## 11. Security & privacy [NORMATIVE]

- API keys only in server env. Never in HTML/JS, logs, or manifest.
- Store uploads under `in/`; do not log image content or device identifiers.
- Strip nothing from the user's original on disk, but serve only generated outputs and the band-resized preview.
- Validate MIME and dimensions server-side.

---

## 12. Directory layout [GUIDANCE]

```
app/
  main.py          FastAPI routes
  pipeline.py      run_job orchestration (Section 6)
  geometry.py      preprocess, plan_tiles, viewport_priority
  scene.py         VLM call → SceneSpec (+ DEFAULT_SCENE_SPEC)
  constraints.py   LLM call → ConstraintSpec (frozen prompt_global)
  editors/base.py  ImageEditor protocol, retry, circuit breaker, get_editor
  editors/gemini.py
  editors/fal.py
  consistency.py   anchor squeeze/crops, color_match
  stitch.py        cosine feather, wrap crop
  metrics.py       timestamps, seam_err, speedup
  manifest.py      atomic read/write with lock
web/
  index.html  app.js  style.css  audio/{1900s,1920s,1950s,1970s}.mp3
in/  out/{job_id}/
scripts/make_replay.py  scripts/baseline.py
```

---

## 13. Acceptance checklist [NORMATIVE]

Each item must be demonstrably true before moving to the next gate.

- [ ] `plan_tiles()` on W_ext ∈ {2048, 3072, 4096, 6300} returns n ∈ [3,8], uniform step, last tile flush with the right edge.
- [ ] A fake pipeline (each tile tinted sepia, no API) produces a stitched image with **no visible hard seams**.
- [ ] Frontend shows tiles appearing one by one from a hand-written manifest; slider and pan work on a real iPhone in Safari over HTTPS.
- [ ] One real panorama runs end-to-end; manifest has all four timestamps; `t{i}_raw.jpg` and `t{i}.jpg` both exist.
- [ ] `seam_err.raw > seam_err.after_color_match` on at least one real job (document the numbers).
- [ ] `POST /baseline` populates `serial_baseline_s` and `speedup > 1`.
- [ ] Gyro pans the panorama on iPhone after tapping the enable button; fallback hint appears when opened inside an in-app browser.
- [ ] Reveal wipe + audio play once on completion; chrome hides and restores.
- [ ] A replay loads with the network disabled.
- [ ] Notice text "想象重建，非历史影像" visible on Result screen.
- [ ] No API key string present anywhere under `web/`.

---

## 14. Build order & gates [NORMATIVE]

| stage | deliverable | gate (verify before continuing) |
|---|---|---|
| H0 | contracts (this file), env config, `plan_tiles`, `manifest.py`; probes: one Gemini call returns an image, one fal call returns an image, 2–3 test panoramas on disk | probes pass |
| H1 | `geometry.py` + `stitch.py` with fake tinting; frontend with static images: viewport, pan, slider, polling | checklist items 1–3 |
| H2 | real editors, anchor, parallel tiles, color match, metrics; one real job end-to-end | checklist items 4–6 |
| H3 | viewport priority, circuit breaker, replay script, baseline; gyro, reveal, audio | checklist items 7–9 |
| H4 | 3–4 replay jobs, README with real numbers, QR to HTTPS tunnel | all items |

If a gate fails, cut in this order: viewport priority → 360 support (phone panos only) → fixed n=4 → color match (keep feathering). **Never cut:** on-disk caching, replay mode, the four timestamps, the preview/Retake screen.

---

## 15. Demo notes (for README) [GUIDANCE]

- Demo is **replay-first**. Load a finished job; the page is live (pan, slider, gyro all work); numbers shown are the real recorded metrics. State once: "this is a run from earlier today; the timings are from that run."
- Offer a live run **after** the scripted demo, as optional upside.
- Keep one `?raw=1` tile set to show the "six different skies" failure that the anchor + color match fixes.
- Talking point for technical judges: proper solutions synchronize overlapping windows during denoising (MultiDiffusion / SyncDiffusion); that needs latent access, which hosted APIs don't expose; the global anchor + deterministic color match is the black-box approximation of the same idea.
