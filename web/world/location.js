export function positionFix(position, now = Date.now()) {
  const fix = { lat: position.coords?.latitude, lon: position.coords?.longitude,
    accuracy_m: position.coords?.accuracy, timestamp_ms: position.timestamp };
  const age = now - fix.timestamp_ms;
  if (![fix.lat, fix.lon, fix.accuracy_m, fix.timestamp_ms].every(Number.isFinite)
      || Math.abs(fix.lat) > 85 || Math.abs(fix.lon) > 180 || fix.accuracy_m < 0 || fix.accuracy_m > 1000
      || age > 60000 || age < -10000) throw new Error('The device location is invalid or outdated. Please wait for a new location fix.');
  return fix;
}

export function locationDistance(a, b) {
  if (!a || !b || ![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return Infinity;
  const rad = Math.PI / 180, lat = (b.lat - a.lat) * rad, lon = (b.lon - a.lon) * rad;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(lon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function createLiveLocation({ geolocation, onFix, onError, now = () => Date.now() }) {
  let watch = null, epoch = 0, latest = -Infinity;
  const stop = () => {
    ++epoch;
    if (watch !== null) geolocation?.clearWatch(watch);
    watch = null;
  };
  return {
    start() {
      if (watch !== null || !geolocation?.watchPosition) return;
      const session = ++epoch;
      watch = geolocation.watchPosition((position) => {
        if (session !== epoch) return;
        let fix;
        try { fix = positionFix(position, now()); } catch (error) { onError(error); return; }
        if (fix.timestamp_ms < latest) return;
        latest = fix.timestamp_ms; onFix(fix);
      }, (error) => {
        if (session !== epoch) return;
        if (error.code === 1) stop();
        onError(error);
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    },
    stop,
    get active() { return watch !== null; },
  };
}
