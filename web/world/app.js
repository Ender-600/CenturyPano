import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { createPanoramaMesh, PanoramaLookControls, panoramaHeading, setCameraBearing, cameraBearing } from './panorama.js';
import { createOrientationController, headingFromQuaternion } from './orientation.js';
import { createLiveLocation, positionFix, locationDistance } from './location.js';
import { createYearWheel } from './year-wheel.js';
import { createMotionController } from './motion.js';
import { createGPSWalkingController } from './gps-walking.js';
import { createScaleCalibration } from './scale.js';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'century.world.access';
const RESUME_KEY = 'century.world.resume';
const TERMINAL = new Set(['ready', 'error', 'submission_unknown', 'insufficient_credits']);
const STAGES = {
  queued: 'World queued', rendering_depth: 'Rendering historical depth',
  submitting_depth: 'Submitting depth panorama', generating_depth: 'Generating historical panorama',
  submitting_image_edit: 'Submitting historical panorama edit', editing_panorama: 'Editing historical panorama',
  fetching_pano: 'Saving historical panorama', pano_ready: 'Historical panorama ready',
  submitting_world: 'Submitting 3D world', generating_world: 'Generating 3D world',
  fetching_assets: 'Downloading and checking world assets', ready: 'World assets ready',
  paused: 'Service paused; waiting to resume', error: 'Generation stopped',
  submission_unknown: 'Submission not yet confirmed', insufficient_credits: 'Insufficient server credits',
};
const STANDARD_REASONS = new Map([
  ['No bound archival date or target-year footprint. Retained only as an unverified modern massing placeholder.',
    'No archival date or historical footprint is available. Modern massing is retained as an unverified placeholder.'],
  ['Documented construction phases span multiple years; modern footprint does not identify each phase. No whole-building deletion is justified.',
    'Construction spanned several phases. The modern footprint does not distinguish them, so removing the entire building is not justified.'],
  ['Documented completion predates the reference year; retained modern outline and height still require historical-shape verification.',
    'Completion predates the selected year; the retained modern outline and height remain unverified.'],
  ['Reference year overlaps a completion/opening year; exact date and construction geometry require review.',
    'The selected year overlaps completion or opening. The exact date and historical form need review.'],
]);
const state = {
  token: '', config: null, plan: null, job: null, planBusy: false, generateBusy: false,
  model: 'marble-1.1',
  restoring: false, resumeBusy: false, submissionUnknown: false, planEpoch: 0, jobEpoch: 0, viewEpoch: 0,
  pollTimer: null, view: 'source', viewAbort: null, userViewLocked: false,
  imageURL: null, engine: null, keys: new Set(), touchMoves: new Set(),
  locationMode: 'device', locationFix: null, locationEpoch: 0, locationBusy: false, locationError: '',
  viewingSavedPlan: false, streetViewBusy: false,
  locationErrorCode: 0, locationPermissionState: 'unknown', locationPermissionStatus: null,
  locationPermissionHandler: null, locationPermissionQuery: false, locationRecoveryPending: false,
  locationLinkBusy: false,
  walkScaleWorldKey: null, walkScaleReference: null, scaleCalibration: null,
  gpsWalking: null, walkNotice: '',
  walking: null, orientation: null, calibrating: false, panoramaPose: null, travelWatch: null, travel: null, travelEpoch: 0,
  motionFrameAt: 0, autoPrepareAttempted: false, bootReady: false,
  liveLocation: null, liveAnchor: null, liveAttemptAt: 0, liveFailed: false, liveTimer: null, yearWheel: null,
};

function storageGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) {
  try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* Optional persistence. */ }
}
function text(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
const MODEL_OPTIONS = [
  { id: 'marble-1.1', label: 'Standard · Marble 1.1', world_credits: 1500 },
  { id: 'marble-1.0-draft', label: 'Quick draft', world_credits: 150 },
];
function modelProfile(id = state.model) {
  const known = MODEL_OPTIONS.find((profile) => profile.id === id);
  if (!known) return undefined;
  const configured = Array.isArray(state.config?.models) ? state.config.models.find((profile) => profile.id === id) : null;
  return Number.isInteger(configured?.world_credits) && configured.world_credits > 0
    ? { ...known, world_credits: configured.world_credits } : known;
}
function configureModels() {
  const offered = Array.isArray(state.config?.models) ? state.config.models : MODEL_OPTIONS;
  const profiles = MODEL_OPTIONS.filter((profile) => offered.some((item) => item.id === profile.id));
  const select = $('world-model'); select.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement('option'); option.value = profile.id;
    option.textContent = profile.label; select.append(option);
  }
  const defaultModel = state.config?.model || 'marble-1.1';
  state.model = profiles.some((profile) => profile.id === defaultModel) ? defaultModel : profiles[0]?.id || '';
  select.value = state.model;
}
function renderGenerationQuality() {
  const profile = modelProfile();
  $('world-model').value = state.job ? text(state.job.model) : state.model;
  const displayed = state.job ? (typeof state.job.model === 'string' ? modelProfile(state.job.model) : null) : profile;
  $('generation-quality').textContent = state.job
    ? `Current job: ${displayed?.label || text(state.job.model, 'Model not recorded')}. Prepare Street View again to generate a new version at your chosen quality. Saved versions retain their original quality.`
    : profile ? `World generation: ${profile.world_credits.toLocaleString('en-US')} credits (about $${(profile.world_credits / 1250).toFixed(2)}). Panorama editing is billed separately. Full resolution is preferred and may take longer to load.`
      : 'No generation models are available on this service.';
}
function worldQualityLabel(job = state.job, asset = assetFor('world')) {
  const model = typeof job?.model === 'string' ? modelProfile(job.model)?.label || job.model : 'Model not recorded';
  if (!asset) return `${model} · 3D assets pending`;
  const lod = asset.lod === 'full_res' ? 'Full resolution' : asset.lod ? `Reduced resolution ${text(asset.lod)}` : 'Asset resolution not recorded';
  const points = asset.validation?.num_points;
  return `${model} · ${lod}${Number.isInteger(points) && points > 0 ? ` · ${points.toLocaleString('en-US')} points` : ''}`;
}
function changeReason(change) {
  const reason = text(change.reason, 'The historical form of this location is unverified.');
  if (change.origin === 'user_edit' || change.evidence_basis === 'user_supplied_unverified') return reason;
  if (STANDARD_REASONS.has(reason)) return STANDARD_REASONS.get(reason);
  const removal = /^Official CMU completion\/opening evidence postdates (\d{4})\. Remove the completed modern building; earlier structures and construction-stage geometry remain unknown\.$/.exec(reason);
  return removal ? `Official CMU records show completion or opening after ${removal[1]}, so the modern massing is removed. Earlier buildings and construction stages remain unknown.` : reason;
}
function failedHistoricalReview(job = state.job) {
  return job?.validation?.historical_accuracy === 'failed_visual_review'
    || job?.review?.status === 'rejected' && job.review.scope === 'historical_appearance';
}
function reviewNotes(job = state.job) {
  return (Array.isArray(job?.review?.notes) ? job.review.notes : []).filter((note) => typeof note === 'string').join(' ');
}
function applyReviewNotice() {
  if (!['world', 'pano'].includes(state.view) || !failedHistoricalReview()) return;
  const suffix = ' · Historical appearance failed review';
  if (!$('view-caption').textContent.endsWith(suffix)) $('view-caption').textContent += suffix;
  $('viewer-note').textContent = 'Historical appearance failed review · See settings';
  const base = $('view-details').textContent.split('\nHistorical appearance failed review: ')[0];
  $('view-details').textContent = `${base}\nHistorical appearance failed review: ${reviewNotes() || 'The generated appearance does not match the selected year or location.'} Assets are available for inspection; they are not an accurate reconstruction of this period.`;
}
function message(value = '', error = false) {
  $('message').textContent = value;
  $('message').classList.toggle('error', error);
}
function validToken(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value); }
function safeAssetURL(value) {
  if (typeof value !== 'string' || !/^\/world-(?:plans|jobs)\/[a-f0-9-]{16,64}\/assets\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Invalid asset URL. Only files saved by the current generation service are supported.');
  }
  return value;
}
function safeSourceURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

class RequestError extends Error {
  constructor(status, messageText) { super(messageText); this.status = status; }
}

async function api(path, { method = 'GET', body, auth = true, signal, format = 'json' } = {}) {
  // Never attach the access token to external URLs, redirects, images, or query strings.
  if (typeof path !== 'string' || !/^\/world-(?:config|session|plans|jobs)(?:\/[^?#]*)?$/.test(path)) {
    throw new RequestError(0, 'Invalid service URL.');
  }
  if (auth && !state.token) throw new RequestError(401, 'Enter an access code and connect to the generation service first.');
  const headers = new Headers();
  if (auth) headers.set('Authorization', `Bearer ${state.token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, format === 'json' && method === 'GET' ? 30000 : 180000);
  try {
    const response = await fetch(path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      if (response.status === 401) {
        state.token = ''; storageSet(TOKEN_KEY, null);
        $('access-panel').hidden = false; $('connection').textContent = 'Access code required';
        syncUI();
      }
      let detail = '';
      try { detail = text((await response.json()).detail); } catch { /* No raw response bodies. */ }
      if (!detail || detail.length > 300 || /https?:\/\/|bearer|api.key/i.test(detail)) {
        detail = `Request failed (HTTP ${response.status}). Check the service status.`;
      }
      throw new RequestError(response.status, detail);
    }
    if (format === 'bytes') return await response.arrayBuffer();
    if (format === 'blob') return await response.blob();
    return await response.json();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (signal?.aborted) throw new DOMException('View replaced', 'AbortError');
    throw new RequestError(0, method === 'POST'
      ? 'Submission response unconfirmed. Check the service status before trying again; this page will not resubmit automatically.'
      : 'Connection interrupted. Check your network or the generation service.');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
}

function saveResume() {
  if (!state.plan && !state.job) return;
  storageSet(RESUME_KEY, JSON.stringify({
    plan_id: state.plan?.plan_id || state.job?.plan_id || null,
    job_id: state.job?.job_id || state.job?.id || null,
    submission_unknown: state.submissionUnknown,
  }));
}

function setJobURL(jobId = null) {
  const query = new URLSearchParams(location.search);
  if (jobId && /^[a-f0-9]{32}$/.test(jobId)) query.set('world', jobId);
  else query.delete('world');
  history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}${location.hash || ''}`);
}

function revealMobilePreview() {
  if (window.matchMedia?.('(max-width: 780px)').matches) {
    document.querySelector('.workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function syncUI() {
  const running = state.job && !TERMINAL.has(state.job.stage || state.job.status);
  const busy = state.planBusy || state.generateBusy || state.restoring || state.resumeBusy || running;
  for (const element of $('plan-form').elements || $('plan-form').querySelectorAll('input,select,button')) element.disabled = !!busy;
  state.yearWheel?.setDisabled(!!busy || state.config?.viewer_only === true);
  if ($('test-prepare')) $('test-prepare').disabled = !!busy || !state.token || state.locationMode !== 'test';
  if ($('snapshot')) $('snapshot').disabled = !!busy || !state.token || state.locationMode !== 'test';
  $('lat').readOnly = $('lon').readOnly = state.locationMode === 'device';
  $('gps').disabled = !!busy || state.locationBusy;
  $('retry-location').disabled = state.locationBusy || state.planBusy;
  $('copy-location-link').disabled = state.locationLinkBusy;
  $('open-streetview').disabled = !!busy || state.streetViewBusy;
  $('geometry-test').disabled = !!busy || !state.token || state.locationMode !== 'test';
  $('test-controls').hidden = state.locationMode !== 'test';
  $('location-mode').value = state.locationMode;
  $('location-label').textContent = state.locationMode === 'device' ? 'Current location' : 'Test location · Not your current position';
  renderLocationStatus(); renderLocationHelp();
  if ($('edits-file')) $('edits-file').disabled = !!busy || !state.token || !state.plan;
  const changedYear = state.plan && Number($('year').value) !== state.plan.target_year;
  $('generate').hidden = !state.plan || state.config?.viewer_only === true;
  $('generate').disabled = !state.token || !state.plan || !state.config?.configured || !!busy
    || !!state.job && !changedYear || state.submissionUnknown || !modelProfile()
    || state.plan?.input_kind === 'streetview_panorama' && state.config?.panorama_editor_configured === false;
  $('world-model').disabled = !!busy || !!state.job || state.submissionUnknown;
  renderGenerationQuality();
  const streetview = state.config?.streetview;
  $('streetview-status').textContent = !state.config ? 'Checking Street View service…'
    : !streetview?.configured ? 'Google panorama retrieval is not configured. You can view your current location in Google Maps.'
      : !streetview?.ai_authorized ? 'Authorization to use Google panoramas for generation is not configured. You can open the official Street View preview.'
        : 'Generation uses the 360° Street View photo of this location.';
  $('generate').textContent = state.generateBusy ? 'Creating world job…'
    : !changedYear && state.job?.stage === 'ready' ? (failedHistoricalReview() ? 'Appearance needs review' : 'World generated')
      : !changedYear && state.job ? STAGES[state.job.stage] || 'Generating world'
        : state.submissionUnknown ? 'Submission pending confirmation' : `Step into ${$('year').value} →`;
  const profile = modelProfile();
  $('generation-price').textContent = state.plan && (!state.job || changedYear) && profile
    ? `${profile.label} · ${profile.world_credits.toLocaleString('en-US')} credits; image editing billed separately` : '';
  $('generation-price').hidden = !$('generation-price').textContent;
  $('window-location').textContent = state.locationMode === 'test' ? 'Test location'
    : state.viewingSavedPlan ? 'Saved Street View' : state.locationBusy ? 'Locating…'
      : state.locationError ? 'Location permission needed' : 'Current location';
  $('scene-progress').textContent = state.planBusy ? 'Fetching Street View for your location…'
    : state.job && state.job.stage !== 'ready' ? STAGES[state.job.stage] || '' : '';
  $('scene-progress').hidden = !$('scene-progress').textContent;
  for (const button of document.querySelectorAll('[data-view]')) {
    const view = button.dataset.view;
    button.classList.toggle('active', view === state.view || view === 'depth' && state.view === 'depth_preview');
    button.setAttribute('aria-pressed', String(view === state.view || view === 'depth' && state.view === 'depth_preview'));
    button.disabled = !availableView(view);
    button.hidden = (!state.plan || state.plan.input_kind === 'streetview_panorama') && ['historical', 'modern', 'depth'].includes(view);
  }
  updateMotionUI();
}

function assetFor(view) {
  const assets = Array.isArray(state.job?.assets) ? state.job.assets : [];
  if (view === 'source' && state.plan?.assets?.['source_panorama.jpg']) {
    return { filename: 'source_panorama.jpg', url: state.plan.assets['source_panorama.jpg'] };
  }
  if (view === 'world') return assets.find((asset) => asset.kind === 'spz');
  if (view === 'pano') return assets.find((asset) => asset.kind === 'historical_pano')
    || assets.find((asset) => asset.kind === 'pano');
  const filename = { historical: 'historical.glb', modern: 'modern.glb', depth: 'depth.png', depth_preview: 'depth_preview.png' }[view];
  if (filename && state.plan?.assets?.[filename]) return { filename, url: state.plan.assets[filename] };
  return assets.find((asset) => asset.kind === ({ historical: 'coarse_mesh', depth: 'depth', depth_preview: 'depth_preview' }[view]));
}
function availableView(view) { return !!assetFor(view); }

function isPanorama(view = state.view) { return view === 'source' || view === 'pano'; }
function canFollowView() { return (isPanorama() || state.view === 'world') && !!state.engine?.current; }
function updateMotionUI() {
  const status = state.orientation?.getStatus();
  const enabled = status?.enabled === true;
  $('motion-toggle').disabled = !canFollowView() || nativeWalkingLocked();
  $('motion-toggle').textContent = enabled ? 'Pause motion' : 'Enable motion';
  $('motion-toggle').setAttribute('aria-pressed', String(enabled));
  $('align-view').disabled = !enabled || !canFollowView() || status.phase !== 'tracking' || nativeWalkingLocked();
  $('align-view').textContent = state.calibrating ? 'Finish alignment' : 'Align heading';
  const heading = enabled ? status.physicalHeading : null;
  const travel = state.travel && Date.now() - state.travel.timestamp < 15000 ? state.travel.heading : null;
  $('heading-readout').textContent = Number.isFinite(heading) ? `View ~${Math.round(heading)}°`
    : enabled ? 'Relative heading' : 'Drag to look around';
  if (Number.isFinite(travel)) $('heading-readout').textContent += ` · Travel ${Math.round(travel)}°`;
  $('motion-status').textContent = state.calibrating
    ? 'Point your phone at a landmark, drag the view to face the same direction, then tap “Finish alignment”.'
    : enabled ? (status.message || 'Turn your phone to look around.')
      : status?.message || (state.view === 'world' ? 'Explore the 3D world virtually; align the heading manually.' : 'Allow orientation access to follow your phone, or drag to look around.');
  updateWalkingUI();
}

function getWalkingController() {
  if (!state.walking) state.walking = createMotionController({ window, document,
    onChange: () => { state.keys.clear(); state.touchMoves.clear(); updateMotionUI(); } });
  return state.walking;
}
function nativeWalkingLocked() { return state.walking?.getStatus().locked === true; }
function gpsWalkingLocked() { return state.gpsWalking?.getStatus().locked === true; }
function walkingLocked() { return nativeWalkingLocked() || gpsWalkingLocked(); }
function walkingMode() {
  const selected = $('walk-mode').value;
  return selected === 'gps' || selected === 'native' ? selected : getWalkingController().available() ? 'native' : 'gps';
}
function getGPSWalkingController() {
  if (!state.gpsWalking) state.gpsWalking = createGPSWalkingController({ window, document,
    onChange: () => { state.keys.clear(); state.touchMoves.clear(); updateMotionUI(); } });
  return state.gpsWalking;
}
function walkingWorldReady() { return state.view === 'world' && !!state.engine?.current && !state.engine.renderer.domElement.hidden; }
function updateWalkingUI() {
  const walking = getWalkingController(), gps = walkingMode() === 'gps';
  const status = gps ? state.gpsWalking?.getStatus() || { message: 'GPS walking is ready. Calibrate scale and heading first.' } : walking.getStatus();
  const available = gps ? window.isSecureContext && !!navigator.geolocation?.watchPosition && state.locationMode === 'device' : walking.available();
  const locked = walkingLocked();
  const detail = gps && status.phase === 'tracking'
    ? `${status.message} Accuracy ~±${Math.round(status.accuracyMeters)} m · About ${status.displacementMeters.toFixed(1)} m from the start.`
    : status.message;
  const ready = walkingWorldReady(), metric = ready && state.engine.metric === true;
  $('walk-start').textContent = gps ? 'Enable GPS walking' : 'Enable walking';
  $('walk-start').disabled = !available || !ready || locked;
  $('walk-reanchor').disabled = !available || !ready || !locked;
  $('walk-stop').disabled = !locked && !status.enabled;
  $('walk-scale').disabled = metric || locked;
  $('walk-measure').disabled = !ready || metric || locked;
  $('walk-gps-options').hidden = !gps;
  $('walk-heading').disabled = !!status.enabled;
  $('walk-mode').disabled = locked;
  $('walk-scale').placeholder = metric ? '1 (provider metric scale)' : 'Enter the calibrated scale';
  $('walk-scale-note').textContent = metric
    ? 'Provider metric scale applied: 1 real meter equals 1 world unit. Geographic alignment and historical geometry remain unverified.'
    : state.walkScaleReference ? `Calibrated using a real distance of ${state.walkScaleReference.realMeters} m between two points. This scale uses your reference distance; generated geometry may still vary locally.`
    : 'This world has no usable metric scale. Enter the model units per real meter; manual scale has not been independently verified.';
  $('walk-status').textContent = state.walkNotice || (!available
    ? gps ? 'GPS walking requires HTTPS, browser location support, and “Current location” mode.' : 'AR tracking requires the CenturyPano native app (ARKit / ARCore). GPS walking is also available.'
    : !ready ? 'Switch to a loaded generated world to enable walking.' : detail);
  $('walk-status').classList.toggle('warning', !!state.walkNotice || status.needsReanchor || ['denied', 'error', 'scale'].includes(status.phase));
  $('walking-readout').hidden = !gpsWalkingLocked();
  $('walking-readout').textContent = gpsWalkingLocked() ? detail : '';
  $('reset-view').disabled = locked;
  if (locked) $('move-pad').hidden = true;
  if (nativeWalkingLocked()) {
    $('motion-status').textContent = status.message;
    $('heading-readout').textContent = status.phase === 'tracking' ? 'Spatial tracking' : 'Viewpoint frozen';
    $('move-pad').hidden = true;
    if (state.engine) { state.engine.controls.enabled = false; if (state.engine.look) state.engine.look.enabled = false; }
  } else if (gpsWalkingLocked() && state.engine) {
    state.engine.controls.enabled = false;
    if (state.engine.look) state.engine.look.enabled = true;
  }
}
function walkingParameters() {
  const engine = state.engine;
  return { worldUnitsPerMeter: engine.metric ? 1 : Number($('walk-scale').value),
    anchorPosition: engine.camera.position, anchorQuaternion: engine.camera.quaternion };
}
function startWalking() {
  if (!walkingWorldReady()) return;
  state.walkNotice = '';
  if (walkingMode() === 'gps') { startGPSWalking(); return; }
  cancelScaleCalibration();
  state.gpsWalking?.stop();
  const walking = getWalkingController();
  if (!walking.available()) { walking.start(walkingParameters()); return; }
  const parameters = walkingParameters();
  if (!Number.isFinite(parameters.worldUnitsPerMeter) || parameters.worldUnitsPerMeter <= 0) {
    walking.start(parameters); return;
  }
  state.orientation?.stop(); stopTravelTracking(); state.calibrating = false;
  state.keys.clear(); state.touchMoves.clear();
  // Flush any queued orbit damping without moving the anchor viewpoint.
  const engine = state.engine, position = engine.camera.position.clone(), quaternion = engine.camera.quaternion.clone();
  const target = engine.controls.target.clone(), damping = engine.controls.enableDamping;
  engine.controls.enableDamping = false; engine.controls.update();
  engine.camera.position.copy(position); engine.camera.quaternion.copy(quaternion); engine.controls.target.copy(target);
  engine.controls.enableDamping = damping;
  walking.start(walkingParameters()); updateMotionUI();
}
function stopWalking(phase = 'idle') {
  if (gpsWalkingLocked() && state.engine) {
    state.engine.controls.target.copy(state.engine.camera.position)
      .add(new THREE.Vector3(0, 0, -1).applyQuaternion(state.engine.camera.quaternion));
  }
  state.walkNotice = ''; state.gpsWalking?.stop(phase);
  state.walking?.stop(phase); state.keys.clear(); state.touchMoves.clear();
  if (walkingWorldReady()) $('move-pad').hidden = false;
  updateMotionUI();
}
function applyNativeWalking(engine) {
  const pose = state.walking?.getPose();
  if (!nativeWalkingLocked()) return false;
  engine.controls.enabled = false; if (engine.look) engine.look.enabled = false;
  state.keys.clear(); state.touchMoves.clear();
  if (pose) {
    engine.camera.position.copy(pose.position); engine.camera.quaternion.copy(pose.quaternion);
    engine.controls.target.copy(pose.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion));
  }
  return true;
}

function startGPSWalking() {
  if (!window.isSecureContext || !navigator.geolocation?.watchPosition || state.locationMode !== 'device') return;
  const parameters = walkingParameters();
  if (!Number.isFinite(parameters.worldUnitsPerMeter) || parameters.worldUnitsPerMeter <= 0 || parameters.worldUnitsPerMeter > 10000) {
    state.walkNotice = 'Calibrate the scale first: how many world units equal 1 real meter?'; updateWalkingUI(); return;
  }
  const typed = $('walk-heading').value.trim(), orientation = state.orientation?.getStatus();
  const heading = typed ? Number(typed) : orientation?.enabled && orientation.phase === 'tracking' ? orientation.physicalHeading : null;
  const worldHeading = headingFromQuaternion(state.engine.camera.quaternion);
  if (!Number.isFinite(heading) || heading < 0 || heading >= 360 || worldHeading === null) {
    state.walkNotice = 'Point your phone forward and enable motion to read the compass, or enter the actual heading of the current view.'; updateWalkingUI(); return;
  }
  cancelScaleCalibration(); state.walking?.stop();
  const engine = state.engine, position = engine.camera.position.clone(), quaternion = engine.camera.quaternion.clone();
  const target = engine.controls.target.clone(), damping = engine.controls.enableDamping;
  engine.controls.enableDamping = false; engine.controls.update();
  engine.camera.position.copy(position); engine.camera.quaternion.copy(quaternion); engine.controls.target.copy(target);
  engine.controls.enableDamping = damping;
  const started = getGPSWalkingController().start({ ...parameters, headingDegrees: heading, worldYaw: -worldHeading * Math.PI / 180 });
  if (started) {
    // Start a fresh watch so queued/cached fixes cannot become a new session's origin.
    stopLiveLocation(); state.locationErrorCode = 0; state.locationError = ''; startLiveLocation();
  }
  updateMotionUI();
}

function applyGPSWalking(engine, dt) {
  if (!gpsWalkingLocked()) return false;
  const position = state.gpsWalking.getPosition(dt);
  engine.controls.enabled = false;
  if (position) {
    engine.camera.position.copy(position);
  }
  engine.controls.target.copy(engine.camera.position)
    .add(new THREE.Vector3(0, 0, -1).applyQuaternion(engine.camera.quaternion));
  return true;
}

function cancelScaleCalibration() {
  state.scaleCalibration?.cancel(false);
  document.body.classList.remove('measuring-scale');
}
function openSettings() {
  const dialog = $('settings-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}
function closeSettings() {
  const dialog = $('settings-dialog');
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}
function startScaleCalibration() {
  if (!walkingWorldReady() || state.engine.metric || walkingLocked()) return;
  state.orientation?.stop(); stopTravelTracking(); state.calibrating = false;
  state.keys.clear(); state.touchMoves.clear();
  if (!state.scaleCalibration) state.scaleCalibration = createScaleCalibration({
    getEngine: () => state.engine, getSceneKey: () => state.viewEpoch, document,
    onApply: (result) => {
      $('walk-scale').value = String(result.worldUnitsPerMeter);
      state.walkScaleReference = result; updateWalkingUI();
    },
    onClose: () => {
      document.body.classList.remove('measuring-scale');
      updateMotionUI(); openSettings();
    },
  });
  try {
    state.scaleCalibration.start(); document.body.classList.add('measuring-scale');
    closeSettings(); updateMotionUI();
  } catch (error) { cancelScaleCalibration(); message(error.message, true); }
}

function stopTravelTracking() {
  ++state.travelEpoch;
  if (state.travelWatch !== null) navigator.geolocation?.clearWatch?.(state.travelWatch);
  state.travelWatch = null; state.travel = null;
}

function startTravelTracking() {
  if (state.travelWatch !== null || state.locationMode !== 'device' || !navigator.geolocation?.watchPosition
      || !state.orientation?.getStatus().enabled || document.visibilityState === 'hidden') return;
  const epoch = ++state.travelEpoch;
  const current = () => epoch === state.travelEpoch && state.locationMode === 'device'
    && state.orientation?.getStatus().enabled && document.visibilityState !== 'hidden';
  state.travelWatch = navigator.geolocation.watchPosition((position) => {
    if (!current()) return;
    const { heading, speed, accuracy } = position.coords || {};
    // GPS course is direction of travel, never the direction of the rear camera.
    if (Number.isFinite(heading) && heading >= 0 && heading < 360 && Number.isFinite(speed) && speed >= 0.5
        && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 35 && Number.isFinite(position.timestamp)
        && Date.now() - position.timestamp >= -10000 && Date.now() - position.timestamp < 15000) {
      state.travel = { heading, speed, timestamp: position.timestamp };
    } else state.travel = null;
    updateMotionUI();
  }, () => { if (current()) { state.travel = null; updateMotionUI(); } }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
}

function getOrientation() {
  if (!state.orientation) state.orientation = createOrientationController({
    window, document, getCameraQuaternion: () => state.engine?.camera.quaternion,
    onChange: (status) => {
      if (!status.enabled) { state.calibrating = false; stopTravelTracking(); }
      updateMotionUI();
    },
  });
  return state.orientation;
}

function toggleMotion() {
  if (!canFollowView() || nativeWalkingLocked()) return;
  const orientation = getOrientation();
  if (orientation.getStatus().enabled) { orientation.stop(); state.calibrating = false; stopTravelTracking(); updateMotionUI(); return; }
  // Call directly in the button gesture so Safari can present its permission UI.
  const starting = orientation.startFromGesture({ relativeOnly: state.view === 'world'
    || !Number.isFinite(state.plan?.source_panorama?.metadata?.heading) });
  void starting.then((started) => {
    if (started && orientation.getStatus().enabled && document.visibilityState !== 'hidden' && canFollowView()) startTravelTracking();
    updateMotionUI();
  });
}

function calibrateView() {
  if (nativeWalkingLocked()) return;
  if (!state.orientation?.getStatus().enabled || !canFollowView()) return;
  if (state.calibrating) {
    if (state.orientation.calibrate(state.engine.camera.quaternion)) state.calibrating = false;
  } else state.calibrating = true;
  updateMotionUI();
}

function manualLook() {
  if (nativeWalkingLocked()) return;
  if (state.orientation?.getStatus().enabled) state.calibrating = true;
  updateMotionUI();
}

function renderPlan(plan, { preserveDirection = false } = {}) {
  if (state.plan?.plan_id !== plan.plan_id) {
    cancelScaleCalibration();
    if (walkingLocked()) stopWalking('changed');
    if (!preserveDirection) { state.orientation?.stop(); stopTravelTracking(); state.panoramaPose = null; state.calibrating = false; }
  }
  state.plan = plan;
  $('plan-panel').hidden = false;
  const photograph = plan.input_kind === 'streetview_panorama';
  $('geometry-stats').hidden = photograph; $('geometry-edits').hidden = photograph;
  $('generation-description').textContent = photograph
    ? 'The Street View panorama is edited for the selected year, then World Labs generates a 3D world. Matching inputs and models reuse existing results. Visual detail, spatial completeness, and historical appearance need review after generation.'
    : 'Legacy geometry experiment: World Labs generates a historical panorama and 3D world from coarse depth. Model shapes and historical assumptions affect the result.';
  const modern = Array.isArray(plan.modern_buildings) ? plan.modern_buildings : [];
  const historical = Array.isArray(plan.historical_buildings) ? plan.historical_buildings : [];
  const changes = Array.isArray(plan.changes) ? plan.changes : [];
  $('modern-count').textContent = String(modern.length);
  $('removed-count').textContent = String(changes.filter((change) => change.action === 'remove').length);
  $('historic-count').textContent = String(historical.length);
  $('changes').replaceChildren();
  for (const change of changes) {
    const entry = document.createElement('div'); entry.className = 'change';
    const badge = document.createElement('span'); badge.className = `badge${change.action === 'remove' ? ' remove' : ''}`;
    badge.textContent = change.origin === 'user_edit'
      ? ({ add: 'Added · Unverified', remove: 'Removed · Unverified', replace: 'Replaced · Unverified', keep: 'Retained · Unverified' }[change.action] || 'User edit · Unverified')
      : ({ remove: 'Remove modern massing', remove_if_visible: 'Remove if visible', predates_target: 'Predates selected year', keep: 'Date supported by sources', unknown: 'Date unverified' }[change.action] || 'Unverified');
    const name = document.createElement('strong');
    name.textContent = text([...modern, ...historical].find((building) => building.id === change.building_id)?.label,
      text(change.name, text(change.building_id, 'Building')));
    const reason = document.createElement('p'); reason.textContent = changeReason(change);
    entry.append(badge, name, reason); $('changes').append(entry);
  }
  if (!changes.length) $('changes').textContent = photograph
    ? 'Generation uses real Street View photos. Building appearance and structural changes for the selected year still need archival verification.'
    : 'No building date changes can be verified individually; retained massing still needs review.';
  $('sources').replaceChildren();
  for (const source of Array.isArray(plan.sources) ? plan.sources : []) {
    const href = safeSourceURL(source.url);
    const item = document.createElement(href ? 'a' : 'p');
    item.textContent = text(source.title, text(source.id, 'Source'));
    if (href) { item.href = href; item.target = '_blank'; item.rel = 'noopener noreferrer'; }
    $('sources').append(item);
  }
  $('uncertainties').replaceChildren();
  for (const uncertainty of Array.isArray(plan.uncertainties) ? plan.uncertainties : []) {
    const item = document.createElement('li'); item.textContent = text(uncertainty); $('uncertainties').append(item);
  }
  const planLocation = plan.location || {};
  const coordinates = Number.isFinite(planLocation.lat) && Number.isFinite(planLocation.lon)
    ? `${planLocation.lat.toFixed(6)}, ${planLocation.lon.toFixed(6)}` : 'Coordinates not recorded';
  const provenance = planLocation.location_source || plan.location_source;
  $('plan-location').textContent = `${state.viewingSavedPlan ? 'Viewing saved result' : 'Current preview area'}: ${coordinates} · ${plan.target_year}.`
    + (provenance === 'test' ? ' This result uses a test location.' : '')
    + (state.viewingSavedPlan ? ' This is separate from your live phone location above. Preparing a new area refreshes your location.' : '');
  if (photograph && Number.isFinite(plan.source_panorama?.metadata?.distance_m)) {
    $('plan-location').textContent += ` The Street View camera is about ${Math.round(plan.source_panorama.metadata.distance_m)} m from the input location.`;
  }
  saveResume(); syncUI();
}

function renderLocationStatus() {
  const mode = state.locationMode;
  $('location-status').classList.toggle('error', !!state.locationError);
  if (mode === 'test') {
    $('location-status').textContent = 'Test mode enabled: only the specified coordinates will be used.';
    $('location-meta').textContent = 'Switch back to “Current location” to refresh your position.';
    return;
  }
  if (state.locationBusy) $('location-status').textContent = 'Requesting your current location. Please allow location access…';
  else if (state.locationError) $('location-status').textContent = state.locationError;
  else if (state.locationPermissionState === 'denied' && !state.locationFix) $('location-status').textContent = locationFailure({ code: 1 });
  else if (state.locationFix) $('location-status').textContent = state.locationFix.accuracy_m > 35
    ? 'Location updated. Waiting for a more accurate fix before updating Street View.' : 'Location is updating live. Street View refreshes as you move to a nearby block.';
  else $('location-status').textContent = 'Your location is not available yet. Allow location access and try again.';
  const fix = state.locationFix;
  $('location-meta').textContent = fix
    ? `Device accuracy ~${Math.round(fix.accuracy_m)} m · Updated ${Math.max(0, Math.round((Date.now() - fix.timestamp_ms) / 1000))} s ago (${new Date(fix.timestamp_ms).toLocaleTimeString('en-US')}).`
    : 'Without a location fix, CMU or previously saved coordinates will not be used.';
}

function locationFailure(error) {
  if (error?.code === 1) return 'Location permission denied or restricted. Restore access in website and system settings; retrying will not force the permission prompt to appear.';
  if (error?.code === 2) return 'Your device cannot determine its location. Move somewhere with a stronger signal and try again.';
  if (error?.code === 3) return 'Location request timed out. Try again; old coordinates or test locations will not be used.';
  return error?.message || 'Unable to get your location. Try again.';
}

function locationHelpSteps() {
  const userAgent = navigator.userAgent || '';
  const iphone = /iPhone|iPad|iPod/.test(userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/MicroMessenger/i.test(userAgent)) return [
    `You are using the WeChat browser. Copy the demo link, open it in ${iphone ? 'Safari' : 'a mobile browser such as Chrome'}, and allow location access.`,
    'To keep using the WeChat browser, also check its location permission in your phone settings.',
  ];
  if (iphone) return [
    'Safari: Page Menu → More → Website Settings → Location → Allow. In older Safari versions, tap aA → Website Settings.',
    'iPhone Settings → Privacy & Security → Location Services: turn on Location Services, set Safari Websites to “While Using the App”, and enable “Precise Location”.',
    'Return here and tap “Retry location”. For other iPhone browsers, also check their location access in system settings.',
  ];
  if (/Android/i.test(userAgent)) return [
    'Chrome: open site information in the address bar and allow location access under Permissions.',
    'Android Settings: turn on Location and allow Chrome (or your current browser) to access it while in use. Menu names vary by device.',
    'Return here and tap “Retry location”.',
  ];
  return [
    'Allow this site to access your location in browser site settings.',
    'Turn on Location Services in system settings and allow your browser to use your location. Then return here and retry.',
    'If you are using an in-app browser, copy the link and open it in Safari or Chrome.',
  ];
}

function renderLocationHelp() {
  const blocked = state.locationErrorCode === 1 || state.locationPermissionState === 'denied' && !state.locationFix;
  $('location-help').hidden = state.locationMode !== 'device' || !blocked;
  $('location-help-steps').replaceChildren();
  for (const instruction of locationHelpSteps()) {
    const item = document.createElement('li'); item.textContent = instruction; $('location-help-steps').append(item);
  }
  $('location-copy-note').textContent = validToken(state.token)
    ? 'The copied link includes access to this demo. Share it only with demo participants.'
    : 'Paste the copied link into your browser address bar. You may need to enter the access code again.';
}

function applyLocationPermission(permission, { recover = true } = {}) {
  const next = permission?.state;
  if (!['granted', 'denied', 'prompt'].includes(next)) return;
  const previous = state.locationPermissionState;
  state.locationPermissionState = next;
  if (next === 'granted' && previous !== 'granted' && state.locationErrorCode === 1) {
    state.locationRecoveryPending = true;
  }
  syncUI();
  if (recover) resumeLocationRecovery();
}

function resumeLocationRecovery() {
  if (!state.locationRecoveryPending || state.locationPermissionState !== 'granted'
      || state.locationMode !== 'device' || document.visibilityState !== 'visible'
      || state.locationBusy || state.planBusy || state.restoring) return;
  state.locationRecoveryPending = false;
  void refreshLocation().catch(() => {});
}

async function observeLocationPermission() {
  // Permissions is only a hint. Some Safari versions do not support this query,
  // and OS permission changes may not be reflected in its state immediately.
  if (state.locationPermissionQuery || state.locationPermissionStatus || !navigator.permissions?.query) return;
  state.locationPermissionQuery = true;
  try {
    const permission = await navigator.permissions.query({ name: 'geolocation' });
    state.locationPermissionStatus = permission;
    const handler = () => applyLocationPermission(permission);
    state.locationPermissionHandler = handler;
    if (permission.addEventListener) permission.addEventListener('change', handler);
    else permission.onchange = handler;
    applyLocationPermission(permission, { recover: false });
  } catch { /* Geolocation continues independently without Permissions API. */ }
  finally { state.locationPermissionQuery = false; }
}

async function retryLocation() {
  if (!state.plan && !state.job) state.autoPrepareAttempted = false;
  if (state.locationMode !== 'device') await setLocationMode('device');
  else { try { await refreshLocation(); } catch { /* The recovery guide remains beside the location inputs. */ } }
}

async function copyLocationLink() {
  if (state.locationLinkBusy) return;
  state.locationLinkBusy = true; $('location-copy-status').textContent = ''; syncUI();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    const link = new URL(location.pathname, location.origin);
    const job = new URLSearchParams(location.search).get('world');
    if (/^[a-f0-9]{32}$/.test(job || '')) link.searchParams.set('world', job);
    if (validToken(state.token)) link.hash = new URLSearchParams({ access: state.token }).toString();
    // The app access code exists only in memory and the user-triggered clipboard
    // write. It is never inserted into a visible link, input, attribute, or log.
    await navigator.clipboard.writeText(link.href);
    $('location-copy-status').textContent = 'Copied. Paste the link into the Safari or Chrome address bar.';
  } catch {
    $('location-copy-status').textContent = 'Clipboard access was blocked. Copy the page link from the browser share menu. Another browser may require the access code again.';
  } finally { state.locationLinkBusy = false; syncUI(); }
}

function acceptLiveFix(fix) {
  if (state.locationMode !== 'device' || state.locationFix?.timestamp_ms > fix.timestamp_ms) return;
  state.gpsWalking?.receiveFix(fix);
  state.locationFix = fix; state.locationError = ''; state.locationErrorCode = 0; state.locationBusy = false;
  $('lat').value = fix.lat.toFixed(6); $('lon').value = fix.lon.toFixed(6);
  syncUI();
}

function startLiveLocation() {
  if (state.locationMode !== 'device' || document.visibilityState === 'hidden' || !window.isSecureContext
      || state.locationErrorCode === 1 || !navigator.geolocation?.watchPosition) return;
  if (!state.liveLocation) state.liveLocation = createLiveLocation({ geolocation: navigator.geolocation,
    onFix: (fix) => { acceptLiveFix(fix); void maybePrepareCurrent(); },
    onError: (error) => {
      state.gpsWalking?.fail(error);
      state.locationError = locationFailure(error); state.locationErrorCode = Number(error.code) || 0;
      state.locationBusy = false; syncUI();
    },
  });
  state.liveLocation.start();
}

function stopLiveLocation() {
  state.liveLocation?.stop(); clearTimeout(state.liveTimer); state.liveTimer = null;
}

async function refreshLocation() {
  const epoch = ++state.locationEpoch;
  state.locationFix = null; state.locationError = ''; state.locationErrorCode = 0; state.locationBusy = true;
  state.locationRecoveryPending = false;
  if (state.locationMode === 'device') { $('lat').value = ''; $('lon').value = ''; }
  syncUI();
  try {
    if (!window.isSecureContext) throw new Error('Location access requires HTTPS. Open the page using the secure demo link.');
    if (!navigator.geolocation) throw new Error('This browser does not support location access. Use Safari or Chrome with location support.');
    // Start geolocation directly in the click's activation, before any await.
    // A pending or denied Permissions query never blocks an explicit retry.
    const pendingPosition = new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
    void observeLocationPermission();
    const position = await pendingPosition;
    if (epoch !== state.locationEpoch || state.locationMode !== 'device') throw new Error('Location mode changed; this location fix was ignored.');
    const fix = positionFix(position);
    acceptLiveFix(fix);
    return state.locationFix;
  } catch (error) {
    if (epoch === state.locationEpoch && state.locationMode === 'device') {
      state.locationError = locationFailure(error); state.locationErrorCode = Number(error?.code) || 0;
    }
    throw new Error(locationFailure(error));
  } finally {
    if (epoch === state.locationEpoch) { state.locationBusy = false; startLiveLocation(); syncUI(); void maybePrepareCurrent(); }
  }
}

async function setLocationMode(mode) {
  if (mode !== 'device' && mode !== 'test') return;
  if (gpsWalkingLocked()) stopWalking('changed');
  state.locationMode = mode; ++state.locationEpoch;
  stopTravelTracking(); stopLiveLocation(); state.liveAnchor = null; state.liveAttemptAt = 0; state.liveFailed = false;
  state.locationFix = null; state.locationError = ''; state.locationErrorCode = 0; state.locationBusy = false;
  state.locationRecoveryPending = false;
  $('lat').value = ''; $('lon').value = '';
  syncUI();
  if (mode === 'device') { try { await refreshLocation(); } catch { /* Visible location status provides retry. */ } }
}

async function resolveLocation() {
  if (state.locationMode === 'device') {
    const fix = await refreshLocation();
    return { lat: fix.lat, lon: fix.lon, location_source: 'device',
      location_accuracy_m: fix.accuracy_m, location_timestamp_ms: fix.timestamp_ms };
  }
  if (!$('lat').value.trim() || !$('lon').value.trim()) throw new Error('Enter latitude and longitude in test mode, or explicitly select the CMU test snapshot.');
  const lat = Number($('lat').value), lon = Number($('lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw new Error('Invalid test coordinates.');
  }
  return { lat, lon, location_source: 'test' };
}

async function openStreetView() {
  if (state.streetViewBusy) return;
  // Reserve the new tab in the click event before asynchronous geolocation.
  const target = window.open('about:blank', '_blank');
  if (!target) { message('The browser blocked the new page. Allow this site to open Google Street View.', true); return; }
  target.opener = null;
  state.streetViewBusy = true; syncUI();
  try {
    const coordinates = await resolveLocation();
    const url = new URL('https://www.google.com/maps/@');
    url.search = new URLSearchParams({ api: '1', map_action: 'pano', viewpoint: `${coordinates.lat},${coordinates.lon}` }).toString();
    target.location.replace(url.href);
  } catch (error) { target.close(); message(error.message, true); }
  finally { state.streetViewBusy = false; syncUI(); }
}

async function maybePrepareCurrent() {
  const fix = state.locationFix;
  if (!state.bootReady || state.planBusy || state.generateBusy || state.restoring || state.resumeBusy
      || state.submissionUnknown || walkingLocked() || state.scaleCalibration?.isActive() || !state.token || state.locationMode !== 'device'
      || document.visibilityState === 'hidden' || state.view !== 'source' || state.locationError
      || state.job && (state.job.stage || state.job.status) !== 'ready'
      || !fix || fix.accuracy_m > 35 || Date.now() - fix.timestamp_ms > 60000
      || !state.config?.streetview?.available || !state.plan && new URLSearchParams(location.search).has('world')) return;
  const anchor = state.liveAnchor || state.plan?.location;
  const threshold = Math.max(30, 1.5 * Math.max(anchor?.accuracy_m || 0, fix.accuracy_m));
  if (state.plan && !state.liveFailed && locationDistance(anchor, fix) < threshold) return;
  const remaining = (state.liveFailed ? 60000 : 15000) - (Date.now() - state.liveAttemptAt);
  if (remaining > 0) {
    if (state.liveTimer === null) state.liveTimer = setTimeout(() => {
      state.liveTimer = null; void maybePrepareCurrent();
    }, remaining);
    return;
  }
  clearTimeout(state.liveTimer); state.liveTimer = null;
  state.autoPrepareAttempted = true; state.liveAttemptAt = Date.now(); state.liveAnchor = { ...fix }; state.liveFailed = true;
  const prepared = await preparePlan('google_streetview', { reuseLocation: true, automatic: true });
  state.liveFailed = prepared !== true;
  if (prepared) void maybePrepareCurrent();
}

async function preparePlan(source = 'google_streetview', { reuseLocation = false, automatic = false } = {}) {
  if (state.planBusy || state.generateBusy || state.restoring
      || state.job && !TERMINAL.has(state.job.stage || state.job.status)) return;
  state.yearWheel?.commit();
  if (source !== 'google_streetview' && state.locationMode !== 'test') {
    message('Coarse map models and CMU snapshots are available only in explicit test mode.', true); return;
  }
  if (source === 'cmu_snapshot') {
    $('lat').value = String(state.config?.test_location?.lat ?? 40.4433);
    $('lon').value = String(state.config?.test_location?.lon ?? -79.9436);
  }
  const epoch = ++state.planEpoch, viewEpoch = state.viewEpoch, jobEpoch = state.jobEpoch, locationMode = state.locationMode;
  state.planBusy = true; syncUI();
  try {
    const fix = state.locationFix;
    const coordinates = reuseLocation && state.locationMode === 'device' && fix && Date.now() - fix.timestamp_ms < 60000
      ? { lat: fix.lat, lon: fix.lon, location_source: 'device', location_accuracy_m: fix.accuracy_m,
        location_timestamp_ms: fix.timestamp_ms } : await resolveLocation();
    if (epoch !== state.planEpoch) return;
    if (!$('plan-form').reportValidity()) return;
    const payload = { ...coordinates, year: Number($('year').value),
      radius_m: Number($('radius').value), heading_deg: 0, source };
    if (![payload.year, payload.radius_m].every(Number.isFinite)) return;
    message(source === 'google_streetview' ? 'Fetching the Google 360° Street View panorama for this location…'
      : source === 'cmu_snapshot' ? 'Reading the selected CMU map snapshot and generating coarse geometry…'
      : 'Loading map footprints and checking historical sources for this location. This may take a moment…');
    const plan = await api('/world-plans', { method: 'POST', body: payload });
    if (epoch !== state.planEpoch) return;
    if (automatic && (state.view !== 'source' || state.viewEpoch !== viewEpoch || state.jobEpoch !== jobEpoch
        || state.resumeBusy || state.generateBusy || state.submissionUnknown
        || state.job && (state.job.stage || state.job.status) !== 'ready'
        || walkingLocked() || state.scaleCalibration?.isActive()
        || state.locationMode !== locationMode || document.visibilityState === 'hidden')) { message(); return; }
    clearTimeout(state.pollTimer); ++state.jobEpoch;
    state.job = null; state.submissionUnknown = false; state.userViewLocked = false; state.viewingSavedPlan = false; setJobURL();
    state.liveAnchor = { lat: coordinates.lat, lon: coordinates.lon, accuracy_m: coordinates.location_accuracy_m || 0 };
    $('job-panel').hidden = true; renderPlan(plan, { preserveDirection: automatic });
    await showView(plan.input_kind === 'streetview_panorama' ? 'source' : 'historical', { automatic: true });
    revealMobilePreview();
    return true;
  } catch (error) {
    if (epoch === state.planEpoch) message(error.message, true);
  } finally {
    if (epoch === state.planEpoch) { state.planBusy = false; syncUI(); }
  }
}

async function generateForYear() {
  if (!state.plan || state.generateBusy || state.planBusy || state.submissionUnknown) return;
  state.yearWheel?.commit();
  if (!$('plan-form').reportValidity()) return;
  const selectedYear = Number($('year').value);
  const fix = state.locationFix, place = state.plan.location;
  const changedLocation = state.locationMode === 'device' && fix && Number.isFinite(place?.lat) && Number.isFinite(place?.lon)
    && fix.accuracy_m <= 35 && Date.now() - fix.timestamp_ms < 60000
    && locationDistance(place, fix) >= Math.max(30, 1.5 * fix.accuracy_m);
  if (state.plan.target_year !== selectedYear || changedLocation) {
    const prepared = await preparePlan('google_streetview');
    if (!prepared || state.plan?.target_year !== selectedYear || state.job) return;
  }
  await startGeneration();
}

function jobDetails(job) {
  const stage = job.stage || job.status;
  if (failedHistoricalReview(job)) return `Historical appearance failed review. ${reviewNotes(job)} Assets are saved for inspection; they are not an accurate reconstruction of this period.`;
  if (stage === 'submission_unknown') return 'The service has not confirmed the submission. Check accepted jobs before creating another paid generation.';
  if (stage === 'insufficient_credits') return 'The server has insufficient credits. Existing generated assets are still available.';
  if (stage === 'error') return `Job stopped${/^[a-z0-9_]{1,80}$/.test(job.error_code || '') ? ` (${job.error_code})` : ''}. Existing assets are saved.`;
  if (stage === 'paused') return 'The job is saved. This page continues checking status; the generation service handles recovery.';
  if (stage === 'ready') return 'Generated assets are saved. Historical accuracy, spatial alignment, and phone tracking remain unverified.';
  return state.plan?.input_kind === 'streetview_panorama'
    ? 'You can view the source Street View photo and completed historical panorama. Refreshing resumes this job without submitting a new generation.'
    : 'You can view geometry depth or completed panoramas. Refreshing resumes this job without submitting a new generation.';
}

async function importEdits(file) {
  if (!file || !state.plan || state.planBusy || state.generateBusy || state.restoring
      || state.job && !TERMINAL.has(state.job.stage || state.job.status)) return;
  if (file.size > 256 * 1024) { message('Historical edit files must be no larger than 256 KB.', true); return; }
  const epoch = ++state.planEpoch;
  const planId = state.plan.plan_id;
  state.planBusy = true; syncUI(); message('Validating historical geometry edits and their sources…');
  try {
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch { throw new Error('Unable to read the JSON edit file.'); }
    if (!Array.isArray(payload?.edits) || !payload.edits.length) throw new Error('The edit file must contain a nonempty edits array.');
    const plan = await api(`/world-plans/${planId}/edits`, { method: 'POST', body: payload });
    if (epoch !== state.planEpoch) return;
    clearTimeout(state.pollTimer); ++state.jobEpoch;
    state.job = null; state.submissionUnknown = false; state.userViewLocked = false; setJobURL();
    $('job-panel').hidden = true; renderPlan(plan);
    await showView('historical', { automatic: true });
    revealMobilePreview();
  } catch (error) { if (epoch === state.planEpoch) message(error.message, true); }
  finally {
    if ($('edits-file')) $('edits-file').value = '';
    if (epoch === state.planEpoch) { state.planBusy = false; syncUI(); }
  }
}

async function resumeJob() {
  if (!state.job?.can_resume || state.resumeBusy) return;
  state.resumeBusy = true; syncUI(); message('Resuming saved job…');
  try {
    const id = state.job.job_id || state.job.id;
    const job = await api(`/world-jobs/${id}/resume`, { method: 'POST' });
    applyJob(job); schedulePoll(++state.jobEpoch); message();
  } catch (error) { message(error.message, true); }
  finally { state.resumeBusy = false; syncUI(); }
}

function applyJob(job) {
  const previousPano = assetFor('pano');
  const previousWorld = assetFor('world');
  state.job = job; saveResume(); setJobURL(job.job_id || job.id);
  const stage = job.stage || job.status;
  $('job-panel').hidden = false;
  $('job-stage').textContent = failedHistoricalReview(job) ? 'Historical appearance failed review · Assets available' : STAGES[stage] || 'Waiting for service status';
  const elapsed = job.timing_s?.total_to_assets;
  $('job-detail').textContent = jobDetails(job)
    + (Number.isFinite(elapsed) ? ` Assets ready ${elapsed.toFixed(1)} s after job creation.` : '');
  $('job-quality').textContent = worldQualityLabel(job);
  const costs = job.cost_credits || {};
  const credit = (value) => Number.isFinite(value) ? `${value} credits` : 'Not reported';
  const photoInput = state.plan?.input_kind === 'streetview_panorama' || !!job.generation_calls?.image_edit;
  $('cost').textContent = photoInput
    ? `OpenAI image editing billed separately · World Labs world: ${credit(costs.world)} · World Labs total: ${credit(costs.total)}`
    : `Panorama: ${credit(costs.depth)} · World: ${credit(costs.world)} · Total: ${credit(costs.total)}`;
  $('job-assets').replaceChildren();
  if (job.can_resume) {
    const resume = document.createElement('button'); resume.type = 'button';
    resume.textContent = 'Resume saved job'; resume.disabled = state.resumeBusy;
    resume.addEventListener('click', () => { void resumeJob(); }); $('job-assets').append(resume);
  }
  if (assetFor('depth_preview')) {
    const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = 'View geometry panorama';
    preview.addEventListener('click', () => { void showView('depth_preview'); }); $('job-assets').append(preview);
  }
  for (const asset of Array.isArray(job.assets) ? job.assets : []) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `Download ${text(asset.filename, 'asset')}`;
    button.addEventListener('click', () => downloadAsset(asset, button));
    $('job-assets').append(button);
  }
  syncUI(); applyReviewNotice();
  if (!state.userViewLocked && document.visibilityState !== 'hidden') {
    if (!previousWorld && assetFor('world')) void showView('world', { automatic: true });
    else if (!previousPano && assetFor('pano')) void showView('pano', { automatic: true });
  }
}

async function startGeneration() {
  if (!state.plan || state.generateBusy || state.job || state.submissionUnknown || !state.config?.configured || !modelProfile()) return;
  state.generateBusy = true; syncUI(); message(`Creating a historical panorama and ${modelProfile().label} world…`);
  try {
    const job = await api('/world-jobs', { method: 'POST', body: { plan_id: state.plan.plan_id, model: state.model } });
    applyJob(job); message(); schedulePoll(++state.jobEpoch);
    if (!state.userViewLocked && !assetFor('pano') && !assetFor('world') && assetFor('depth_preview')) {
      void showView('depth_preview', { automatic: true });
    }
  } catch (error) {
    if (error.status === 0) { state.submissionUnknown = true; saveResume(); }
    message(error.message, true);
  } finally { state.generateBusy = false; syncUI(); }
}

function schedulePoll(epoch) {
  clearTimeout(state.pollTimer);
  if (epoch !== state.jobEpoch || !state.job || TERMINAL.has(state.job.stage || state.job.status) || !state.token) return;
  state.pollTimer = setTimeout(() => { void pollJob(epoch); }, 5000);
}
async function pollJob(epoch) {
  if (epoch !== state.jobEpoch || !state.job) return;
  const id = state.job.job_id || state.job.id;
  try {
    const job = await api(`/world-jobs/${id}`);
    if (epoch !== state.jobEpoch) return;
    applyJob(job);
  } catch (error) {
    if (epoch !== state.jobEpoch) return;
    message(error.message, true);
  } finally { schedulePoll(epoch); }
}

async function downloadAsset(asset, button) {
  button.disabled = true;
  let objectURL;
  try {
    const blob = await api(safeAssetURL(asset.url), { format: 'blob' });
    objectURL = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = objectURL;
    anchor.download = /^[A-Za-z0-9_.-]+$/.test(asset.filename || '') ? asset.filename : 'world-asset';
    document.body.append(anchor); anchor.click(); anchor.remove();
    // Allow the browser's download handoff before revoking the authenticated blob.
    setTimeout(() => URL.revokeObjectURL(objectURL), 30000);
  } catch (error) { if (objectURL) URL.revokeObjectURL(objectURL); message(error.message, true); }
  finally { button.disabled = false; }
}

function disposeObject(object) {
  if (!object) return;
  object.traverse((child) => {
    if (child instanceof SplatMesh) child.dispose();
    else {
      child.geometry?.dispose();
      for (const material of Array.isArray(child.material) ? child.material : child.material ? [child.material] : []) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    }
  });
}

function ensureEngine() {
  if (state.engine) return state.engine;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', '360° viewer. Drag or use arrow keys to look around');
  renderer.domElement.tabIndex = 0;
  $('viewport').append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe5e8df);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7869, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(80, 120, 60); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(65, 2, 0.05, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.1; controls.maxDistance = 600;
  controls.addEventListener('start', manualLook);
  const spark = new SparkRenderer({ renderer }); scene.add(spark);
  const helpers = new THREE.Group();
  helpers.add(new THREE.AxesHelper(8));
  const grid = new THREE.GridHelper(120, 24, 0x778578, 0xc3cabb); grid.position.y = 0.02;
  helpers.add(grid); scene.add(helpers);
  const engine = { renderer, scene, camera, controls, spark, helpers, current: null, home: null, metric: false, previousTime: 0 };
  engine.look = new PanoramaLookControls(camera, renderer.domElement, { onManualInteraction: manualLook, onChange: updateMotionUI });
  state.engine = engine;
  const resize = () => {
    const width = Math.max(1, $('viewport').clientWidth), height = Math.max(1, $('viewport').clientHeight);
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
  };
  engine.observer = new ResizeObserver(resize); engine.observer.observe($('viewport')); resize();
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); message('The 3D graphics context was lost. Refresh to recover; saved jobs will not be regenerated.', true);
  });
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - engine.previousTime) / 1000 || 0); engine.previousTime = now;
    if (renderer.domElement.hidden || document.visibilityState === 'hidden') return;
    if (!applyNativeWalking(engine)) {
      const panorama = isPanorama(), gps = applyGPSWalking(engine, dt);
      engine.look.enabled = panorama || gps;
      const orientation = !state.calibrating && canFollowView() ? state.orientation?.getQuaternion() : null;
      controls.enabled = !panorama && !gps && !orientation;
      if (panorama) camera.position.set(0, 0, 0);
      else if (!gps) moveCamera(engine, dt);
      if (orientation) {
        camera.quaternion.slerp(orientation, 1 - Math.exp(-14 * dt));
        controls.target.copy(camera.position).add(new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion));
      } else if (!panorama && !gps) controls.update();
    }
    if (now - state.motionFrameAt > 250) { state.motionFrameAt = now; updateMotionUI(); }
    try { renderer.render(scene, camera); }
    catch { message('This device cannot render the current 3D asset. Panoramas and downloads are still available.', true); renderer.setAnimationLoop(null); }
  });
  return engine;
}

function moveCamera(engine, dt) {
  if (isPanorama() || walkingLocked() || state.scaleCalibration?.isActive()) return;
  const active = new Set([...state.keys, ...state.touchMoves]);
  if (!active.size || !engine.current) return;
  const forward = new THREE.Vector3(); engine.camera.getWorldDirection(forward);
  forward.y = 0; if (forward.lengthSq() < 0.001) forward.set(0, 0, -1); forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const delta = new THREE.Vector3();
  if (active.has('forward')) delta.add(forward);
  if (active.has('back')) delta.sub(forward);
  if (active.has('right')) delta.add(right);
  if (active.has('left')) delta.sub(right);
  if (delta.lengthSq()) {
    delta.normalize().multiplyScalar(dt * (state.view === 'world' ? 1.5 : 12));
    engine.camera.position.add(delta); engine.controls.target.add(delta);
  }
}

function fitCoarse(engine, object, view) {
  const bounds = new THREE.Box3();
  // Use one frame for the before/after comparison, including imported additions.
  // Fitting the surviving historical buildings alone hides the scale of removals.
  const buildings = [...(state.plan?.modern_buildings || []), ...(state.plan?.historical_buildings || [])];
  for (const building of buildings) {
    if (!Number.isFinite(building.height_m)) continue;
    for (const point of Array.isArray(building.footprint) ? building.footprint : []) {
      if (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) {
        bounds.expandByPoint(new THREE.Vector3(point[0], 0, point[1]));
        bounds.expandByPoint(new THREE.Vector3(point[0], building.height_m, point[1]));
      }
    }
  }
  if (bounds.isEmpty()) object.traverse((child) => {
    if (child.isMesh && child.name !== 'Ground' && child.userData.kind !== 'ground') bounds.expandByObject(child);
  });
  if (bounds.isEmpty()) {
    const origin = state.plan?.camera_position || [0, 1.6, 0];
    bounds.set(new THREE.Vector3(origin[0] - 15, 0, origin[2] - 15), new THREE.Vector3(origin[0] + 15, 8, origin[2] + 15));
  }
  const centre = bounds.getCenter(new THREE.Vector3());
  const span = Math.max(20, bounds.getSize(new THREE.Vector3()).length());
  engine.controls.target.copy(centre);
  engine.camera.position.copy(centre).add(new THREE.Vector3(0.7, 0.75, 0.95).normalize().multiplyScalar(span * 1.1));
  engine.controls.minDistance = 0.5; engine.controls.maxDistance = Math.max(300, span * 5);
  engine.helpers.visible = true; engine.metric = true;
  engine.home = { position: engine.camera.position.clone(), target: centre.clone() };
  engine.controls.update();
  const count = state.plan?.[view === 'modern' ? 'modern_buildings' : 'historical_buildings']?.length;
  $('view-caption').textContent = `${view === 'modern' ? 'Modern' : `${state.plan?.target_year || ''} historical`} massing${Number.isInteger(count) ? ` · ${count} buildings` : ''} · Red east / Green up / Blue south`;
  $('viewer-note').textContent = 'Coarse map model · Test only';
  $('view-details').textContent = 'Simplified massing and flat ground, in meters. Drag to rotate and pinch to zoom. WASD or arrow buttons move the virtual camera only.';
}

function semanticsTransform(asset) {
  const metadata = asset?.semantics_metadata;
  const scale = metadata?.metric_scale_factor, offset = metadata?.ground_plane_offset;
  const verified = typeof scale === 'number' && Number.isFinite(scale) && scale > 0
    && typeof offset === 'number' && Number.isFinite(offset);
  return verified ? { scale, offset, metric: true } : { scale: 1, offset: 0, metric: false };
}

async function showView(view, { automatic = false } = {}) {
  const asset = assetFor(view);
  if (!asset) return;
  cancelScaleCalibration();
  if (walkingLocked()) stopWalking('changed');
  if (view === 'world' && state.walkScaleWorldKey !== asset.url) {
    $('walk-scale').value = ''; state.walkScaleReference = null; state.walkScaleWorldKey = asset.url;
  }
  if (isPanorama() && state.engine?.current) {
    state.panoramaPose = { planId: state.plan?.plan_id, quaternion: state.engine.camera.quaternion.clone() };
  }
  if (!(isPanorama() && isPanorama(view)) && state.view !== view) {
    state.orientation?.stop(); stopTravelTracking(); state.calibrating = false;
  }
  if (!automatic) state.userViewLocked = true;
  const epoch = ++state.viewEpoch; state.viewAbort?.abort();
  const controller = new AbortController(); state.viewAbort = controller; state.view = view;
  state.keys.clear(); state.touchMoves.clear(); syncUI(); message('Loading preview…');
  $('empty').hidden = true; $('flat-preview').hidden = true; $('move-pad').hidden = true;
  if (state.imageURL) { URL.revokeObjectURL(state.imageURL); state.imageURL = null; $('flat-preview').removeAttribute('src'); }
  if (state.engine) {
    state.engine.renderer.domElement.hidden = true;
    state.engine.current?.removeFromParent(); disposeObject(state.engine.current); state.engine.current = null;
  }
  let pendingObject = null, pendingURL = null;
  try {
    const url = safeAssetURL(asset.url);
    if (isPanorama(view)) {
      const blob = await api(url, { format: 'blob', signal: controller.signal });
      if (epoch !== state.viewEpoch) return;
      pendingURL = URL.createObjectURL(blob);
      const photograph = document.createElement('img'); photograph.src = pendingURL;
      await photograph.decode();
      if (epoch !== state.viewEpoch) return;
      const sourceMetadata = state.plan?.source_panorama?.metadata || {};
      const engine = ensureEngine();
      pendingObject = createPanoramaMesh(photograph, sourceMetadata);
      engine.camera.position.set(0, 0, 0); engine.camera.fov = 65; engine.camera.updateProjectionMatrix();
      if (state.panoramaPose?.planId === state.plan?.plan_id) engine.camera.quaternion.copy(state.panoramaPose.quaternion);
      else setCameraBearing(engine.camera, panoramaHeading(sourceMetadata));
      engine.controls.enabled = false; engine.look && (engine.look.enabled = true);
      engine.helpers.visible = false; if (engine.spark) engine.spark.visible = false;
      engine.home = { position: engine.camera.position.clone(), quaternion: engine.camera.quaternion.clone(),
        target: new THREE.Vector3(0, 0, -1).applyQuaternion(engine.camera.quaternion) };
      engine.current = pendingObject; pendingObject = null; engine.scene.add(engine.current);
      engine.renderer.domElement.hidden = false;
      state.imageURL = pendingURL; pendingURL = null;
      $('view-caption').textContent = view === 'source' ? 'Street View' : `${state.plan?.target_year || ''} · Reimagined panorama`;
      const distance = sourceMetadata.distance_m;
      const offset = Number.isFinite(distance) ? `The Street View camera is about ${Math.round(distance)} m from your location when the scene was prepared. ` : '';
      $('viewer-note').textContent = view === 'source' ? 'Drag to look around · Enable motion to follow your phone' : 'Reimagined history · Turn your phone to look around';
      $('view-details').textContent = view === 'source'
        ? `Google Street View · ${text(sourceMetadata.copyright)} · Captured: ${text(sourceMetadata.date, 'Not provided')}. This is a panoramic photograph. ${offset}Heading is estimated from Street View metadata; sensors and landmarks can help align it.`
        : `Historical and current panoramas retain the same viewing direction. ${offset}Historical edits may alter projection or landmarks, so alignment needs comparison on site. Panorama viewing does not produce parallax as you walk.`;
      $('scene-attribution').textContent = view === 'source'
        ? `${text(sourceMetadata.copyright, 'Google Street View')} · ${text(sourceMetadata.date, 'Capture date unknown')}`
        : `Reimagined history · ${text(sourceMetadata.copyright, 'Source: Street View photo')}`;
    } else if (view === 'depth' || view === 'depth_preview') {
      const blob = await api(url, { format: 'blob', signal: controller.signal });
      if (epoch !== state.viewEpoch) return;
      state.imageURL = URL.createObjectURL(blob); $('flat-preview').src = state.imageURL;
      await $('flat-preview').decode();
      if (epoch !== state.viewEpoch) return;
      $('flat-preview').hidden = false;
      $('flat-preview').alt = 'Diagnostic depth panorama of historical massing';
      $('view-caption').textContent = view === 'depth_preview' ? 'Historical geometry panorama · Diagnostic preview' : '360° radial depth';
      $('viewer-note').textContent = 'Depth panoramas are for inspecting coarse geometry only.';
      $('view-details').textContent = $('viewer-note').textContent;
      $('scene-attribution').textContent = '';
    } else {
      const engine = ensureEngine();
      engine.controls.enabled = true; if (engine.look) engine.look.enabled = false;
      if (engine.spark) engine.spark.visible = view === 'world';
      const bytes = await api(url, { format: 'bytes', signal: controller.signal });
      if (epoch !== state.viewEpoch) return;
      if (view === 'world') {
        const splat = new SplatMesh({ fileBytes: new Uint8Array(bytes), fileType: 'spz' });
        pendingObject = splat;
        await splat.initialized;
        if (epoch !== state.viewEpoch) { disposeObject(splat); return; }
        const transform = semanticsTransform(asset);
        // Official order: raw centres*s - ground offset, then renderer axes.
        // Parent X180 also rotates the offset; applying -offset after X180 is incorrect.
        const axes = new THREE.Group(); axes.rotation.x = Math.PI;
        splat.scale.setScalar(transform.scale); splat.position.y = -transform.offset; axes.add(splat);
        pendingObject = axes; engine.metric = transform.metric; engine.helpers.visible = false;
        engine.camera.position.set(0, transform.metric ? transform.offset : 0, 0);
        engine.controls.target.copy(engine.camera.position).add(new THREE.Vector3(0, 0, -1));
        engine.controls.minDistance = 0.05; engine.controls.maxDistance = 500;
        engine.home = { position: engine.camera.position.clone(), target: engine.controls.target.clone() };
        $('view-caption').textContent = `${state.plan?.target_year || ''} · Generated world`;
        $('view-details').textContent = transform.metric ? 'Generated world · Provider metric scale and ground offset applied'
          : 'Generated world · Model units; scale and ground unverified';
        $('view-details').textContent += ` · ${worldQualityLabel(state.job, asset)}\nReal SPZ asset. Drag to look around or use arrow buttons to move virtually. ${getWalkingController().available()
          ? 'Calibrate scale and enable AR tracking in settings. ' : 'Calibrate scale and heading in settings to enable approximate GPS walking. '}Source camera position, geographic heading, and phone alignment remain unverified and need calibration on site. The scene has no collision protection.`;
        $('viewer-note').textContent = 'Reimagined history · Align heading manually';
        $('scene-attribution').textContent = 'AI-generated world · Reimagined history';
      } else {
        const model = await new GLTFLoader().parseAsync(bytes, ''); pendingObject = model.scene;
        if (epoch !== state.viewEpoch) { disposeObject(pendingObject); return; }
        fitCoarse(engine, pendingObject, view);
        $('scene-attribution').textContent = 'Coarse map model · Experiment';
      }
      engine.current = pendingObject; pendingObject = null;
      engine.scene.add(engine.current); engine.renderer.domElement.hidden = false; engine.controls.update();
      $('move-pad').hidden = false;
    }
    if (epoch === state.viewEpoch) { applyReviewNotice(); updateMotionUI(); message(); }
  } catch (error) {
    disposeObject(pendingObject);
    if (epoch !== state.viewEpoch || error.name === 'AbortError') return;
    state.orientation?.stop(); stopTravelTracking(); state.calibrating = false;
    $('view-caption').textContent = 'Preview unavailable';
    message(error instanceof RequestError ? error.message : 'Unable to display this asset. Choose another preview or download the original file.', true);
    updateMotionUI();
  } finally {
    if (pendingURL) URL.revokeObjectURL(pendingURL);
  }
}

function canRequestLocalSession(hostname) {
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.some((part) => part > 255)) return false;
  return octets[0] === 10 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
    || octets[0] === 192 && octets[1] === 168;
}

async function initialiseAccess() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const supplied = fragment.get('access');
  if (fragment.has('access')) {
    fragment.delete('access');
    history.replaceState(null, '', `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ''}`);
  }
  const saved = supplied ?? storageGet(TOKEN_KEY);
  if (validToken(saved)) {
    state.token = saved;
    try { await verifyAccess(); return; } catch { state.token = ''; storageSet(TOKEN_KEY, null); }
  }
  if (canRequestLocalSession(location.hostname) || new URLSearchParams(location.search).get('viewer') === '1') {
    try {
      const session = await api('/world-session', { auth: false });
      if (validToken(session.access_token)) { state.token = session.access_token; connected(); return; }
    } catch { /* Only an explicitly enabled gateway supplies a demo session. */ }
  }
  $('access-panel').hidden = false; $('connection').textContent = 'Access code required'; syncUI();
  message('Open settings at the top right and enter the access code to connect.');
}

function connected() {
  storageSet(TOKEN_KEY, state.token); $('access').value = '';
  $('access-panel').hidden = true; $('connection').textContent = 'Service connected'; syncUI();
}
async function verifyAccess() {
  // A protected, nonexistent plan distinguishes accepted credentials from HTTP401.
  try { await api('/world-plans/00000000-0000-0000-0000-000000000000'); }
  catch (error) { if (error.status !== 404) throw error; }
  connected();
}

async function restoreSaved() {
  if (!state.token) return;
  let saved;
  try { saved = JSON.parse(storageGet(RESUME_KEY) || 'null'); } catch { saved = null; }
  const query = new URLSearchParams(location.search);
  if (query.has('world')) {
    const requested = query.get('world');
    if (!/^[a-f0-9]{32}$/.test(requested || '')) { message('Invalid world job link.', true); return; }
    // Explicit links take priority over a different locally saved task.
    saved = { job_id: requested, plan_id: saved?.job_id === requested ? saved.plan_id : null };
  }
  if (!saved || (!saved.plan_id && !saved.job_id)) return;
  const epoch = ++state.planEpoch; state.restoring = true; syncUI(); message('Loading the saved area and world job…');
  try {
    const job = /^[a-f0-9]{32}$/.test(saved.job_id || '') ? await api(`/world-jobs/${saved.job_id}`) : null;
    if (epoch !== state.planEpoch) return;
    const planId = job?.plan_id || saved.plan_id;
    if (/^[a-f0-9-]{36}$/.test(planId || '')) {
      const plan = await api(`/world-plans/${planId}`);
      if (epoch !== state.planEpoch) return;
      state.viewingSavedPlan = true; renderPlan(plan);
    }
    state.submissionUnknown = saved.submission_unknown === true && !job;
    if (job) { applyJob(job); schedulePoll(++state.jobEpoch); }
    if (!assetFor('world') && !assetFor('pano')) {
      const preview = availableView('source') ? 'source' : 'historical';
      if (availableView(preview)) await showView(preview, { automatic: true });
    }
    if (state.submissionUnknown) message('The last submission is unconfirmed. Check server jobs; this page will not resubmit automatically.', true);
    else if (!availableView(state.view)) message();
  } catch (error) { if (epoch === state.planEpoch) message(error.message, true); }
  finally { if (epoch === state.planEpoch) { state.restoring = false; syncUI(); } }
}

function bindEvents() {
  state.yearWheel = createYearWheel({ element: $('year-wheel'), input: $('year'), onChange: syncUI });
  $('settings-open').addEventListener('click', () => { cancelScaleCalibration(); openSettings(); });
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-dialog').addEventListener('click', (event) => {
    if (event.target === $('settings-dialog')) closeSettings();
  });
  $('motion-toggle').addEventListener('click', toggleMotion);
  $('walk-start').addEventListener('click', startWalking);
  $('walk-reanchor').addEventListener('click', startWalking);
  $('walk-stop').addEventListener('click', () => stopWalking());
  $('walk-scale').addEventListener('input', () => { state.walkNotice = ''; state.walkScaleReference = null; updateWalkingUI(); });
  $('walk-heading').addEventListener('input', () => { state.walkNotice = ''; updateWalkingUI(); });
  $('walk-mode').addEventListener('change', () => { stopWalking(); updateWalkingUI(); });
  $('walk-measure').addEventListener('click', startScaleCalibration);
  $('align-view').addEventListener('click', calibrateView);
  $('year').addEventListener('input', syncUI);
  $('plan-form').addEventListener('submit', (event) => { event.preventDefault(); });
  $('test-prepare').addEventListener('click', () => { if (state.locationMode === 'test') void preparePlan('google_streetview'); });
  $('geometry-test').addEventListener('click', () => { void preparePlan('osm'); });
  $('open-streetview').addEventListener('click', openStreetView);
  $('snapshot')?.addEventListener('click', () => { void preparePlan('cmu_snapshot'); });
  $('edits-file')?.addEventListener('change', (event) => { void importEdits(event.target.files?.[0]); });
  $('generate').addEventListener('click', () => { void generateForYear(); });
  $('world-model').addEventListener('change', (event) => {
    if (state.job || state.generateBusy || state.submissionUnknown || !modelProfile(event.target.value)) return;
    state.model = event.target.value; syncUI();
  });
  $('connect').addEventListener('click', async () => {
    const token = $('access').value.trim();
    if (!validToken(token)) { message('Enter a valid access code.', true); return; }
    $('connect').disabled = true; state.token = token;
    try { await verifyAccess(); message(); await restoreSaved(); await maybePrepareCurrent(); closeSettings(); }
    catch (error) { state.token = ''; storageSet(TOKEN_KEY, null); message(error.message, true); syncUI(); }
    finally { $('connect').disabled = false; }
  });
  $('location-mode').addEventListener('change', (event) => setLocationMode(event.target.value));
  $('gps').addEventListener('click', retryLocation);
  $('retry-location').addEventListener('click', retryLocation);
  $('copy-location-link').addEventListener('click', copyLocationLink);
  const revisitLocationPermission = () => {
    if (document.visibilityState !== 'visible') { stopLiveLocation(); return; }
    // Re-read the live PermissionStatus when Safari resumes from Settings;
    // the browser may defer its change event while the page is backgrounded.
    if (state.locationPermissionStatus) applyLocationPermission(state.locationPermissionStatus);
    else void observeLocationPermission();
    resumeLocationRecovery();
    startLiveLocation(); void maybePrepareCurrent();
  };
  window.addEventListener('focus', revisitLocationPermission);
  document.addEventListener('visibilitychange', revisitLocationPermission);
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', async () => { await showView(button.dataset.view); await maybePrepareCurrent(); });
  }
  $('reset-view').addEventListener('click', () => {
    const engine = state.engine;
    if (!engine?.home || engine.renderer.domElement.hidden || walkingLocked()) return;
    state.orientation?.stop(); stopTravelTracking(); state.calibrating = false;
    engine.camera.position.copy(engine.home.position); engine.controls.target.copy(engine.home.target);
    if (isPanorama() && engine.home.quaternion) engine.camera.quaternion.copy(engine.home.quaternion);
    else engine.controls.update();
    engine.camera.fov = 65; engine.camera.updateProjectionMatrix(); updateMotionUI();
  });
  const moveKeys = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right' };
  window.addEventListener('keydown', (event) => {
    if (walkingLocked() || state.scaleCalibration?.isActive()) return;
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    const move = moveKeys[event.code];
    if (move && state.engine && !state.engine.renderer.domElement.hidden) { event.preventDefault(); state.keys.add(move); }
  });
  window.addEventListener('keyup', (event) => state.keys.delete(moveKeys[event.code]));
  const releaseMoves = () => {
    state.keys.clear(); state.touchMoves.clear(); state.engine?.look?.pointers.clear();
    if (document.visibilityState === 'hidden') cancelScaleCalibration();
  };
  window.addEventListener('blur', releaseMoves); document.addEventListener('visibilitychange', releaseMoves);
  for (const button of document.querySelectorAll('[data-move]')) {
    button.addEventListener('pointerdown', (event) => {
      if (walkingLocked() || state.scaleCalibration?.isActive()) return;
      event.preventDefault(); button.setPointerCapture(event.pointerId); state.touchMoves.add(button.dataset.move);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(name, () => state.touchMoves.delete(button.dataset.move));
    }
  }
  window.addEventListener('pagehide', (event) => {
    clearTimeout(state.pollTimer); state.pollTimer = null; ++state.jobEpoch;
    state.viewAbort?.abort(); releaseMoves();
    stopLiveLocation();
    cancelScaleCalibration();
    state.orientation?.stop('paused'); stopTravelTracking();
    // A back/forward-cache entry retains this JS state and its live canvas.
    // Keep rendering resources and controls so browser Back can resume them.
    if (event.persisted) return;
    state.orientation?.dispose(); state.walking?.dispose(); state.gpsWalking?.dispose(); state.yearWheel?.dispose();
    if (state.imageURL) URL.revokeObjectURL(state.imageURL);
    if (state.engine) { state.engine.renderer.setAnimationLoop(null); state.engine.observer.disconnect(); state.engine.look?.dispose(); }
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    startLiveLocation(); void maybePrepareCurrent();
    if (state.engine) state.engine.previousTime = 0;
    schedulePoll(state.jobEpoch);
    // An asset fetch may have been interrupted during navigation.
    if (availableView(state.view) && !state.engine?.current && !['depth', 'depth_preview'].includes(state.view)) {
      void showView(state.view, { automatic: true });
    }
    updateMotionUI();
  });
}

async function boot() {
  bindEvents(); syncUI();
  const locationReady = refreshLocation().catch(() => {});
  const results = await Promise.allSettled([
    api('/world-config', { auth: false }).then((config) => {
      state.config = config;
      configureModels();
      if (Number.isInteger(config.min_year)) $('year').min = String(config.min_year);
      if (Number.isInteger(config.max_year)) $('year').max = String(config.max_year);
      state.yearWheel?.setRange(Number($('year').min) || 1800, Number($('year').max) || new Date().getFullYear());
      syncUI();
    }), initialiseAccess(),
  ]);
  if (results[0].status === 'rejected') message('Unable to read service configuration. Check that the service is running.', true);
  else if (!state.config.configured && !state.config.viewer_only) message('World Labs is not configured on the server. You can prepare and inspect coarse geometry.');
  await restoreSaved();
  state.bootReady = true;
  await locationReady;
  await maybePrepareCurrent();
}

void boot();
