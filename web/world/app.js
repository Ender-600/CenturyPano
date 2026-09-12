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
  pollTimer: null, view: 'historical', viewAbort: null, userViewLocked: false,
  imageURL: null, engine: null, keys: new Set(), touchMoves: new Set(),
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
  if ($('snapshot')) $('snapshot').disabled = !!busy || !state.token;
  if ($('edits-file')) $('edits-file').disabled = !!busy || !state.token || !state.plan;
  $('generate').disabled = !state.token || !state.plan || !state.config?.configured || !!busy
    || !!state.job || state.submissionUnknown;
  $('prepare').textContent = state.planBusy ? '正在获取轮廓与准备几何…' : '准备历史区块 →';
  $('generate').textContent = state.generateBusy ? '正在创建世界任务…'
    : state.job?.stage === 'ready' ? (failedHistoricalReview() ? '生成完成 · 历史外观未通过检查' : '世界已生成')
      : state.job ? '任务已创建，请查看下方状态'
        : state.submissionUnknown ? '提交状态待确认' : '生成历史世界 →';
  for (const button of document.querySelectorAll('[data-view]')) {
    const view = button.dataset.view;
    button.classList.toggle('active', view === state.view || view === 'depth' && state.view === 'depth_preview');
    button.disabled = !availableView(view);
  }
}

function assetFor(view) {
  const assets = Array.isArray(state.job?.assets) ? state.job.assets : [];
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
      : ({ remove: '移除现代体块', keep: '年代有依据', unknown: '年代未核实' }[change.action] || '未核实');
    const name = document.createElement('strong');
    name.textContent = text([...modern, ...historical].find((building) => building.id === change.building_id)?.label,
      text(change.building_id, '建筑'));
    const reason = document.createElement('p'); reason.textContent = changeReason(change);
    entry.append(badge, name, reason); $('changes').append(entry);
  }
  if (!changes.length) $('changes').textContent = '没有可逐项核实的建筑年代变化；保留体块仍需核实。';
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
  if (Number.isInteger(plan.target_year)) $('year').value = String(plan.target_year);
  if (Number.isFinite(plan.location?.lat)) $('lat').value = String(plan.location.lat);
  if (Number.isFinite(plan.location?.lon)) $('lon').value = String(plan.location.lon);
  if (Number.isFinite(plan.location?.radius_m)) $('radius').value = String(plan.location.radius_m);
  saveResume(); syncUI();
}

async function preparePlan(source = 'osm') {
  if (state.planBusy || state.generateBusy || state.restoring
      || state.job && !TERMINAL.has(state.job.stage || state.job.status)) return;
  if (source === 'cmu_snapshot') {
    $('lat').value = String(state.config?.default_location?.lat ?? 40.4433);
    $('lon').value = String(state.config?.default_location?.lon ?? -79.9436);
  }
  if (!$('plan-form').reportValidity()) return;
  const payload = { lat: Number($('lat').value), lon: Number($('lon').value), year: Number($('year').value),
    radius_m: Number($('radius').value), heading_deg: 0, source };
  if (![payload.lat, payload.lon, payload.year, payload.radius_m].every(Number.isFinite)) return;
  const epoch = ++state.planEpoch;
  state.planBusy = true; syncUI();
  message(source === 'cmu_snapshot' ? '正在读取明确选择的 CMU 地图快照并生成粗模型…'
    : '正在查询当前地图轮廓并核对历史来源，可能需要片刻…');
  try {
    const plan = await api('/world-plans', { method: 'POST', body: payload });
    if (epoch !== state.planEpoch) return;
    clearTimeout(state.pollTimer); ++state.jobEpoch;
    state.job = null; state.submissionUnknown = false; state.userViewLocked = false; setJobURL();
    $('job-panel').hidden = true; renderPlan(plan);
    await showView('historical', { automatic: true });
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
  return '可先查看几何深度或已完成的全景。刷新页面会读取原任务，不会重新提交生成。';
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
  $('cost').textContent = `全景：${credit(costs.depth)} · 世界：${credit(costs.world)} · 总计：${credit(costs.total)}`;
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
    if (view === 'depth' || view === 'depth_preview' || view === 'pano') {
      const blob = await api(url, { format: 'blob', signal: controller.signal });
      if (epoch !== state.viewEpoch) return;
      state.imageURL = URL.createObjectURL(blob); $('flat-preview').src = state.imageURL;
      await $('flat-preview').decode();
      if (epoch !== state.viewEpoch) return;
      $('flat-preview').hidden = false;
      $('flat-preview').alt = view === 'pano' ? '模型生成的历史想象全景，历史准确性未核实'
        : view === 'depth_preview' ? '历史粗几何的全景诊断预览' : '历史几何的全景径向深度，近白远黑';
      $('view-caption').textContent = view === 'pano' ? '历史想象全景 · 实际生成结果'
        : view === 'depth_preview' ? '历史几何全景 · 墙面、屋顶与地面的诊断预览' : '360° 径向深度 · 对数编码 · 近白 / 远黑';
      $('viewer-note').textContent = view === 'pano'
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
      renderPlan(plan);
    }
    state.submissionUnknown = saved.submission_unknown === true && !job;
    if (job) { applyJob(job); schedulePoll(++state.jobEpoch); }
    if (!assetFor('world') && !assetFor('pano') && availableView('historical')) await showView('historical', { automatic: true });
    if (state.submissionUnknown) message('上次提交响应未确认；请核对服务器任务，页面不会自动重发。', true);
    else if (!availableView(state.view)) message();
  } catch (error) { if (epoch === state.planEpoch) message(error.message, true); }
  finally { if (epoch === state.planEpoch) { state.restoring = false; syncUI(); } }
}

function bindEvents() {
  $('plan-form').addEventListener('submit', (event) => { event.preventDefault(); void preparePlan('osm'); });
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
  $('gps').addEventListener('click', () => {
    if (!navigator.geolocation) { message('此浏览器无法获取位置，请手动输入经纬度。', true); return; }
    $('gps').disabled = true; message('等待设备位置许可…');
    navigator.geolocation.getCurrentPosition((position) => {
      $('lat').value = position.coords.latitude.toFixed(6); $('lon').value = position.coords.longitude.toFixed(6);
      message(`位置已填入，设备报告精度约 ${Math.round(position.coords.accuracy)} 米。请准备区块以查看覆盖。`); syncUI();
    }, () => { message('未获取位置，请允许位置权限或手动填写经纬度。', true); syncUI(); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
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
