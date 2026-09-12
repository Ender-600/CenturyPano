(function (root, factory) {
  const motion = factory();
  if (typeof module === 'object' && module.exports) module.exports = motion;
  else root.CenturyMotion = motion;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const radians = Math.PI / 180;
  const normalize = (degrees) => ((degrees % 360) + 360) % 360;

  // Heading increases when looking right. Relative sensor readings need only
  // a stable starting direction, not a compass or magnetometer permission.
  function headingFromOrientation(orientation) {
    if (!orientation || !Number.isFinite(orientation.alpha)) return null;
    const { alpha, beta, gamma } = orientation;
    if (beta == null && gamma == null) return normalize(-alpha);
    if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return null;

    const a = normalize(alpha) * radians;
    const b = normalize(beta) * radians;
    const g = normalize(gamma) * radians;
    // Rz(alpha) Rx(beta) Ry(gamma) applied to the back-facing camera axis -Z.
    // https://www.w3.org/TR/orientation-event/#worked-example
    // The device axes do not change when the screen switches to landscape.
    const x = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
    const y = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
    // Within about five degrees of pointing straight up/down, the horizontal
    // projection is too short for a stable heading; retain the previous view.
    if (Math.hypot(x, y) < 0.08) return null;
    return normalize(Math.atan2(x, y) / radians);
  }

  function shortestDelta(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    return normalize(normalize(current) - normalize(previous) + 180) - 180;
  }

  return { headingFromOrientation, shortestDelta };
});
