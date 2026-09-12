const assert = require('node:assert/strict');
const test = require('node:test');

const { readFileSync } = require('node:fs');
const vm = require('node:vm');
// The shared package uses ES modules for the world viewer. Exercise the actual
// browser UMD entry point while retaining this test's canvas and sensor globals.
const capture = vm.runInThisContext(`(function(module) { ${readFileSync(require.resolve('../web/capture.js'), 'utf8')}\nreturn globalThis.CenturyCapture; })(undefined)`);
delete global.CenturyCapture;

// A canvas stub that records every drawImage so the strip geometry can be
// checked without a browser. It is deliberately dumb: the test asserts where
// pixels were asked to go, which is the part that can be wrong.
function stubDocument(width, height) {
  const calls = [];
  const canvases = [];
  global.document = {
    createElement() {
      const canvas = {
        width: 0, height: 0,
        getContext: () => ({
          drawImage(...args) { calls.push(args); },
        }),
        toBlob(done) { done({ size: 1024, type: 'image/jpeg' }); },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  global.window = { DeviceOrientationEvent: function () {}, isSecureContext: true };
  // Node ships a read-only navigator, so it has to be shadowed deliberately.
  Object.defineProperty(global, 'navigator', {
    value: { mediaDevices: { getUserMedia() {} } }, configurable: true, writable: true,
  });
  return { calls, canvases, video: { videoWidth: width, videoHeight: height } };
}

test.afterEach(() => { delete global.document; delete global.window; delete global.navigator; });

test('the first frame anchors the panorama at the origin', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  assert.equal(calls.length, 1);
  const [, sx, sy, sw, sh, , , dw, dh] = calls[0];
  assert.deepEqual([sx, sy, sw, sh], [0, 0, 1000, 500], 'the whole first frame is laid down');
  assert.deepEqual([dw, dh], [1000, 500]);
  assert.equal(Math.round(session.sweptDegrees()), 50, 'one frame covers one field of view');
});

test('turning right takes the columns behind the lens centre', () => {
  const { calls, video } = stubDocument(1000, 500);
  // 50 degrees over 1000px is 20px per degree.
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  session.accept({ alpha: 3 });                    // 3 degrees right -> a 60px strip
  assert.equal(calls.length, 3, 'a strip, then the half-frame ahead of it');
  const [, sx, , sw, , dx] = calls[1];
  assert.equal(sw, 60, 'strip width matches the angle travelled');
  assert.equal(sx, 500 - 60, 'taken from just left of the lens centre');
  const [, hx, , hw, , hdx] = calls[2];
  assert.deepEqual([hx, hw], [500, 500], 'the leading half is the right half of the same frame');
  assert.equal(hdx, dx + sw, 'and it starts exactly where the strip ends: one picture at the join');
});

test('turning left takes the columns ahead of the lens centre', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  session.accept({ alpha: 357 });                  // 3 degrees left, across the 360 wrap
  const [, sx, , sw] = calls[1];
  assert.equal(sw, 60);
  assert.equal(sx, 500, 'taken from just right of the lens centre');
});

test('a sweep wider than the lens is resynced rather than smeared', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  session.accept({ alpha: 40 });                   // 800px in one step, past the half frame
  assert.equal(calls.length, 1, 'no strip is drawn across a gap it cannot cover');
  session.accept({ alpha: 42 });                   // and capture resumes from there
  assert.equal(calls.length, 3, 'a strip and its leading half');
  assert.equal(calls[1][3], 40);
});

test('sub-pixel jitter does not repaint', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  for (const alpha of [0.01, 0.02, 0.03, 0.04]) session.accept({ alpha });
  assert.equal(calls.length, 1, 'a fraction of a pixel is not worth a draw');
});

test('progress reports the swept angle and whether it is useful yet', () => {
  const { video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  assert.equal(session.progress().useful, false, '50 degrees is not yet a panorama');
  for (let alpha = 1; alpha <= 40; alpha += 1) session.accept({ alpha });
  const progress = session.stop();
  assert.ok(progress.degrees > capture.USEFUL_SWEEP_DEGREES, progress.degrees.toString());
  assert.ok(progress.useful);
  assert.ok(progress.fraction > 0 && progress.fraction <= 1);
});

test('unreadable orientation readings are ignored, not treated as zero', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: () => null, fovDegrees: 50 });
  session.accept({ alpha: null });
  assert.equal(calls.length, 0, 'nothing is painted without a heading');
  assert.equal(session.sweptDegrees(), 0);
});

test('stopping freezes the sweep and the export is cropped to it', async () => {
  const { canvases, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  session.accept({ alpha: 10 });
  const swept = session.stop().degrees;
  session.accept({ alpha: 90 });
  assert.equal(session.progress().degrees, swept, 'readings after stop are ignored');
  const blob = await session.toBlob();
  assert.equal(blob.type, 'image/jpeg');
  const output = canvases[canvases.length - 1];
  assert.equal(output.height, 500);
  assert.ok(output.width < 2 * Math.round(capture.MAX_SWEEP_DEGREES * 20), 'cropped, not the full canvas');
  assert.equal(output.width, Math.round(swept * 20), 'exported width matches the angle swept');
});

test('a capture needs getUserMedia, orientation and a secure context', () => {
  stubDocument(100, 100);
  assert.equal(capture.supported(), true);
  global.window.isSecureContext = false;
  assert.equal(capture.supported(), false, 'the camera needs HTTPS');
  global.window.isSecureContext = true;
  delete global.window.DeviceOrientationEvent;
  assert.equal(capture.supported(), false, 'without orientation there is no heading to place strips by');
});


test('coverage never recedes, but the lens does', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  for (let alpha = 1; alpha <= 120; alpha += 1) session.accept({ alpha });
  const leading = session.progress();
  assert.ok(Math.abs(leading.degrees - 182) < 1, `120 degrees of turning plus one field of view, got ${leading.degrees}`);
  assert.ok(Math.abs(leading.lens.end - leading.region.end) < 1e-9, 'the lens ends where the coverage ends');

  for (let alpha = 119; alpha >= 0; alpha -= 1) session.accept({ alpha });
  const after = session.progress();
  assert.equal(after.degrees, leading.degrees, 'turning back must not un-capture anything');
  assert.deepEqual(after.region, leading.region, 'nor move the coverage');
  assert.ok(after.lens.end < leading.lens.end, 'while the lens slides back inside it');
  assert.ok(after.lens.start >= after.region.start && after.lens.end <= after.region.end,
    'and never leaves it');
});

test('the opening field of view sits in the middle of the track and stays there', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  const start = session.progress();
  assert.equal(Math.round(start.degrees), 62, 'one frame is one field of view');
  assert.ok(Math.abs((start.region.start + start.region.end) / 2 - 0.5) < 1e-9, 'centred on the track');
  assert.deepEqual(start.lens, start.region, 'and the lens is all of it');
  assert.equal(start.edge, 'both', 'so a turn either way widens the shot');

  // Turning right grows the coverage from the first degree: the strip lands
  // inside the opening frame, but the half-frame ahead of it reaches past.
  session.accept({ alpha: 20 });
  const inside = session.progress();
  assert.ok(Math.abs(inside.degrees - 82) < 1, `62 plus 20, got ${inside.degrees}`);
  assert.ok(Math.abs(inside.region.start - start.region.start) < 1e-9, 'the left edge has not moved');
  assert.ok(inside.region.end > start.region.end, 'the right edge has');
  assert.ok(Math.abs(inside.lens.end - inside.region.end) < 1e-9, 'with the lens pinned to it');
  assert.equal(inside.edge, 'right');
});

test('an edge is reported only when a turn would actually add coverage', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  for (let alpha = 1; alpha <= 60; alpha += 1) session.accept({ alpha });
  assert.equal(session.progress().edge, 'right', 'at the leading edge after turning right');
  for (let alpha = 59; alpha >= -60; alpha -= 1) session.accept({ alpha: (alpha + 360) % 360 });
  assert.equal(session.progress().edge, 'left', 'and at the other edge after turning back past the start');
  for (let alpha = -59; alpha <= -30; alpha += 1) session.accept({ alpha: (alpha + 360) % 360 });
  assert.equal(session.progress().edge, null, 'in the middle, a turn adds nothing');
});


test('a frame is never pasted twice, however fast the sensor fires', () => {
  // This is the smear in the screenshot: deviceorientation fires up to 60 Hz
  // while the camera delivers ~30 fps, so drawing on the sensor's clock copied
  // one frame's centre column across every heading the phone passed through.
  const { calls, video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  // Let the frame clock prove it advances; an unproven clock is never trusted to
  // veto a paint, because a live stream can report one timestamp forever.
  session.record({ alpha: 2 });
  session.draw(0.30);
  session.record({ alpha: 4 });
  session.draw(0.33);
  const anchor = calls.length;

  // Ten sensor readings arrive while the camera is still showing one frame.
  for (let alpha = 5; alpha <= 14; alpha += 1) {
    session.record({ alpha });
    session.draw(0.33);                       // same frame timestamp throughout
  }
  assert.equal(calls.length, anchor, 'one frame contributes at most one strip');

  // A new frame arrives, and the angle travelled since is worth a strip (plus
  // the half-frame ahead of it, from that same new frame).
  assert.equal(session.draw(0.36), true);
  assert.equal(calls.length, anchor + 2);
  for (const call of calls.slice(anchor)) {
    assert.ok(call[3] >= capture.MIN_STRIP_PX, `a strip must carry content, got ${call[3]}px`);
  }
});

test('slivers are accumulated rather than stretched', () => {
  const { calls, video } = stubDocument(1240, 620);
  // 62 degrees over 1240px is 20px per degree, so 0.1 degrees is a 2px sliver.
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  const anchor = calls.length;
  let frame = 0;
  for (let step = 1; step <= 3; step += 1) {
    session.record({ alpha: step * 0.1 });
    session.draw(frame += 1);
  }
  assert.equal(calls.length, anchor + 2, 'three slivers become one honest strip, plus its leading half');
  assert.ok(Math.abs(calls[anchor][3] - 6) < 1e-6,
    `and it is as wide as the angle actually travelled, got ${calls[anchor][3]}`);
});

test('recording never touches the canvas', () => {
  const { calls, video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  const anchor = calls.length;
  const before = session.progress();
  for (let alpha = 1; alpha <= 90; alpha += 1) session.record({ alpha });
  const after = session.progress();
  assert.equal(calls.length, anchor, 'the sensor alone paints nothing');
  assert.equal(after.degrees, before.degrees, 'and coverage only grows when a strip is painted');
  assert.deepEqual(after.region, before.region);
  assert.ok(after.lens.end <= after.region.end, 'the lens is clipped to the coverage meanwhile');
  assert.equal(after.edge, 'right', 'and the readout still says which way extends the shot');
});


test('a frame clock that never advances cannot freeze the capture', () => {
  // A live MediaStream commonly reports currentTime 0 forever. Trusting that as
  // proof of a stale frame painted one strip and then nothing, so the phone
  // turned and the readout never moved.
  const { calls, video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  const anchor = calls.length;
  for (let alpha = 1; alpha <= 90; alpha += 1) {
    session.record({ alpha });
    session.draw(0);                          // the clock is stuck
  }
  assert.ok(calls.length > anchor + 50, `expected strips to keep landing, got ${calls.length - anchor}`);
  assert.ok(session.progress().degrees > 110, `and coverage to grow, got ${session.progress().degrees}`);
});

test('a clock that does advance still vetoes a repeated frame', () => {
  const { calls, video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  session.record({ alpha: 10 });
  session.draw(0.10);
  session.record({ alpha: 20 });
  session.draw(0.20);                         // the clock has now proved it moves
  const anchor = calls.length;
  for (let alpha = 21; alpha <= 40; alpha += 1) {
    session.record({ alpha });
    session.draw(0.20);                       // same frame redelivered
  }
  assert.equal(calls.length, anchor, 'a proven clock may veto a repeat');
});

test('a silent sensor is detectable even though the first frame covered ground', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.draw(0.1);
  assert.equal(session.readings(), 0, 'a silent sensor records nothing');
  assert.equal(session.progress().degrees, 0, 'and nothing is painted without a heading');
  session.record({ alpha: 5 });
  assert.equal(session.readings(), 1, 'a real reading is counted');
  session.record({ alpha: null });
  assert.equal(session.readings(), 1, 'an unreadable one is not');
});


test('no whole frame is ever pasted over strips already laid', () => {
  // The break in the screenshot: a full frame laid at the end of the sweep put
  // its inner half on top of strips from many degrees earlier, and the
  // accumulated error showed as one hard line a frame-width in from the edge.
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  for (let alpha = 2; alpha <= 60; alpha += 2) session.accept({ alpha });
  const before = calls.length;
  const stopped = session.stop();
  assert.equal(calls.length, before, 'stopping paints nothing');
  // After the anchor, every draw is either a strip from beside the lens centre
  // or a half-frame placed at the lens centre; nothing is ever laid behind it.
  let frontier = 20 * capture.MAX_SWEEP_DEGREES;         // the origin: 20px per degree, mid-canvas
  for (const [, sx, , sw, , dx] of calls.slice(1)) {
    if (sw === 500) {
      assert.equal(sx, 500, 'a half-frame is the leading half of the frame');
      assert.ok(dx >= frontier - 1e-6, 'and lands at or past the strip frontier, never behind it');
    } else {
      assert.equal(sx + sw, 500, 'a strip ends at the lens centre');
      frontier = dx + sw;
    }
  }
  assert.ok(Math.abs(stopped.degrees - 110) < 1, `60 degrees of sweep plus one frame, got ${stopped.degrees}`);
});

test('turning back never repaints the half-frame beyond the frontier', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  for (let alpha = 2; alpha <= 40; alpha += 2) session.accept({ alpha });
  const halves = () => calls.filter((call) => call[3] === 500 && call[1] === 500).length;
  const forward = halves();
  for (let alpha = 38; alpha >= 10; alpha -= 2) session.accept({ alpha });
  assert.equal(halves(), forward, 'a frame off the frontier paints only its strip');
  const lefts = calls.filter((call) => call[3] === 500 && call[1] === 0).length;
  assert.equal(lefts, 0, 'and turning back over covered ground does not paint a left half either');
  for (let alpha = 12; alpha <= 44; alpha += 2) session.accept({ alpha });
  assert.ok(halves() > forward, 'past the old frontier the leading half resumes');
});

test('the lens highlight never leaves the coverage', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  const path = [];
  for (let alpha = 1; alpha <= 90; alpha += 1) path.push(alpha);
  for (let alpha = 89; alpha >= -50; alpha -= 1) path.push((alpha + 360) % 360);
  for (const alpha of path) {
    // Sometimes the sensor runs ahead of the camera by a reading or two.
    session.record({ alpha });
    if (alpha % 3 === 0) session.draw();
    const { lens, region } = session.progress();
    assert.ok(lens.start >= region.start - 1e-9 && lens.end <= region.end + 1e-9,
      `lens ${lens.start}-${lens.end} outside region ${region.start}-${region.end} at ${alpha}`);
    assert.ok(region.start >= 0 && region.end <= 1, 'and the coverage fits the track');
  }
});

// -- Placing strips by the picture ------------------------------------------

function scene(n, seed) {
  // A column profile with structure at several scales, like a room does.
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = new Float32Array(n);
  for (let k = 0; k < 12; k += 1) {
    const at = Math.floor(rnd() * n), w = 3 + Math.floor(rnd() * 20), v = (rnd() - .5) * 120;
    for (let x = at; x < Math.min(n, at + w); x += 1) out[x] += v;
  }
  for (let x = 0; x < n; x += 1) out[x] += 128 + 30 * Math.sin(x / 40) + (rnd() - .5) * 4;
  return out;
}

function slid(profile, shift) {
  // The scene as seen after turning right by `shift` samples: content moves left.
  const out = new Float32Array(profile.length);
  for (let x = 0; x < profile.length; x += 1) out[x] = profile[Math.min(profile.length - 1, Math.max(0, x + shift))];
  return out;
}

test('the slide between two frames is recovered from the picture alone', () => {
  const previous = capture.highPass(scene(360, 3));
  for (const truth of [0, 5, -7, 23, -40]) {
    const current = capture.highPass(slid(scene(360, 3), truth));
    const match = capture.bestShift(previous, current, 120, 0);
    assert.ok(match, `no match at ${truth}`);
    assert.ok(Math.abs(match.shift - truth) < 0.6, `expected ${truth}, got ${match.shift}`);
    assert.ok(match.score > capture.MIN_MATCH);
  }
});

test('a blank wall yields no match rather than a confident zero', () => {
  const flat = capture.highPass(new Float32Array(360).fill(140));
  assert.equal(capture.bestShift(flat, flat, 120, 10), null);
  const nearlyFlat = capture.highPass(scene(360, 5).map((v) => 140 + (v - 140) * 0.001));
  assert.ok(capture.bestShift(nearlyFlat, nearlyFlat, 120, 0) === null
    || Math.abs(capture.bestShift(nearlyFlat, nearlyFlat, 120, 0).shift) < 1,
    'a near-flat frame matches itself only at zero, which the contrast guard rejects upstream');
});

test('repeating texture is resolved by the sensor, not by the biggest peak', () => {
  // A picket fence: every period looks like every other, so the picture alone
  // cannot say which period the phone turned through. The sensor can.
  const period = 24;
  const fence = new Float32Array(360);
  for (let x = 0; x < 360; x += 1) fence[x] = (x % period) < 6 ? 30 : 200;
  const previous = capture.highPass(fence);
  const current = capture.highPass(slid(fence, 2 * period + 3));   // two periods plus a bit
  const alone = capture.bestShift(previous, current, 120, 0);
  const guided = capture.bestShift(previous, current, 120, 2 * period + 6);  // the sensor, 3 samples off
  assert.ok(alone && Math.abs(alone.shift - 3) < 1, 'unguided, the nearest period wins');
  assert.ok(guided && Math.abs(guided.shift - (2 * period + 3)) < 1, `guided, the right one: ${guided.shift}`);
});

test('the sensor is only ever a tie-breaker, never a thumb on the scale', () => {
  // With one unambiguous peak, an expected value far from it must not drag the
  // answer toward itself: the disagreement is then reported to the caller by
  // the tolerance check, and the sensor takes over outright.
  const previous = capture.highPass(scene(360, 9));
  const current = capture.highPass(slid(scene(360, 9), 15));
  const match = capture.bestShift(previous, current, 120, -60);
  assert.ok(match && Math.abs(match.shift - 15) < 0.6, `got ${match && match.shift}`);
});

test('without pixel readback, strips are placed by the sensor as before', () => {
  const { calls, video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  session.accept({ alpha: 3 });
  assert.equal(calls[1][3], 60, 'sensor placement: 3 degrees at 20px per degree');
  assert.deepEqual(session.progress().placement, { registered: 0, guessed: 1 });
});

test('a portrait frame is narrow, and the default field of view says so', () => {
  assert.equal(capture.defaultFov(1000, 500), capture.DEFAULT_FOV_DEGREES, 'landscape: the long side');
  const portrait = capture.defaultFov(720, 1280);
  assert.ok(portrait > 35 && portrait < 40, `9:16 upright is about 37 degrees, got ${portrait}`);
  // This is the 441-degree readout: 62 assumed where 37 was true.
  assert.ok(Math.abs(270 * 62 / 37.3 - 449) < 5);
});

test('the canvas never exceeds what a phone browser will allocate', () => {
  const { canvases, video } = stubDocument(1080, 1920);
  capture.start({ video, heading: (r) => r.alpha });
  const [canvas] = canvases;
  assert.ok(canvas.width * canvas.height <= 16e6, `${canvas.width}x${canvas.height}`);
  assert.ok(canvas.width >= 2 * 1080, 'but always room for a frame either side of the origin');
});

test('the sweep is not clamped by the sensor past half a turn', () => {
  const { video } = stubDocument(1000, 500);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 50 });
  session.accept({ alpha: 0 });
  for (let alpha = 1; alpha <= 250; alpha += 1) session.accept({ alpha: alpha % 360 });
  assert.ok(session.progress().degrees > 250, `a 250-degree turn must be captured, got ${session.progress().degrees}`);
});
