const assert = require('node:assert/strict');
const test = require('node:test');

const capture = require('../web/capture.js');

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
  assert.equal(calls.length, 2);
  const [, sx, , sw] = calls[1];
  assert.equal(sw, 60, 'strip width matches the angle travelled');
  assert.equal(sx, 500 - 60, 'taken from just left of the lens centre');
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
  assert.equal(calls.length, 2);
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


test('coverage never recedes, but the cursor does', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  for (let alpha = 1; alpha <= 120; alpha += 1) session.accept({ alpha });
  const swept = session.progress().degrees;
  assert.ok(swept > 140, `expected a wide sweep, got ${swept}`);
  assert.equal(Math.round(session.progress().cursor * 100), 100, 'pointing at the leading edge');

  for (let alpha = 119; alpha >= 0; alpha -= 1) session.accept({ alpha });
  const after = session.progress();
  assert.equal(after.degrees, swept, 'turning back must not un-capture anything');
  assert.ok(after.cursor < 0.3, `the cursor should retreat, got ${after.cursor}`);
});

test('the opening frame covers a field of view, and the cursor is what moves first', () => {
  const { video } = stubDocument(1240, 620);
  const session = capture.start({ video, heading: (r) => r.alpha, fovDegrees: 62 });
  session.accept({ alpha: 0 });
  const start = session.progress();
  assert.equal(Math.round(start.degrees), 62, 'one frame is one field of view');
  assert.equal(Math.round(start.cursor * 100), 50, 'and the lens points at its middle');

  // Within the opening frame, coverage cannot grow -- the pixels are already
  // there. A single readout looks frozen here, which is what the cursor fixes.
  session.accept({ alpha: 20 });
  const inside = session.progress();
  assert.equal(Math.round(inside.degrees), 62, 'still inside the first frame');
  assert.ok(inside.cursor > start.cursor, 'but the cursor has moved');
  assert.equal(inside.edge, null, 'and it is not at an edge yet');
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
