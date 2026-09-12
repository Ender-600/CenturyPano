(function (root, factory) {
  const capture = factory();
  if (typeof module === 'object' && module.exports) module.exports = capture;
  else root.CenturyCapture = capture;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Slit-scan panorama capture.
  //
  // A browser cannot open the system camera's panorama mode, and stitching
  // arbitrary frames needs feature matching we have no time or budget for. But
  // the phone already tells us where it is pointing, and that is enough: each
  // column of the video frame corresponds to a known heading, so a column can
  // be laid onto a cylinder at the place it belongs. Sweep the phone and the
  // strips tile into a panorama with no correspondence search at all, and no
  // parallax ghosting either, because the middle of the sweep is built only from
  // the column at the centre of the lens, and each end from one whole frame.
  //
  // The one unknown is the lens: horizontal field of view is not exposed to the
  // web, so it is assumed. Strips are placed by measuring how far the picture
  // slid between frames (below), so the assumption no longer decides where
  // pixels go; it only converts the result into degrees for the readout, and
  // stands in when the picture has nothing to measure. Getting it wrong stretches
  // the reported angle by that ratio, which is why this is an estimate and not a
  // calibrated instrument.

  const DEFAULT_FOV_DEGREES = 62;   // typical phone rear camera, across the LONG side
  const MAX_CANVAS_PIXELS = 16e6;   // iOS refuses anything past 4096x4096-worth, silently
  const CALIBRATION_MIN_DEGREES = 30;
  const FOV_LIMITS = [25, 110];
  const MIN_STRIP_PX = 4;           // a one-pixel column carries no content
  const MAX_SWEEP_DEGREES = 360;
  const USEFUL_SWEEP_DEGREES = 70;  // below this the result is barely a panorama
  const ORIENTATION_TIMEOUT_MS = 2000;

  const normalize = (degrees) => ((degrees % 360) + 360) % 360;

  function shortestDelta(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
    return normalize(normalize(current) - normalize(previous) + 180) - 180;
  }

  // Where each strip goes is decided by the picture, and only checked against the
  // sensor. The sensor says where the phone points now; the frame on screen was
  // taken a few dozen milliseconds ago, and a hand does not turn at a steady
  // rate, so the two disagree by a velocity-dependent amount that changes from
  // frame to frame. Placing strips on the sensor alone laid every strip a little
  // off from its neighbour -- the staggered edges in the capture. Consecutive
  // frames overlap almost entirely, though, and how far the scene slid between
  // them is a one-dimensional question: a column profile of each frame, and the
  // lag at which the two profiles agree best. That is measured in the frame's
  // own pixels, so the strips line up by construction.
  const PROBE_WIDTH = 360;          // profile resolution: 2 video columns per sample at 720
  const PROBE_HEIGHT = 48;
  const PROBE_BAND = [0.2, 0.8];    // rows sampled: skip the floor and the ceiling
  const SMOOTH_RADIUS = 8;          // high-pass, so lighting drift is not "structure"
  const MAX_LAG_FRACTION = 1 / 3;   // a frame-to-frame slide beyond this is a resync
  const MIN_MATCH = 0.5;            // below this the match is not one; trust the sensor
  const MIN_CONTRAST = 2.0;         // rms of the high-passed profile, in luma; below this
                                    // the frame is a blank wall and any match is sensor
                                    // noise agreeing with itself at lag zero
  const RUNNER_UP = 0.85;           // peaks this close to the best are ambiguous
  const MAX_DISAGREEMENT_DEGREES = 6;

  function highPass(profile) {
    const n = profile.length;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + profile[i];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const lo = Math.max(0, i - SMOOTH_RADIUS), hi = Math.min(n, i + SMOOTH_RADIUS + 1);
      out[i] = profile[i] - (prefix[hi] - prefix[lo]) / (hi - lo);
    }
    return out;
  }

  function contrast(profile) {
    let sum = 0;
    for (let i = 0; i < profile.length; i += 1) sum += profile[i] * profile[i];
    return Math.sqrt(sum / Math.max(1, profile.length));
  }

  // The lag by which `current` is `previous` slid to the left, in samples: a
  // right turn moves the scene left in the frame, so current[x] ~ previous[x + s]
  // with s > 0. Among peaks that are nearly as good as the best, the one nearest
  // the sensor's own estimate wins; repeating texture -- a railing, a tiled
  // floor -- matches itself one period over, and the sensor is exactly good
  // enough to say which period is the real one. Returns null when the picture
  // has too little structure to say anything.
  function bestShift(previous, current, maxLag, expected) {
    const n = previous.length;
    let best = -Infinity;
    const scores = new Float32Array(2 * maxLag + 1).fill(-Infinity);
    for (let s = -maxLag; s <= maxLag; s += 1) {
      let dot = 0, a = 0, b = 0, count = 0;
      const start = Math.max(0, -s), end = Math.min(n, n - s);
      for (let x = start; x < end; x += 1) {
        const p = previous[x + s], c = current[x];
        dot += p * c; a += p * p; b += c * c; count += 1;
      }
      if (count < n / 2 || a <= 0 || b <= 0) continue;
      const score = dot / Math.sqrt(a * b);
      scores[s + maxLag] = score;
      if (score > best) best = score;
    }
    if (!(best >= MIN_MATCH)) return null;
    let chosen = null;
    for (let s = -maxLag; s <= maxLag; s += 1) {
      const score = scores[s + maxLag];
      if (score < best * RUNNER_UP) continue;
      // A local maximum only: the shoulders of a peak are not candidates.
      const left = scores[s + maxLag - 1], right = scores[s + maxLag + 1];
      if ((left !== undefined && left > score) || (right !== undefined && right > score)) continue;
      if (chosen === null || Math.abs(s - expected) < Math.abs(chosen - expected)) chosen = s;
    }
    if (chosen === null) return null;
    // Sub-sample refinement from the peak's two neighbours.
    const i = chosen + maxLag;
    const l = scores[i - 1], m = scores[i], r = scores[i + 1];
    let refined = chosen;
    if (Number.isFinite(l) && Number.isFinite(r)) {
      const denominator = l - 2 * m + r;
      if (denominator < 0) refined = chosen + (l - r) / (2 * denominator);
    }
    return { shift: refined, score: best };
  }

  // The default field of view is for the sensor's long side. Held upright, the
  // long side is vertical, and what the lens sees across the width of a portrait
  // frame is much narrower -- about 37 degrees for a 9:16 frame. Assuming 62
  // there reported a 270-degree sweep as 441.
  function defaultFov(width, height) {
    if (width >= height) return DEFAULT_FOV_DEGREES;
    const halfLong = Math.tan(DEFAULT_FOV_DEGREES * Math.PI / 360);
    return 2 * Math.atan(halfLong * width / height) * 180 / Math.PI;
  }

  function supported() {
    return !!(typeof navigator !== 'undefined' && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && typeof window !== 'undefined' && window.DeviceOrientationEvent && window.isSecureContext);
  }

  // iOS only grants motion access from inside a user gesture, so this must be
  // called straight off the tap that starts a capture.
  async function requestOrientationAccess() {
    const Orientation = window.DeviceOrientationEvent;
    if (!Orientation) return false;
    if (typeof Orientation.requestPermission !== 'function') return true;
    try {
      return (await Orientation.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  function start(options) {
    const { video, heading, onProgress, maxSweepDegrees = MAX_SWEEP_DEGREES } = options;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The camera has not produced a frame yet');

    // The scale starts as an assumption and is then measured. Strips are placed
    // in pixels, so this only turns pixels into degrees for the readout and back
    // again for the sensor fallback; but the readout is what the user sees, and
    // the sensor knows the truth over a long sweep even if it wobbles over a
    // short one. Once enough sweep has been placed by the picture, the ratio of
    // pixels slid to degrees turned IS the scale, for this lens, today.
    const fovDegrees = options.fovDegrees ?? defaultFov(width, height);
    let pixelsPerDegree = width / fovDegrees;
    let calibratedPx = 0, calibratedDegrees = 0;
    const span = Math.round(maxSweepDegrees * pixelsPerDegree);
    const canvas = document.createElement('canvas');
    // Room to sweep either way from the origin, within what the browser will
    // actually allocate; past that the lens centre is clamped, not the canvas.
    canvas.width = Math.max(2 * width, Math.min(span * 2, Math.floor(MAX_CANVAS_PIXELS / height)));
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const origin = canvas.width / 2;

    let sweep = 0;                   // signed degrees travelled from the origin
    let previousHeading = null;
    let lastX = origin;
    let filledMin = origin;
    let filledMax = origin;
    let stripMin = origin;           // how far the centre strips have reached
    let stripMax = origin;
    let painted = false;
    let running = true;
    let recorded = 0;
    let lastFrameTime;
    let frameClockMoves = false;
    let centreX = origin;            // where the lens centre sits on the canvas
    let sweepAtPaint = 0;            // the sensor's reading when the last frame was placed
    let previousProfile = null;
    let registered = 0, guessed = 0; // frames placed by the picture / by the sensor alone

    // The probe is a thumbnail of the frame's middle band, read back as numbers.
    // Reading pixels back is the one thing the test stub cannot do; without it,
    // placement falls back to the sensor, which is how it worked before.
    let probe = null;
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = PROBE_WIDTH;
    probeCanvas.height = PROBE_HEIGHT;
    const probeContext = probeCanvas.getContext('2d', { willReadFrequently: true });
    if (probeContext && typeof probeContext.getImageData === 'function') probe = probeContext;

    function currentProfile() {
      if (!probe) return null;
      const top = Math.round(height * PROBE_BAND[0]);
      const rows = Math.round(height * (PROBE_BAND[1] - PROBE_BAND[0]));
      probe.drawImage(video, 0, top, width, rows, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
      let data;
      try { data = probe.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data; } catch { return null; }
      const sums = new Float32Array(PROBE_WIDTH);
      for (let i = 0, x = 0; i < data.length; i += 4, x = (x + 1) % PROBE_WIDTH) {
        sums[x] += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / PROBE_HEIGHT;
      }
      const profile = highPass(sums);
      return contrast(profile) >= MIN_CONTRAST ? profile : null;
    }

    // Decide how far the lens centre moved since the last placed frame: by the
    // picture when it can be measured and agrees with the sensor within reason,
    // by the sensor otherwise.
    function advance() {
      const sensorPx = (sweep - sweepAtPaint) * pixelsPerDegree;
      sweepAtPaint = sweep;
      const profile = currentProfile();
      let moved = sensorPx;
      if (profile && previousProfile) {
        const scale = width / PROBE_WIDTH;
        const match = bestShift(previousProfile, profile, Math.round(PROBE_WIDTH * MAX_LAG_FRACTION),
          sensorPx / scale);
        const tolerance = MAX_DISAGREEMENT_DEGREES * pixelsPerDegree;
        if (match && Math.abs(match.shift * scale - sensorPx) <= tolerance) {
          moved = match.shift * scale;
          registered += 1;
          // Signed sums, so sensor jitter cancels instead of piling up as |noise|.
          calibratedPx += moved;
          calibratedDegrees += sensorPx / pixelsPerDegree;
          if (Math.abs(calibratedDegrees) >= CALIBRATION_MIN_DEGREES) {
            const measured = width / (calibratedPx / calibratedDegrees);
            pixelsPerDegree = width / Math.max(FOV_LIMITS[0], Math.min(FOV_LIMITS[1], measured));
          }
        } else {
          guessed += 1;
        }
      } else {
        guessed += 1;                    // a blank frame, or the first after one
      }
      previousProfile = profile;         // a blank frame breaks the chain on purpose
      centreX = Math.max(width / 2, Math.min(canvas.width - width / 2, centreX + moved));
    }

    // The strips are the record; the half-frame ahead of them is provisional.
    //
    // Strips only ever cover the ground the lens centre has crossed, so the last
    // half field of view at each end of a sweep has to come from a whole frame.
    // Pasting that frame at the end was the break in the screenshot: its inner
    // half landed on top of strips laid many degrees earlier, and every degree
    // of sensor and lens error accumulated over the sweep showed up as one hard
    // vertical line exactly one frame-width in from the edge.
    //
    // So the leading half is painted from every frame that extends the sweep,
    // as it goes, beyond the strip just laid from the same frame. The join sits
    // at that frame's own lens centre, where the two halves are one picture. The
    // next extending frame overwrites the provisional half and appends its own
    // strip, so at any moment the canvas is strips up to the frontier and one
    // clean half-frame past it -- and strips, once laid, are never painted over
    // by anything but a later strip at the same place.
    function paint() {
      // The first frame anchors the panorama: lay down a full frame so the
      // centre is covered before any rotation has happened.
      if (!painted) {
        context.drawImage(video, 0, 0, width, height, origin - width / 2, 0, width, height);
        filledMin = origin - width / 2;
        filledMax = origin + width / 2;
        painted = true;
        sweepAtPaint = sweep;
        previousProfile = currentProfile();
        return;
      }
      advance();
      const targetX = centreX;
      let step = targetX - lastX;
      // Wait rather than paste a sliver: lastX is deliberately not advanced, so
      // the angle accumulates until it is worth a strip with real content in it.
      if (Math.abs(step) < MIN_STRIP_PX) return;
      // A turn faster than the lens can cover leaves a gap no strip can fill;
      // resync rather than smear one column across it.
      const reach = width / 2;
      if (Math.abs(step) > reach) {
        lastX = targetX;
        return;
      }
      const slice = Math.abs(step);
      // Each video column x sits at canvas targetX + (x - width / 2), so the
      // columns that fill the gap just travelled are the ones adjacent to the
      // lens centre, on the side the phone is turning away from.
      const sourceX = step > 0 ? width / 2 - slice : width / 2;
      const destinationX = step > 0 ? lastX : targetX;
      context.drawImage(video, sourceX, 0, slice, height, destinationX, 0, slice, height);
      filledMin = Math.min(filledMin, destinationX);
      filledMax = Math.max(filledMax, destinationX + slice);
      lastX = targetX;
      // Only a frame at the frontier gets to paint ahead of itself. Turning back
      // over covered ground must not put a stale half-frame over good strips.
      if (step > 0 && targetX >= stripMax) {
        stripMax = targetX;
        context.drawImage(video, width / 2, 0, width / 2, height, targetX, 0, width / 2, height);
        filledMax = Math.max(filledMax, targetX + width / 2);
      } else if (step < 0 && targetX <= stripMin) {
        stripMin = targetX;
        context.drawImage(video, 0, 0, width / 2, height, targetX - width / 2, 0, width / 2, height);
        filledMin = Math.min(filledMin, targetX - width / 2);
      }
    }

    // Where the phone points, from the sensor. Recording is cheap and can run at
    // whatever rate the sensor fires; it never touches the canvas.
    function record(reading) {
      if (!running) return false;
      const next = heading(reading);
      if (!Number.isFinite(next)) return false;
      if (previousHeading !== null) sweep += shortestDelta(next, previousHeading);
      previousHeading = next;
      recorded += 1;
      return true;
    }

    // When a strip may be taken, from the camera. A strip must come from a frame
    // that has not been used before: drawing on the sensor's clock instead pastes
    // one frame's centre column across every position the phone passed through
    // while that frame was on screen, which is what produced vertical smear.
    function draw(frameTime) {
      if (!running || previousHeading === null) return false;
      // The callback is itself the frame clock, so the timestamp is only a bonus
      // check against a camera that redelivers a frame. A live MediaStream often
      // reports currentTime 0 forever, and trusting a clock that never advances
      // froze capture after a single strip -- the phone turned and nothing moved.
      // So the timestamp may only veto a paint once it has proved it advances.
      if (frameTime !== undefined) {
        if (lastFrameTime !== undefined && frameTime !== lastFrameTime) frameClockMoves = true;
        if (frameClockMoves && frameTime === lastFrameTime) return false;
        lastFrameTime = frameTime;
      }
      paint();
      if (onProgress) onProgress(progress());
      return true;
    }

    function accept(reading) {
      if (!record(reading)) return;
      paint();
      if (onProgress) onProgress(progress());
    }

    function readings() {
      return recorded;
    }

    function sweptDegrees() {
      return painted ? (filledMax - filledMin) / pixelsPerDegree : 0;
    }

    // Two things on one bar: the ground captured so far, and where the lens is
    // looking within it. Both are placed on a fixed track with the starting
    // heading at its middle, so the opening field of view sits in the centre and
    // stays there while coverage grows outward from it. Coverage only ever grows:
    // turning back does not un-capture pixels. The lens span is the current
    // frame, and it never leaves the coverage -- at an edge the two move
    // together, which is the only time a turn adds anything; in the middle the
    // lens slides back over ground already captured.
    function progress() {
      const swept = sweptDegrees();
      // The bar is laid out in canvas pixels, not degrees, so it does not shift
      // under the user as the scale is calibrated; only the number does.
      const half = width / 2;
      const left = painted ? filledMin : origin - half;
      const right = painted ? filledMax : origin + half;
      // The lens is where the last placed frame put it, plus whatever the sensor
      // has seen since -- between frames, a fraction of a degree -- and it is
      // clipped so it cannot poke out of the coverage meanwhile.
      const lens = centreX + (sweep - sweepAtPaint) * pixelsPerDegree;
      const clip = (value) => Math.max(left, Math.min(right, value));
      const lensLeft = clip(lens - half);
      const lensRight = clip(lens + half);
      const margin = 2 * pixelsPerDegree;
      const atRight = painted && lens + half >= right - margin;
      const atLeft = painted && lens - half <= left + margin;
      const edge = !painted ? null : atRight && atLeft ? 'both' : atRight ? 'right' : atLeft ? 'left' : null;
      const track = canvas.width;
      return {
        degrees: swept,
        fovDegrees: width / pixelsPerDegree,
        edge,
        fraction: Math.max(0, Math.min(1, swept / maxSweepDegrees)),
        useful: swept >= USEFUL_SWEEP_DEGREES,
        region: { start: left / track, end: right / track },
        lens: { start: lensLeft / track, end: lensRight / track },
        placement: { registered, guessed },
      };
    }

    function stop() {
      running = false;
      return progress();
    }

    // Crop to what was actually swept; the spare canvas either side is unpainted.
    function toCanvas() {
      const left = Math.max(0, Math.floor(filledMin));
      const right = Math.min(canvas.width, Math.ceil(filledMax));
      const output = document.createElement('canvas');
      output.width = Math.max(1, right - left);
      output.height = height;
      output.getContext('2d', { alpha: false })
        .drawImage(canvas, left, 0, output.width, height, 0, 0, output.width, height);
      return output;
    }

    function toBlob(type = 'image/jpeg', quality = 0.92) {
      return new Promise((resolve, reject) => {
        const output = toCanvas();
        if (!output.toBlob) { reject(new Error('This browser cannot export a canvas')); return; }
        output.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The panorama could not be encoded'))),
          type, quality);
      });
    }

    return { accept, record, draw, stop, progress, sweptDegrees, readings, toCanvas, toBlob,
             get width() { return Math.max(1, Math.ceil(filledMax) - Math.floor(filledMin)); },
             get height() { return height; } };
  }

  return { supported, requestOrientationAccess, start, shortestDelta, bestShift, highPass, defaultFov,
           DEFAULT_FOV_DEGREES, USEFUL_SWEEP_DEGREES, MAX_SWEEP_DEGREES, ORIENTATION_TIMEOUT_MS,
           MIN_STRIP_PX, MIN_MATCH, MIN_CONTRAST };
});
