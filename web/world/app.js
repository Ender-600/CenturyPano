import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'century.world.access';
const RESUME_KEY = 'century.world.resume';
const TERMINAL = new Set(['ready', 'error', 'submission_unknown', 'insufficient_credits']);
const STAGES = {
  queued: '世界任务已排队', rendering_depth: '正在渲染历史几何深度',
  submitting_depth: '正在提交深度全景', generating_depth: '正在生成历史全景',
  submitting_image_edit: '正在提交历史全景改写', editing_panorama: '正在改写历史全景',
  fetching_pano: '正在保存历史全景', pano_ready: '历史全景已就绪',
  submitting_world: '正在提交三维世界', generating_world: '正在生成 Draft 三维世界',
  fetching_assets: '正在下载并检查世界资产', ready: '世界资产已就绪',
  paused: '服务暂时暂停，等待恢复', error: '生成停止',
  submission_unknown: '提交结果尚未确认', insufficient_credits: '服务器积分不足',
};
const STANDARD_REASONS = new Map([
  ['No bound archival date or target-year footprint. Retained only as an unverified modern massing placeholder.',
    '缺少对应年代的档案与轮廓，暂留现代体块，历史形态未核实。'],
  ['Documented construction phases span multiple years; modern footprint does not identify each phase. No whole-building deletion is justified.',
    '建筑分期建设，现代轮廓无法区分各期，不能据此整栋移除。'],
  ['Documented completion predates the reference year; retained modern outline and height still require historical-shape verification.',
    '完工时间早于目标年份；保留的现代轮廓和高度仍需核实。'],
  ['Reference year overlaps a completion/opening year; exact date and construction geometry require review.',
    '目标年份与完工或启用年份重合，具体日期及当时形态待核实。'],
]);
const state = {
  token: '', config: null, plan: null, job: null, planBusy: false, generateBusy: false,
  restoring: false, resumeBusy: false, submissionUnknown: false, planEpoch: 0, jobEpoch: 0, viewEpoch: 0,
  pollTimer: null, view: 'source', viewAbort: null, userViewLocked: false,
  imageURL: null, engine: null, keys: new Set(), touchMoves: new Set(),
  locationMode: 'device', locationFix: null, locationEpoch: 0, locationBusy: false, locationError: '',
  viewingSavedPlan: false, streetViewBusy: false,
};

function storageGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) {
  try { value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* Optional persistence. */ }
}
function text(value, fallback = '') { return typeof value === 'string' ? value : fallback; }
function changeReason(change) {
  const reason = text(change.reason, '该位置的历史形态尚未核实。');
  if (change.origin === 'user_edit' || change.evidence_basis === 'user_supplied_unverified') return reason;
  if (STANDARD_REASONS.has(reason)) return STANDARD_REASONS.get(reason);
  const removal = /^Official CMU completion\/opening evidence postdates (\d{4})\. Remove the completed modern building; earlier structures and construction-stage geometry remain unknown\.$/.exec(reason);
  return removal ? `CMU 官方资料显示该建筑在 ${removal[1]} 年后完工或启用，因此移除现代体块；更早建筑与施工状态仍未知。` : reason;
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
  const suffix = ' · 历史外观未通过检查';
  if (!$('view-caption').textContent.endsWith(suffix)) $('view-caption').textContent += suffix;
  const base = $('viewer-note').textContent.split('\n历史外观未通过检查：')[0];
  $('viewer-note').textContent = `${base}\n历史外观未通过检查：${reviewNotes() || '生成外观与目标年代或地点不符。'} 资产可供核查，不能视为该年代的准确还原。`;
}
function message(value = '', error = false) {
  $('message').textContent = value;
  $('message').classList.toggle('error', error);
}
function validToken(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value); }
function safeAssetURL(value) {
  if (typeof value !== 'string' || !/^\/world-(?:plans|jobs)\/[a-f0-9-]{16,64}\/assets\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('资产地址无效；仅接受当前生成服务保存的文件。');
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
    throw new RequestError(0, '服务地址无效。');
  }
  if (auth && !state.token) throw new RequestError(401, '请先输入访问码并连接生成服务。');
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
        $('access-panel').hidden = false; $('connection').textContent = '需要访问码';
        syncUI();
      }
      let detail = '';
      try { detail = text((await response.json()).detail); } catch { /* No raw response bodies. */ }
      if (!detail || detail.length > 300 || /https?:\/\/|bearer|api.key/i.test(detail)) {
        detail = `请求未完成（HTTP ${response.status}）。请检查服务状态。`;
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
      ? '提交响应未确认；页面不会自动重发，请先检查服务状态。'
      : '连接暂时中断，请检查网络或生成服务。');
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
  for (const element of $('plan-form').querySelectorAll('input,select,button')) element.disabled = !!busy;
  $('prepare').disabled = !!busy || !state.token;
  if ($('snapshot')) $('snapshot').disabled = !!busy || !state.token || state.locationMode !== 'test';
  $('lat').readOnly = $('lon').readOnly = state.locationMode === 'device';
  $('gps').disabled = !!busy || state.locationBusy;
  $('open-streetview').disabled = !!busy || state.streetViewBusy;
  $('geometry-test').disabled = !!busy || !state.token || state.locationMode !== 'test';
  $('test-controls').hidden = state.locationMode !== 'test';
  $('location-mode').value = state.locationMode;
  $('location-label').textContent = state.locationMode === 'device' ? '手机当前位置' : '测试点位 · 非当前位置';
  renderLocationStatus();
  if ($('edits-file')) $('edits-file').disabled = !!busy || !state.token || !state.plan;
  $('generate').disabled = !state.token || !state.plan || !state.config?.configured || !!busy
    || !!state.job || state.submissionUnknown
    || state.plan?.input_kind === 'streetview_panorama' && state.config?.panorama_editor_configured === false;
  $('prepare').textContent = state.planBusy ? '正在准备所选位置…' : '准备当前街景 →';
  const streetview = state.config?.streetview;
  $('streetview-status').textContent = !state.config ? '正在检查街景服务…'
    : !streetview?.configured ? '服务器尚未配置 Google 全景获取。可以先在 Google 地图查看当前位置。'
      : !streetview?.ai_authorized ? 'Google 全景用于生成的授权尚未配置；可先打开官方街景查看。'
        : '生成流程使用此处的 360° 实景全景，不使用地图粗模型。';
  $('generate').textContent = state.generateBusy ? '正在创建世界任务…'
    : state.job?.stage === 'ready' ? (failedHistoricalReview() ? '生成完成 · 历史外观未通过检查' : '世界已生成')
      : state.job ? '任务已创建，请查看下方状态'
        : state.submissionUnknown ? '提交状态待确认' : '生成历史世界 →';
  for (const button of document.querySelectorAll('[data-view]')) {
    const view = button.dataset.view;
    button.classList.toggle('active', view === state.view || view === 'depth' && state.view === 'depth_preview');
    button.disabled = !availableView(view);
    button.hidden = (!state.plan || state.plan.input_kind === 'streetview_panorama') && ['historical', 'modern', 'depth'].includes(view);
  }
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

function renderPlan(plan) {
  state.plan = plan;
  $('plan-panel').hidden = false;
  const photograph = plan.input_kind === 'streetview_panorama';
  $('geometry-stats').hidden = photograph; $('geometry-edits').hidden = photograph;
  $('generation-description').textContent = photograph
    ? '先将实景全景改写为目标年代，再由 World Labs 生成 Draft 三维世界。图片处理与世界生成分别计费；相同区块任务会复用已有结果。'
    : '旧几何实验：World Labs 将依次从粗模型深度生成历史全景与 Draft 三维世界。此路线不使用 Google 街景照片。';
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
      ? ({ add: '新增 · 未核实', remove: '移除 · 未核实', replace: '替换 · 未核实', keep: '保留 · 未核实' }[change.action] || '用户编辑 · 未核实')
      : ({ remove: '移除现代体块', remove_if_visible: '若入镜则移除', predates_target: '建成年代早于目标年份', keep: '年代有依据', unknown: '年代未核实' }[change.action] || '未核实');
    const name = document.createElement('strong');
    name.textContent = text([...modern, ...historical].find((building) => building.id === change.building_id)?.label,
      text(change.name, text(change.building_id, '建筑')));
    const reason = document.createElement('p'); reason.textContent = changeReason(change);
    entry.append(badge, name, reason); $('changes').append(entry);
  }
  if (!changes.length) $('changes').textContent = photograph
    ? '将以真实街景照片为输入；目标年代的建筑外观与结构变化仍需结合史料核实。'
    : '没有可逐项核实的建筑年代变化；保留体块仍需核实。';
  $('sources').replaceChildren();
  for (const source of Array.isArray(plan.sources) ? plan.sources : []) {
    const href = safeSourceURL(source.url);
    const item = document.createElement(href ? 'a' : 'p');
    item.textContent = text(source.title, text(source.id, '来源'));
    if (href) { item.href = href; item.target = '_blank'; item.rel = 'noopener noreferrer'; }
    $('sources').append(item);
  }
  $('uncertainties').replaceChildren();
  for (const uncertainty of Array.isArray(plan.uncertainties) ? plan.uncertainties : []) {
    const item = document.createElement('li'); item.textContent = text(uncertainty); $('uncertainties').append(item);
  }
  const planLocation = plan.location || {};
  const coordinates = Number.isFinite(planLocation.lat) && Number.isFinite(planLocation.lon)
    ? `${planLocation.lat.toFixed(6)}, ${planLocation.lon.toFixed(6)}` : '坐标未记录';
  const provenance = planLocation.location_source || plan.location_source;
  $('plan-location').textContent = `${state.viewingSavedPlan ? '正在查看已保存的结果' : '当前预览区块'}：${coordinates} · ${plan.target_year} 年。`
    + (provenance === 'test' ? ' 此结果使用测试点位。' : '')
    + (state.viewingSavedPlan ? ' 与上方正在定位的手机位置独立；准备新区块会重新定位。' : '');
  if (photograph && Number.isFinite(plan.source_panorama?.metadata?.distance_m)) {
    $('plan-location').textContent += ` 街景拍摄点距输入位置约 ${Math.round(plan.source_panorama.metadata.distance_m)} 米。`;
  }
  saveResume(); syncUI();
}

function renderLocationStatus() {
  const mode = state.locationMode;
  $('location-status').classList.toggle('error', !!state.locationError);
  if (mode === 'test') {
    $('location-status').textContent = '测试模式已开启：只使用指定点位，不会自动改为手机位置。';
    $('location-meta').textContent = '切换回“手机当前位置”后将重新定位。';
    return;
  }
  if (state.locationBusy) $('location-status').textContent = '正在请求手机当前位置，请允许位置权限…';
  else if (state.locationError) $('location-status').textContent = state.locationError;
  else if (state.locationFix) $('location-status').textContent = '已获取设备位置。准备新区块时会再次定位。';
  else $('location-status').textContent = '尚未获取手机位置。请允许位置权限并重新定位。';
  const fix = state.locationFix;
  $('location-meta').textContent = fix
    ? `设备报告精度约 ${Math.round(fix.accuracy_m)} 米 · ${Math.max(0, Math.round((Date.now() - fix.timestamp_ms) / 1000))} 秒前定位（${new Date(fix.timestamp_ms).toLocaleTimeString()}）。`
    : '没有位置时不会使用 CMU 或上次保存的坐标。';
}

function locationFailure(error) {
  if (error?.code === 1) return '位置权限被拒绝。请在浏览器设置中允许定位，再点“重新定位”。';
  if (error?.code === 2) return '设备暂时无法确定位置，请到信号较好的地方重新定位。';
  if (error?.code === 3) return '定位超时，请重试；不会改用旧坐标或测试点位。';
  return error?.message || '无法获取手机位置，请重新定位。';
}

async function refreshLocation() {
  const epoch = ++state.locationEpoch;
  state.locationFix = null; state.locationError = ''; state.locationBusy = true;
  if (state.locationMode === 'device') { $('lat').value = ''; $('lon').value = ''; }
  syncUI();
  try {
    if (!window.isSecureContext) throw new Error('手机定位需要 HTTPS。请用安全演示链接打开页面。');
    if (!navigator.geolocation) throw new Error('此浏览器不支持定位，请使用支持定位的 Safari 或 Chrome。');
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
    if (epoch !== state.locationEpoch || state.locationMode !== 'device') throw new Error('位置模式已切换，本次定位已忽略。');
    const fix = { lat: position.coords?.latitude, lon: position.coords?.longitude,
      accuracy_m: position.coords?.accuracy, timestamp_ms: position.timestamp };
    const age = Date.now() - fix.timestamp_ms;
    if (![fix.lat, fix.lon, fix.accuracy_m, fix.timestamp_ms].every(Number.isFinite)
        || Math.abs(fix.lat) > 85 || Math.abs(fix.lon) > 180 || fix.accuracy_m < 0
        || age > 60000 || age < -10000) throw new Error('设备返回的位置无效或已过期，请重新定位。');
    state.locationFix = fix;
    $('lat').value = fix.lat.toFixed(6); $('lon').value = fix.lon.toFixed(6);
    return fix;
  } catch (error) {
    if (epoch === state.locationEpoch && state.locationMode === 'device') state.locationError = locationFailure(error);
    throw new Error(locationFailure(error));
  } finally {
    if (epoch === state.locationEpoch) { state.locationBusy = false; syncUI(); }
  }
}

async function setLocationMode(mode) {
  if (mode !== 'device' && mode !== 'test') return;
  state.locationMode = mode; ++state.locationEpoch;
  state.locationFix = null; state.locationError = ''; state.locationBusy = false;
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
  if (!$('lat').value.trim() || !$('lon').value.trim()) throw new Error('请在测试模式中填写经纬度，或明确选择 CMU 测试快照。');
  const lat = Number($('lat').value), lon = Number($('lon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    throw new Error('测试经纬度无效。');
  }
  return { lat, lon, location_source: 'test' };
}

async function openStreetView() {
  if (state.streetViewBusy) return;
  // Reserve the new tab in the click event before asynchronous geolocation.
  const target = window.open('about:blank', '_blank');
  if (!target) { message('浏览器阻止了新页面，请允许此网站打开 Google 街景。', true); return; }
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

async function preparePlan(source = 'google_streetview') {
  if (state.planBusy || state.generateBusy || state.restoring
      || state.job && !TERMINAL.has(state.job.stage || state.job.status)) return;
  if (source !== 'google_streetview' && state.locationMode !== 'test') {
    message('地图粗模型与 CMU 快照仅用于明确开启的测试模式。', true); return;
  }
  if (source === 'cmu_snapshot') {
    $('lat').value = String(state.config?.test_location?.lat ?? 40.4433);
    $('lon').value = String(state.config?.test_location?.lon ?? -79.9436);
  }
  const epoch = ++state.planEpoch;
  state.planBusy = true; syncUI();
  try {
    const coordinates = await resolveLocation();
    if (epoch !== state.planEpoch) return;
    if (!$('plan-form').reportValidity()) return;
    const payload = { ...coordinates, year: Number($('year').value),
      radius_m: Number($('radius').value), heading_deg: 0, source };
    if (![payload.year, payload.radius_m].every(Number.isFinite)) return;
    message(source === 'google_streetview' ? '正在获取所选位置的 Google 360° 实景全景…'
      : source === 'cmu_snapshot' ? '正在读取明确选择的 CMU 地图快照并生成粗模型…'
      : '正在查询所选位置的地图轮廓并核对历史来源，可能需要片刻…');
    const plan = await api('/world-plans', { method: 'POST', body: payload });
    if (epoch !== state.planEpoch) return;
    clearTimeout(state.pollTimer); ++state.jobEpoch;
    state.job = null; state.submissionUnknown = false; state.userViewLocked = false; state.viewingSavedPlan = false; setJobURL();
    $('job-panel').hidden = true; renderPlan(plan);
    await showView(plan.input_kind === 'streetview_panorama' ? 'source' : 'historical', { automatic: true });
    revealMobilePreview();
  } catch (error) {
    if (epoch === state.planEpoch) message(error.message, true);
  } finally {
    if (epoch === state.planEpoch) { state.planBusy = false; syncUI(); }
  }
}

function jobDetails(job) {
  const stage = job.stage || job.status;
  if (failedHistoricalReview(job)) return `历史外观未通过检查。${reviewNotes(job)} 资产保留供核查，不能视为该年代的准确还原。`;
  if (stage === 'submission_unknown') return '服务未确认提交结果。请核对已接受的任务，勿重复创建付费生成。';
  if (stage === 'insufficient_credits') return '服务器积分不足；已生成的资产仍可查看。';
  if (stage === 'error') return `任务停止${/^[a-z0-9_]{1,80}$/.test(job.error_code || '') ? `（${job.error_code}）` : ''}。现有资产保留。`;
  if (stage === 'paused') return '任务已保存。这里只继续读取状态，恢复由生成服务处理。';
  if (stage === 'ready') return '真实生成资产已保存；历史准确性、空间对齐与手机追踪仍未核实。';
  return state.plan?.input_kind === 'streetview_panorama'
    ? '可先查看输入的真实街景与已完成的历史全景。刷新页面会读取原任务，不会重新提交生成。'
    : '可先查看几何深度或已完成的全景。刷新页面会读取原任务，不会重新提交生成。';
}

async function importEdits(file) {
  if (!file || !state.plan || state.planBusy || state.generateBusy || state.restoring
      || state.job && !TERMINAL.has(state.job.stage || state.job.status)) return;
  if (file.size > 256 * 1024) { message('历史编辑文件不能超过 256 KB。', true); return; }
  const epoch = ++state.planEpoch;
  const planId = state.plan.plan_id;
  state.planBusy = true; syncUI(); message('正在验证历史几何编辑及其来源…');
  try {
    let payload;
    try { payload = JSON.parse(await file.text()); }
    catch { throw new Error('无法读取 JSON 编辑文件。'); }
    if (!Array.isArray(payload?.edits) || !payload.edits.length) throw new Error('编辑文件需要非空 edits 数组。');
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
  state.resumeBusy = true; syncUI(); message('正在恢复已保存的任务…');
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
  $('job-stage').textContent = failedHistoricalReview(job) ? '历史外观未通过检查 · 资产仍可查看' : STAGES[stage] || '等待服务状态';
  const elapsed = job.timing_s?.total_to_assets;
  $('job-detail').textContent = jobDetails(job)
    + (Number.isFinite(elapsed) ? ` 从创建到资产就绪 ${elapsed.toFixed(1)} 秒。` : '');
  const costs = job.cost_credits || {};
  const credit = (value) => Number.isFinite(value) ? `${value} credits` : '未返回';
  const photoInput = state.plan?.input_kind === 'streetview_panorama' || !!job.generation_calls?.image_edit;
  $('cost').textContent = photoInput
    ? `OpenAI 图片改写另行计费 · World Labs 世界：${credit(costs.world)} · World Labs 总计：${credit(costs.total)}`
    : `全景：${credit(costs.depth)} · 世界：${credit(costs.world)} · 总计：${credit(costs.total)}`;
  $('job-assets').replaceChildren();
  if (job.can_resume) {
    const resume = document.createElement('button'); resume.type = 'button';
    resume.textContent = '恢复已保存的任务'; resume.disabled = state.resumeBusy;
    resume.addEventListener('click', () => { void resumeJob(); }); $('job-assets').append(resume);
  }
  if (assetFor('depth_preview')) {
    const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = '查看几何全景';
    preview.addEventListener('click', () => { void showView('depth_preview'); }); $('job-assets').append(preview);
  }
  for (const asset of Array.isArray(job.assets) ? job.assets : []) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `下载 ${text(asset.filename, '资产')}`;
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
  if (!state.plan || state.generateBusy || state.job || state.submissionUnknown || !state.config?.configured) return;
  state.generateBusy = true; syncUI(); message('正在创建历史全景与 Draft 世界任务…');
  try {
    const job = await api('/world-jobs', { method: 'POST', body: { plan_id: state.plan.plan_id, model: 'marble-1.0-draft' } });
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
  renderer.domElement.setAttribute('aria-label', '虚拟三维浏览；未启用手机空间追踪');
  renderer.domElement.tabIndex = 0;
  $('viewport').append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe5e8df);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f7869, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(80, 120, 60); scene.add(sun);
  const camera = new THREE.PerspectiveCamera(65, 2, 0.05, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.1; controls.maxDistance = 600;
  const spark = new SparkRenderer({ renderer }); scene.add(spark);
  const helpers = new THREE.Group();
  helpers.add(new THREE.AxesHelper(8));
  const grid = new THREE.GridHelper(120, 24, 0x778578, 0xc3cabb); grid.position.y = 0.02;
  helpers.add(grid); scene.add(helpers);
  const engine = { renderer, scene, camera, controls, spark, helpers, current: null, home: null, metric: false, previousTime: 0 };
  state.engine = engine;
  const resize = () => {
    const width = Math.max(1, $('viewport').clientWidth), height = Math.max(1, $('viewport').clientHeight);
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
  };
  engine.observer = new ResizeObserver(resize); engine.observer.observe($('viewport')); resize();
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); message('三维图形上下文已丢失，请刷新恢复；已保存任务不会重新生成。', true);
  });
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - engine.previousTime) / 1000 || 0); engine.previousTime = now;
    if (renderer.domElement.hidden || document.visibilityState === 'hidden') return;
    moveCamera(engine, dt); controls.update();
    try { renderer.render(scene, camera); }
    catch { message('此设备无法绘制当前三维资产；全景和下载仍可使用。', true); renderer.setAnimationLoop(null); }
  });
  return engine;
}

function moveCamera(engine, dt) {
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
  $('view-caption').textContent = `${view === 'modern' ? '现代' : `${state.plan?.target_year || ''} 年历史`}粗模型${Number.isInteger(count) ? ` · ${count} 栋` : ''} · 红东 / 绿上 / 蓝南`;
  $('viewer-note').textContent = '简化体块与平坦地面，单位为米。拖动旋转、双指缩放；WASD 或方向按钮仅移动虚拟相机，不代表手机真实行走。';
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
  if (!automatic) state.userViewLocked = true;
  const epoch = ++state.viewEpoch; state.viewAbort?.abort();
  const controller = new AbortController(); state.viewAbort = controller; state.view = view;
  state.keys.clear(); state.touchMoves.clear(); syncUI(); message('正在加载预览…');
  $('empty').hidden = true; $('flat-preview').hidden = true; $('move-pad').hidden = true;
  if (state.imageURL) { URL.revokeObjectURL(state.imageURL); state.imageURL = null; $('flat-preview').removeAttribute('src'); }
  if (state.engine) {
    state.engine.renderer.domElement.hidden = true;
    state.engine.current?.removeFromParent(); disposeObject(state.engine.current); state.engine.current = null;
  }
  let pendingObject = null;
  try {
    const url = safeAssetURL(asset.url);
    if (view === 'source' || view === 'depth' || view === 'depth_preview' || view === 'pano') {
      const blob = await api(url, { format: 'blob', signal: controller.signal });
      if (epoch !== state.viewEpoch) return;
      state.imageURL = URL.createObjectURL(blob); $('flat-preview').src = state.imageURL;
      await $('flat-preview').decode();
      if (epoch !== state.viewEpoch) return;
      $('flat-preview').hidden = false;
      $('flat-preview').alt = view === 'source' ? 'Google Street View 360 度实景全景照片，平面展开预览' : view === 'pano' ? '模型生成的历史想象全景，历史准确性未核实'
        : view === 'depth_preview' ? '历史粗几何的全景诊断预览' : '历史几何的全景径向深度，近白远黑';
      $('view-caption').textContent = view === 'source' ? '当前街景 · 360° 实景全景照片（平面展开）' : view === 'pano' ? '历史想象全景 · 实际生成结果'
        : view === 'depth_preview' ? '历史几何全景 · 墙面、屋顶与地面的诊断预览' : '360° 径向深度 · 对数编码 · 近白 / 远黑';
      const sourceMetadata = state.plan?.source_panorama?.metadata || {};
      $('viewer-note').textContent = view === 'source'
        ? `Google Street View · ${text(sourceMetadata.copyright)} · 拍摄日期：${text(sourceMetadata.date, '未提供')}。这是一张完整全景照片；拍摄时间可能早于现在，平面展开不是三维网格。`
        : view === 'pano'
        ? '这是平面展示的生成全景。建筑外观及历史细节未核实；不会把全景旋转称为真实空间行走。'
        : '全景由建筑几何射线求交得到，删除体块会改变遮挡。诊断色彩仅区分几何表面，未观察到的历史地物仍未知。';
    } else {
      const engine = ensureEngine();
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
        $('view-caption').textContent = transform.metric ? '生成世界 · 已应用提供方米制比例与地面偏移'
          : '生成世界 · 使用模型单位，比例与地面未核实';
        $('viewer-note').textContent = '真实 SPZ 资产；拖动查看、WASD 或方向按钮虚拟移动。源相机位置、地理朝向与手机空间对齐仍未核实，无碰撞或真实 AR 追踪。';
      } else {
        const model = await new GLTFLoader().parseAsync(bytes, ''); pendingObject = model.scene;
        if (epoch !== state.viewEpoch) { disposeObject(pendingObject); return; }
        fitCoarse(engine, pendingObject, view);
      }
      engine.current = pendingObject; pendingObject = null;
      engine.scene.add(engine.current); engine.renderer.domElement.hidden = false; engine.controls.update();
      $('move-pad').hidden = false;
    }
    if (epoch === state.viewEpoch) { applyReviewNotice(); message(); }
  } catch (error) {
    disposeObject(pendingObject);
    if (epoch !== state.viewEpoch || error.name === 'AbortError') return;
    $('view-caption').textContent = '预览未加载';
    message(error instanceof RequestError ? error.message : '无法显示此资产；可切换其他预览或下载原文件。', true);
  }
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
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)) {
    try {
      const session = await api('/world-session', { auth: false });
      if (validToken(session.access_token)) { state.token = session.access_token; connected(); return; }
    } catch { /* Remote access is explicit; no key is requested from the user. */ }
  }
  $('access-panel').hidden = false; $('connection').textContent = '需要访问码'; syncUI();
}

function connected() {
  storageSet(TOKEN_KEY, state.token); $('access').value = '';
  $('access-panel').hidden = true; $('connection').textContent = '生成服务已连接'; syncUI();
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
    if (!/^[a-f0-9]{32}$/.test(requested || '')) { message('世界任务链接无效。', true); return; }
    // Explicit links take priority over a different locally saved task.
    saved = { job_id: requested, plan_id: saved?.job_id === requested ? saved.plan_id : null };
  }
  if (!saved || (!saved.plan_id && !saved.job_id)) return;
  const epoch = ++state.planEpoch; state.restoring = true; syncUI(); message('正在读取已保存的区块与世界任务…');
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
    if (state.submissionUnknown) message('上次提交响应未确认；请核对服务器任务，页面不会自动重发。', true);
    else if (!availableView(state.view)) message();
  } catch (error) { if (epoch === state.planEpoch) message(error.message, true); }
  finally { if (epoch === state.planEpoch) { state.restoring = false; syncUI(); } }
}

function bindEvents() {
  $('plan-form').addEventListener('submit', (event) => { event.preventDefault(); void preparePlan('google_streetview'); });
  $('geometry-test').addEventListener('click', () => { void preparePlan('osm'); });
  $('open-streetview').addEventListener('click', openStreetView);
  $('snapshot')?.addEventListener('click', () => { void preparePlan('cmu_snapshot'); });
  $('edits-file')?.addEventListener('change', (event) => { void importEdits(event.target.files?.[0]); });
  $('generate').addEventListener('click', () => { void startGeneration(); });
  $('connect').addEventListener('click', async () => {
    const token = $('access').value.trim();
    if (!validToken(token)) { message('请输入有效访问码。', true); return; }
    $('connect').disabled = true; state.token = token;
    try { await verifyAccess(); message(); await restoreSaved(); }
    catch (error) { state.token = ''; storageSet(TOKEN_KEY, null); message(error.message, true); syncUI(); }
    finally { $('connect').disabled = false; }
  });
  $('location-mode').addEventListener('change', (event) => setLocationMode(event.target.value));
  $('gps').addEventListener('click', async () => {
    if (state.locationMode !== 'device') await setLocationMode('device');
    else { try { await refreshLocation(); } catch { /* Error remains beside the location inputs. */ } }
  });
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => { void showView(button.dataset.view); });
  }
  $('reset-view').addEventListener('click', () => {
    const engine = state.engine;
    if (!engine?.home || engine.renderer.domElement.hidden) return;
    engine.camera.position.copy(engine.home.position); engine.controls.target.copy(engine.home.target); engine.controls.update();
  });
  const moveKeys = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right' };
  window.addEventListener('keydown', (event) => {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target?.tagName) || event.target?.isContentEditable) return;
    const move = moveKeys[event.code];
    if (move && state.engine && !state.engine.renderer.domElement.hidden) { event.preventDefault(); state.keys.add(move); }
  });
  window.addEventListener('keyup', (event) => state.keys.delete(moveKeys[event.code]));
  const releaseMoves = () => { state.keys.clear(); state.touchMoves.clear(); };
  window.addEventListener('blur', releaseMoves); document.addEventListener('visibilitychange', releaseMoves);
  for (const button of document.querySelectorAll('[data-move]')) {
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault(); button.setPointerCapture(event.pointerId); state.touchMoves.add(button.dataset.move);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(name, () => state.touchMoves.delete(button.dataset.move));
    }
  }
  window.addEventListener('pagehide', () => {
    clearTimeout(state.pollTimer); state.viewAbort?.abort(); releaseMoves();
    if (state.imageURL) URL.revokeObjectURL(state.imageURL);
    if (state.engine) { state.engine.renderer.setAnimationLoop(null); state.engine.observer.disconnect(); }
  });
}

async function boot() {
  bindEvents(); syncUI();
  void refreshLocation().catch(() => {});
  const results = await Promise.allSettled([
    api('/world-config', { auth: false }).then((config) => {
      state.config = config;
      if (Number.isInteger(config.min_year)) $('year').min = String(config.min_year);
      if (Number.isInteger(config.max_year)) $('year').max = String(config.max_year);
      syncUI();
    }), initialiseAccess(),
  ]);
  if (results[0].status === 'rejected') message('无法读取服务配置，请检查服务是否启动。', true);
  else if (!state.config.configured) message('服务器尚未配置 World Labs；可以先准备和审视粗模型。');
  await restoreSaved();
}

void boot();
