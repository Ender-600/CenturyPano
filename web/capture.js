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
  // parallax ghosting either, because only the column at the centre of the lens
  // is ever used.
  //
  // The one unknown is the lens: horizontal field of view is not exposed to the
  // web, so it is assumed. Getting it wrong stretches or squeezes the result
  // horizontally by that ratio, which the pipeline tolerates — it plans tiles
  // from the image's own width — but it is why this is an estimate and not a
  // calibrated instrument.

  const DEFAULT_FOV_DEGREES = 62;   // typical phone rear camera, horizontal
  const MAX_SWEEP_DEGREES = 360;
  const USEFUL_SWEEP_DEGREES = 70;  // below this the result is barely a panorama
  const ORIENTATION_TIMEOUT_MS = 2000;

  const normalize = (degrees) => ((degrees % 360) + 360) % 360;

  function shortestDelta(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
    return normalize(normalize(current) - normalize(previous) + 180) - 180;
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
    const {
      video, heading, onProgress, fovDegrees = DEFAULT_FOV_DEGREES,
      maxSweepDegrees = MAX_SWEEP_DEGREES,
    } = options;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The camera has not produced a frame yet');

    const pixelsPerDegree = width / fovDegrees;
    const span = Math.round(maxSweepDegrees * pixelsPerDegree);
    const canvas = document.createElement('canvas');
    canvas.width = span * 2;         // room to sweep either way from the origin
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    const origin = span;

    let sweep = 0;                   // signed degrees travelled from the origin
    let previousHeading = null;
    let lastX = origin;
    let filledMin = origin;
    let filledMax = origin;
    let painted = false;
    let running = true;

    function paint() {
      // The first frame anchors the panorama: lay down a full frame so the
      // centre is covered before any rotation has happened.
      if (!painted) {
        context.drawImage(video, 0, 0, width, height, origin - width / 2, 0, width, height);
        filledMin = origin - width / 2;
        filledMax = origin + width / 2;
        painted = true;
        return;
      }
      const targetX = origin + sweep * pixelsPerDegree;
      let step = targetX - lastX;
      if (Math.abs(step) < 1) return;
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
    }

    function accept(reading) {
      if (!running) return;
      const next = heading(reading);
      if (!Number.isFinite(next)) return;
      if (previousHeading !== null) sweep += shortestDelta(next, previousHeading);
      previousHeading = next;
      const limit = maxSweepDegrees / 2;
      sweep = Math.max(-limit, Math.min(limit, sweep));
      paint();
      if (onProgress) onProgress(progress());
    }

    function sweptDegrees() {
      return painted ? (filledMax - filledMin) / pixelsPerDegree : 0;
    }

    function progress() {
      const swept = sweptDegrees();
      return {
        degrees: swept,
        fraction: Math.max(0, Math.min(1, swept / maxSweepDegrees)),
        useful: swept >= USEFUL_SWEEP_DEGREES,
      };
    }

    // Centre strips cover the ground between the first frame and the last, but
    // only out to where the lens centre reached. Laying down a full frame at each
    // end means the panorama spans the swept angle plus one field of view, and
    // the extremes come from a single frame rather than being left blank.
    function finish() {
      if (!painted || !running) return;
      const targetX = origin + sweep * pixelsPerDegree;
      context.drawImage(video, 0, 0, width, height, targetX - width / 2, 0, width, height);
      filledMin = Math.min(filledMin, targetX - width / 2);
      filledMax = Math.max(filledMax, targetX + width / 2);
    }

    function stop() {
      finish();
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

    return { accept, stop, progress, sweptDegrees, toCanvas, toBlob,
             get width() { return Math.max(1, Math.ceil(filledMax) - Math.floor(filledMin)); },
             get height() { return height; } };
  }

  return { supported, requestOrientationAccess, start, shortestDelta,
           DEFAULT_FOV_DEGREES, USEFUL_SWEEP_DEGREES, MAX_SWEEP_DEGREES, ORIENTATION_TIMEOUT_MS };
});
