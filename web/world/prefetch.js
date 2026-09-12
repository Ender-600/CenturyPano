import { locationDistance } from './location.js';

const MAX_FIX_AGE = 20000, CACHE_TTL = 5 * 60000, MAX_CACHE = 3, BUDGET = 6, MAX_SPEED = 3.5;
const radians = Math.PI / 180;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const angleDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const stage = (job) => job?.stage || job?.status;
const jobId = (job) => job?.job_id || job?.id;
const capture = (plan) => plan?.source_panorama?.metadata;
const identity = (plan) => JSON.stringify([capture(plan)?.pano_id || plan?.plan_id,
  plan?.source_panorama?.sha256, plan?.target_year, plan?.generation_profile, plan?.panorama_editor]);
const profile = (plan) => JSON.stringify([plan?.target_year, plan?.generation_profile, plan?.panorama_editor]);
function bearing(a, b) {
  const lat1 = a.lat * radians, lat2 = b.lat * radians, delta = (b.lon - a.lon) * radians;
  return (Math.atan2(Math.sin(delta) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(delta)) / radians + 360) % 360;
}
function reliable(fix, now) {
  return fix && [fix.lat, fix.lon, fix.accuracy_m, fix.timestamp_ms].every(Number.isFinite)
    && Math.abs(fix.lat) <= 85 && Math.abs(fix.lon) <= 180 && fix.accuracy_m >= 0 && fix.accuracy_m <= 35
    && now - fix.timestamp_ms <= MAX_FIX_AGE && now - fix.timestamp_ms >= -5000;
}

// A displacement must clear an 8 m floor and 80% of the reported uncertainty.
// Three fixes, at least four seconds, and a coherent walking-speed path are
// required. Device compass/orientation never supplies the travel direction.
export function createTravelPredictor({ now = () => Date.now() } = {}) {
  let fixes = [], motion = null;
  function reset() { fixes = []; motion = null; }
  return {
    reset,
    latest: () => motion,
    latestFix: () => fixes.at(-1) || null,
    receiveFix(fix) {
      motion = null;
      if (!reliable(fix, now())) return null;
      const previous = fixes.at(-1);
      if (previous && fix.timestamp_ms <= previous.timestamp_ms) return null;
      if (previous && fix.timestamp_ms - previous.timestamp_ms > 25000) fixes = [];
      else if (previous) {
        const seconds = (fix.timestamp_ms - previous.timestamp_ms) / 1000;
        if (locationDistance(previous, fix) > MAX_SPEED * seconds + Math.max(previous.accuracy_m, fix.accuracy_m) * 0.5) return null;
      }
      fixes.push({ ...fix });
      fixes = fixes.filter((item) => fix.timestamp_ms - item.timestamp_ms <= 24000);
      if (fixes.length < 3) return null;
      const recent = fixes.filter((item) => fix.timestamp_ms - item.timestamp_ms <= 6000);
      if (recent.length >= 3 && fix.timestamp_ms - recent[0].timestamp_ms >= 4000
          && Math.max(...recent.map((item) => locationDistance(item, fix))) < Math.max(2, fix.accuracy_m * 0.25)) return null;
      for (let i = fixes.length - 3; i >= 0; --i) {
        const anchor = fixes[i], seconds = (fix.timestamp_ms - anchor.timestamp_ms) / 1000;
        const distance = locationDistance(anchor, fix);
        if (seconds < 4 || distance < Math.max(8, Math.max(anchor.accuracy_m, fix.accuracy_m) * 0.8)) continue;
        const speed = distance / seconds;
        if (speed < 0.55 || speed > MAX_SPEED) return null;
        let travelled = 0;
        for (let j = i + 1; j < fixes.length; ++j) travelled += locationDistance(fixes[j - 1], fixes[j]);
        if (distance / travelled < 0.72) return null;
        motion = { ...fix, heading_deg: bearing(anchor, fix), speed_mps: speed };
        return motion;
      }
      return null;
    },
  };
}

export function createPanoramaPrefetch({ request, preload, activate, onStatus = () => {},
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const predictor = createTravelPredictor({ now }), cache = new Map(), knownJobs = new Set();
  let context = { enabled: false, active: false, allowSwitch: false, plan: null, year: null };
  let epoch = 0, disposed = false, current = null, pollTimer = null, expiryTimer = null;
  let work = null, network = Promise.resolve(), latestFix = null;
  let predictionRequest = null;
  let used = 0, locked = false, lastAttempt = null, durationSeconds = 45, switching = false;
  let budgetSession = 0, retryAt = 0;
  let lockedDetail = '', lockedJob = null;
  let status = { state: 'off', detail: 'Walking preview is off.', remaining: BUDGET };
  const eligible = () => !disposed && context.enabled && context.active && context.plan?.plan_id
    && context.plan.input_kind === 'streetview_panorama' && Number(context.year) === Number(context.plan.target_year);
  const valid = (token) => token === epoch && eligible();
  function report(state, detail, extra = {}) {
    if (disposed) return;
    status = { state, detail, remaining: Math.max(0, BUDGET - used), ...extra };
    onStatus(status);
  }
  // All requests, including cancellation, share a serial transport. A queued
  // request checks its epoch immediately before it can reach the server.
  function send(path, options, guard = () => true) {
    const task = network.then(() => guard() ? request(path, options) : null);
    network = task.catch(() => {});
    return task;
  }
  function cancel(entry) {
    if (!jobId(entry?.job) || entry.job.can_cancel === false
        || ['ready', 'cancelled', 'expired', 'error', 'submission_unknown', 'insufficient_credits'].includes(stage(entry.job))) return;
    void send(`/world-jobs/${jobId(entry.job)}/cancel`, { method: 'POST' }).catch(() => {});
  }
  function disposeResource(entry) { try { entry?.resource?.dispose?.(); } catch { /* release is best effort */ } }
  function prune() {
    for (const [key, entry] of cache) if (entry.expires <= now()) {
      cache.delete(key); if (current === entry) current = null; disposeResource(entry);
    }
    while (cache.size > MAX_CACHE) {
      const [key, entry] = cache.entries().next().value;
      cache.delete(key); if (current === entry) current = null; disposeResource(entry);
    }
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = cache.size ? setTimer(() => { expiryTimer = null; prune();
      if (eligible() && !current) report('tracking', 'Walk steadily to prepare the next panorama.');
    }, Math.max(1, Math.min(...[...cache.values()].map((entry) => entry.expires)) - now())) : null;
  }
  function invalidate() {
    ++epoch;
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = null;
    cancel(current);
    current = null;
    predictor.reset(); latestFix = null;
  }
  function prepared(entry) { return { plan: entry.plan, job: entry.job, resource: entry.resource }; }
  function canSwitch(entry) {
    if (!eligible() || switching || !entry?.resource || !reliable(latestFix, now())
        || entry.expires <= now() || Number(entry.plan.target_year) !== Number(context.year)
        || identity(entry.plan) === identity(context.plan)) return false;
    const point = capture(entry.plan), origin = capture(context.plan);
    const distance = locationDistance(latestFix, point), oldDistance = locationDistance(latestFix, origin);
    return Number.isFinite(distance) && Number.isFinite(oldDistance)
      && distance <= Math.max(10, latestFix.accuracy_m)
      && distance + Math.max(5, latestFix.accuracy_m * 0.5) < oldDistance;
  }
  async function switchReady(manual = false) {
    const entry = current, token = epoch;
    if ((!manual && !context.allowSwitch) || !canSwitch(entry)) return false;
    switching = true;
    try {
      const success = await activate(prepared(entry));
      if (success) {
        // Resource ownership moves to the viewer. It must no longer be evicted
        // or reused as an already-disposed cached texture.
        cache.delete(entry.key);
        if (current === entry) current = null;
        if (valid(token)) { context = { ...context, plan: entry.plan }; report('tracking', 'Panorama updated. Preparing for your next steps.'); }
        prune();
      }
      return !!success;
    } catch {
      if (valid(token)) report('ready', 'The next panorama is ready. Move closer to view it.', { prepared: prepared(entry) });
      return false;
    } finally { switching = false; }
  }
  async function finish(entry, token) {
    if (!valid(token)) return;
    if (stage(entry.job) !== 'ready') return;
    report('loading', 'Downloading the next historical panorama.');
    const downloadStartedAt = now();
    let resource;
    try { resource = await preload(entry.plan, entry.job); }
    catch {
      if (valid(token)) { current = null; report('error', 'The next panorama could not be downloaded. It remains saved on the server.'); }
      return;
    }
    if (!valid(token)) { disposeResource({ resource }); return; }
    entry.resource = resource;
    // Job interest expires only while queued/in progress. Completed server
    // results remain reusable; decoded browser textures get their own TTL.
    entry.expires = now() + CACHE_TTL;
    const prior = cache.get(entry.key);
    if (prior && prior !== entry) disposeResource(prior);
    cache.delete(entry.key); cache.set(entry.key, entry); current = entry;
    const imageEditSeconds = entry.job.timing_s?.image_edit;
    const generationSeconds = Number.isFinite(imageEditSeconds) && imageEditSeconds > 0 ? imageEditSeconds : 0;
    // A quick cache download does not make the next cold image edit faster.
    // Use the recorded edit duration plus this download, never an old job's
    // total_to_assets time (which may include unrelated stages or long pauses).
    durationSeconds = clamp(Math.max(durationSeconds * 0.8, (now() - entry.startedAt) / 1000,
      generationSeconds + (now() - downloadStartedAt) / 1000), 10, 120);
    prune();
    report('ready', 'The next historical panorama is ready. It will appear when you get closer.', { prepared: prepared(entry) });
    await switchReady();
  }
  async function inspect(entry, token) {
    if (!valid(token)) return;
    if (stage(entry.job) !== 'ready'
        && (Number.isFinite(entry.job.expires_at) ? entry.job.expires_at * 1000 : entry.startedAt + CACHE_TTL) <= now()) {
      cancel(entry); current = null;
      report('tracking', 'The next panorama expired. Continue walking to prepare a new one.'); return;
    }
    const state = stage(entry.job);
    if (state === 'ready') { await finish(entry, token); return; }
    if (state === 'submission_unknown') {
      locked = true; current = null;
      lockedDetail = 'Submission unconfirmed. Check the saved job before restarting walking preview.'; lockedJob = entry.job;
      report('paused', lockedDetail, { job: lockedJob }); return;
    }
    if (['cancelled', 'expired', 'error', 'insufficient_credits'].includes(state)) {
      current = null;
      if (state === 'insufficient_credits') { locked = true; lockedDetail = 'Generation credits are unavailable.'; lockedJob = entry.job; }
      report('error', state === 'insufficient_credits' ? 'Generation credits are unavailable.' : 'The next panorama could not be prepared.'); return;
    }
    report('generating', 'Preparing a historical panorama farther along your route.', { job: entry.job });
    schedulePoll(entry, token, 2000);
  }
  function schedulePoll(entry, token, delay) {
    pollTimer = setTimer(() => {
      pollTimer = null;
      if (!valid(token) || work) return;
      const task = (async () => {
        try {
          const response = await send(`/world-jobs/${jobId(entry.job)}`, undefined, () => valid(token));
          if (!valid(token) || !response) return;
          entry.job = response.job || response;
          entry.failures = 0;
          await inspect(entry, token);
        } catch {
          if (valid(token)) {
            if ((Number.isFinite(entry.job.expires_at) ? entry.job.expires_at * 1000 : entry.startedAt + CACHE_TTL) <= now()) {
              cancel(entry); current = null; report('error', 'The next panorama expired while its status was unavailable.');
            } else {
              entry.failures = (entry.failures || 0) + 1;
              report('generating', 'Reconnecting to the saved panorama job.', { job: entry.job });
              schedulePoll(entry, token, Math.min(30000, 2000 * 2 ** Math.min(entry.failures, 4)));
            }
          }
        }
      })();
      work = task; void task.finally(() => { if (work === task) work = null; });
    }, delay);
  }
  function reusable(motion) {
    return [...cache.values()].reverse().find((entry) => Number(entry.plan.target_year) === Number(context.year)
      && profile(entry.plan) === profile(context.plan)
      && identity(entry.plan) !== identity(context.plan)
      && locationDistance(capture(entry.plan), motion) <= 180
      && (locationDistance(capture(entry.plan), motion) <= Math.max(10, motion.accuracy_m)
        || angleDifference(bearing(motion, capture(entry.plan)), motion.heading_deg) < 50));
  }
  async function submit(motion, token) {
    const session = budgetSession;
    predictionRequest = { token, heading: motion.heading_deg };
    used++;
    lastAttempt = { ...motion, attemptedAt: now(), profile: profile(context.plan) };
    const startedAt = now();
    report('finding', 'Finding the next Street View panorama along your route.');
    try {
      const response = await send('/world-prefetch', { method: 'POST', body: {
        plan_id: context.plan.plan_id, lat: motion.lat, lon: motion.lon,
        location_accuracy_m: motion.accuracy_m, location_timestamp_ms: motion.timestamp_ms,
        heading_deg: motion.heading_deg, speed_mps: motion.speed_mps,
        lookahead_m: clamp(motion.speed_mps * (durationSeconds + 10), 30, 150),
      } }, () => valid(token));
      if (!response) return;
      if (!valid(token)) { cancel(response); return; }
      if (response.skipped || response.status === 'skipped') {
        used--; report('tracking', 'Waiting for a clear next panorama along your route.'); return;
      }
      if (!response.plan?.plan_id || !jobId(response.job)) throw new Error('Unconfirmed prefetch response');
      const id = jobId(response.job);
      if (response.reused || response.created === false || knownJobs.has(id)) used--;
      knownJobs.add(id);
      const entry = { plan: response.plan, job: response.job, heading: motion.heading_deg,
        key: identity(response.plan), startedAt };
      if (entry.key === identity(context.plan)) { cancel(entry); report('tracking', 'Continue walking to reach a different panorama.'); return; }
      current = entry;
      const cached = cache.get(entry.key);
      if (cached) {
        current = cached; report('ready', 'The next historical panorama is ready.', { prepared: prepared(cached) });
        await switchReady(); return;
      }
      await inspect(entry, token);
    } catch (error) {
      const statusCode = Number(error?.status);
      if (statusCode >= 400 && statusCode < 500 && ![408, 499].includes(statusCode)) {
        // A definite service rejection did not start a paid generation. A
        // response from an old session must not refund or pause the new one.
        if (session === budgetSession) used = Math.max(0, used - 1);
        if (valid(token)) {
          if (statusCode === 429) {
            retryAt = now() + 60000;
            report('paused', 'Preview requests are rate limited. No generation was started. Waiting before trying again.');
          } else {
            report('error', `Preview request rejected (${statusCode}). No generation was started. Waiting for a new location.`);
          }
        }
        return;
      }
      // A POST timeout may have accepted a paid task. Never auto-resubmit.
      // Keep this safety lock even across Stop → Start, but surface the late
      // failure in the current session instead of silently leaving it tracking.
      if (disposed) return;
      locked = true;
      lockedDetail = token === epoch ? 'Submission unconfirmed. Check saved jobs before restarting walking preview.'
        : 'An earlier request is still unconfirmed. Walking preview is paused. Check saved jobs before restarting.';
      lockedJob = null;
      if (context.enabled) report('paused', lockedDetail);
    } finally {
      if (predictionRequest?.token === token) predictionRequest = null;
    }
  }
  function receiveFix(fix) {
    if (!eligible()) return null;
    const motion = predictor.receiveFix(fix);
    latestFix = predictor.latestFix();
    prune();
    if (!latestFix || latestFix.timestamp_ms !== fix?.timestamp_ms) return null;
    const candidateHeading = current?.heading ?? (predictionRequest?.token === epoch ? predictionRequest.heading : null);
    if (motion && candidateHeading !== null && angleDifference(motion.heading_deg, candidateHeading) > 55) {
      const keptFix = latestFix;
      invalidate(); latestFix = keptFix;
      report('tracking', 'Your route changed. Looking ahead in your new direction.');
      return motion;
    }
    if (current?.resource) void switchReady();
    if (!motion || current || work || switching || locked || now() < retryAt) return motion;
    const cached = reusable(motion);
    if (cached) {
      current = cached; cached.heading = motion.heading_deg;
      report('ready', 'The next historical panorama is already prepared.', { prepared: prepared(cached) });
      void switchReady(); return motion;
    }
    if (used >= BUDGET) { report('paused', 'This session has reached its six-panorama limit. Stop and restart to prepare more.'); return motion; }
    if (lastAttempt && (now() - lastAttempt.attemptedAt < 20000
        || lastAttempt.profile === profile(context.plan)
          && locationDistance(lastAttempt, motion) < Math.max(15, motion.accuracy_m * 0.8)
          && angleDifference(lastAttempt.heading_deg, motion.heading_deg) <= 55)) return motion;
    const task = submit(motion, epoch);
    work = task; void task.finally(() => { if (work === task) work = null; });
    return motion;
  }
  return {
    receiveFix,
    activateReady: () => switchReady(true),
    get status() { return status; },
    setContext(next) {
      const previous = context;
      context = { ...context, ...next };
      const restarted = context.enabled && !previous.enabled;
      const changed = previous.plan?.plan_id !== context.plan?.plan_id || Number(previous.year) !== Number(context.year)
        || previous.active !== context.active || previous.enabled !== context.enabled;
      if (changed) invalidate();
      if (restarted) { ++budgetSession; used = 0; locked = false; lockedDetail = ''; lockedJob = null; lastAttempt = null; retryAt = 0; }
      if (!context.enabled) report('off', 'Walking preview is off.');
      else if (!eligible()) report('paused', 'Walking preview will resume when this view is active.');
      else if (locked) report('paused', lockedDetail, { job: lockedJob });
      else if (changed) report('tracking', 'Walk steadily to prepare the next panorama.');
      else if (context.allowSwitch) void switchReady();
    },
    invalidate() { invalidate(); if (eligible()) report('tracking', 'Waiting for fresh movement before preparing the next panorama.'); },
    reset() { invalidate(); ++budgetSession; used = 0; locked = false; lockedDetail = ''; lockedJob = null; lastAttempt = null; retryAt = 0;
      if (eligible()) report('tracking', 'Walk steadily to prepare the next panorama.'); },
    dispose() {
      invalidate(); disposed = true;
      if (expiryTimer !== null) clearTimer(expiryTimer);
      expiryTimer = null;
      for (const entry of cache.values()) disposeResource(entry);
      cache.clear();
    },
  };
}
