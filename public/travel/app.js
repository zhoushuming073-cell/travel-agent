const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function dateAfter(days) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

const state = {
  city: '杭州',
  startDate: dateAfter(3),
  days: 3,
  budget: 1500,
  style: '自然风景',
  preferences: ['自然'],
  pace: 'medium',
  transport: '公共交通优先',
  hotelPreference: '交通方便',
  cityRef: null,
  variant: 'relax',
  plans: {},
  plan: null,
  previousPlan: null,
  spots: [],
  spotIndex: new Map(),
  cityCenters: {},
  health: null,
  providerStatus: null,
  partySize: null,
  requiredAttractions: [],
  dayStart: null,
  dayEnd: null,
  lodgingArea: null,
  workspaceStage: 'EMPTY',
  latestResult: null,
  pendingChange: null,
  pendingReadyResult: null,
};

const WORKSPACE_STAGES = {
  EMPTY: { label: '等待输入', eyebrow: 'NEW TRIP', title: '开始一段新旅行', workflow: -1 },
  BUILDING_PROFILE: { label: '整理需求', eyebrow: 'STAGE 1 / PROFILE', title: '正在建立旅行画像', workflow: 0 },
  FETCHING_DATA: { label: '联网取证', eyebrow: 'STAGE 2 / EVIDENCE', title: '正在获取可验证信息', workflow: 1 },
  GENERATING_ITINERARY: { label: '生成路线', eyebrow: 'STAGE 3 / ROUTING', title: '正在生成三套候选方案', workflow: 2 },
  VALIDATING_ITINERARY: { label: '验证与压测', eyebrow: 'STAGE 4 / VALIDATION', title: '正在检查约束、未知与脆弱性', workflow: 3 },
  READY: { label: '规划完成', eyebrow: 'TRAVEL WORKSPACE', title: '可执行行程与决策依据', workflow: 4 },
  ERROR: { label: '需要重试', eyebrow: 'AGENT PAUSED', title: '规划任务未完成', workflow: -1 },
};

function setWorkspaceStage(stage) {
  const config = WORKSPACE_STAGES[stage] || WORKSPACE_STAGES.EMPTY;
  state.workspaceStage = stage;
  document.body.dataset.stage = stage;
  $('#emptyStage').hidden = stage !== 'EMPTY';
  $('#activeStage').hidden = !['BUILDING_PROFILE', 'FETCHING_DATA', 'GENERATING_ITINERARY', 'VALIDATING_ITINERARY', 'ERROR'].includes(stage);
  $('#readyStage').hidden = stage !== 'READY';
  $('#persistentComposer').hidden = stage !== 'READY';
  const visibleAgentStage = stage === 'GENERATING_ITINERARY' ? 'FETCHING_DATA' : stage;
  $$('[data-agent-stage]').forEach(view => { view.hidden = view.dataset.agentStage !== visibleAgentStage; });
  const flowIndex = ({ BUILDING_PROFILE: 0, FETCHING_DATA: 1, GENERATING_ITINERARY: 2, VALIDATING_ITINERARY: 3, READY: 4 })[stage] ?? -1;
  $$('.stage-flow li').forEach((item, index) => {
    item.classList.toggle('active', index === flowIndex);
    item.classList.toggle('done', flowIndex > index || stage === 'READY');
  });
  $('#workspaceState').textContent = config.label;
  $('#workspaceState').className = `workspace-state ${stage === 'ERROR' ? 'warning' : stage === 'EMPTY' ? '' : 'live'}`;
  $('#workspaceEyebrow').textContent = config.eyebrow;
  $('#workspaceTitle').textContent = stage === 'READY' && state.plan ? `${state.plan.city} · ${state.plan.days} 天旅行` : config.title;
  $('#agentStageTitle').textContent = config.title;
  $$('#agentWorkflow li').forEach((item, index) => {
    item.classList.toggle('active', index === config.workflow);
    item.classList.toggle('done', config.workflow > index || stage === 'READY');
    const small = $('small', item);
    if (small && index === config.workflow) small.textContent = '正在执行';
    else if (small && (config.workflow > index || stage === 'READY')) small.textContent = '已完成';
  });
  if (stage === 'READY') requestAnimationFrame(() => mapView?.render());
}

function openSettingsDrawer() {
  $('#settingsDrawer').classList.add('open');
  $('#settingsDrawer').setAttribute('aria-hidden', 'false');
  $('#drawerBackdrop').hidden = false;
}

function closeSettingsDrawer() {
  $('#settingsDrawer').classList.remove('open');
  $('#settingsDrawer').setAttribute('aria-hidden', 'true');
  $('#drawerBackdrop').hidden = true;
}

function storeTripHistory(plan) {
  if (!plan) return;
  const entry = { city: plan.city, date: plan.startDate, days: plan.days, title: plan.title, savedAt: Date.now() };
  let history = [];
  try { history = JSON.parse(localStorage.getItem('travel-agent-history-v2') || '[]'); } catch { history = []; }
  history = history.filter(item => !(item.city === entry.city && item.date === entry.date));
  localStorage.setItem('travel-agent-history-v2', JSON.stringify([entry, ...history].slice(0, 5)));
  renderTripHistory();
}

function renderTripHistory() {
  let history = [];
  try { history = JSON.parse(localStorage.getItem('travel-agent-history-v2') || '[]'); } catch { history = []; }
  const current = state.plan ? { city: state.plan.city, date: state.plan.startDate, days: state.plan.days, title: state.plan.title, current: true } : null;
  if (current) history = history.filter(item => !(item.city === current.city && item.date === current.date));
  const today = new Date().toISOString().slice(0, 10);
  const groups = [
    { key: 'active', label: '旅行中', rows: current ? [current] : [] },
    { key: 'upcoming', label: '即将出发', rows: [] },
    { key: 'planned', label: '未开始', rows: [] },
    { key: 'finished', label: '已结束', rows: [] },
  ];
  history.forEach(item => {
    const start = item.date || '';
    const startDate = start ? new Date(`${start}T00:00:00`) : null;
    const endDate = startDate ? new Date(startDate.getTime() + Math.max(0, Number(item.days || 1) - 1) * 86400000) : null;
    const daysAway = startDate ? Math.ceil((startDate.getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000) : 999;
    if (start && endDate && endDate.toISOString().slice(0, 10) < today) groups[3].rows.push(item);
    else if (start && start <= today) groups[0].rows.push(item);
    else if (daysAway <= 30) groups[1].rows.push(item);
    else groups[2].rows.push(item);
  });
  const itemMarkup = (item, group) => `<button class="history-item${item.current ? ' active' : ''}" type="button" data-city="${esc(item.city)}" data-trip-search="${esc(`${item.city} ${item.title || ''} ${item.date || ''}`.toLowerCase())}"><i></i><span><b>${esc(item.city)} · ${esc(item.days)}天</b><small>${esc(item.current ? '当前打开 · 规划完成' : `${item.date || '日期未定'} · ${item.title || group.label}`)}</small></span><em>⋮</em></button>`;
  $('#tripHistory').innerHTML = groups.map(group => `<section class="trip-history-group" data-history-group="${group.key}"><header><span>${group.label}</span><b>${group.rows.length}</b></header><div>${group.rows.length ? group.rows.slice(0, 4).map(item => itemMarkup(item, group)).join('') : '<small class="history-group-empty">暂无</small>'}</div></section>`).join('');
  $$('.history-item').forEach(button => button.addEventListener('click', () => {
    state.city = button.dataset.city; syncControls(); openSettingsDrawer(); toast('已填入历史目的地，可补充新需求后重新规划');
  }));
}

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({ error: { message: '响应不是 JSON' } }));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.error || `HTTP ${response.status}`);
  }
  return body;
}

function formatDistance(meters = 0) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function paceText(value) {
  return ({ relax: '轻松', slow: '轻松', medium: '适中', tight: '紧凑' })[value] || value || '未指定';
}

function formatDuration(seconds = 0) {
  if (!seconds) return '0 分钟';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
}

function weatherText(code) {
  const labels = { 0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '较强毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '强阵雨', 95: '雷暴', 96: '雷暴伴冰雹', 99: '强雷暴' };
  return labels[code] || (code == null ? '未知' : `天气代码 ${code}`);
}

function weatherIconSvg(code) {
  const sun = '<circle cx="16" cy="16" r="5" fill="#f4ad3d"/><g stroke="#f4ad3d" stroke-width="1.8" stroke-linecap="round"><path d="M16 4v3M16 25v3M4 16h3M25 16h3M7.5 7.5l2.1 2.1M22.4 22.4l2.1 2.1M24.5 7.5l-2.1 2.1M9.6 22.4l-2.1 2.1"/></g>';
  const cloud = '<path d="M9 23h14.5a5.5 5.5 0 0 0 .1-11 8 8 0 0 0-15.2 2.1A4.6 4.6 0 0 0 9 23Z" fill="#dfe9f5" stroke="#5f80ac" stroke-width="1.6"/>';
  const rain = '<g stroke="#3d82dc" stroke-width="2" stroke-linecap="round"><path d="M11 25l-1.5 3M17 25l-1.5 3M23 25l-1.5 3"/></g>';
  const snow = '<g fill="#67a7de"><circle cx="10" cy="27" r="1.3"/><circle cx="17" cy="26" r="1.3"/><circle cx="24" cy="27" r="1.3"/></g>';
  const lightning = '<path d="M18 22h-4l-1 6 7-9h-4l2-5" fill="#f1a62d" stroke="#d98c15" stroke-linejoin="round"/>';
  let body = sun;
  if ([1, 2].includes(Number(code))) body = `${sun}${cloud}`;
  else if ([3, 45, 48].includes(Number(code))) body = cloud;
  else if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(Number(code))) body = `${cloud}${rain}`;
  else if ([71, 73, 75].includes(Number(code))) body = `${cloud}${snow}`;
  else if ([95, 96, 99].includes(Number(code))) body = `${cloud}${lightning}`;
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${body}</svg>`;
}

function seasonalText(spot) {
  if (spot?.seasonalFit == null) return '时令未知';
  return spot.seasonalFitQuality === 'rule-based' ? `时令参考 ${spot.seasonalFit}` : `时令 ${spot.seasonalFit}`;
}

function ensureBudgetOption(value) {
  const select = $('#budgetSelect');
  if (![...select.options].some(option => Number(option.value) === value)) {
    select.add(new Option(String(value), String(value)));
  }
}

class OSMMap {
  constructor(container) {
    this.container = container;
    this.tileLayer = $('#tileLayer');
    this.overlay = $('#mapOverlay');
    this.message = $('#mapMessage');
    this.center = { lat: 30.2741, lng: 120.1551 };
    this.zoom = 11;
    this.routes = [];
    this.markers = [];
    this.drag = null;
    this.bind();
    this.render();
  }

  bind() {
    this.container.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      this.drag = { x: event.clientX, y: event.clientY, cx: this.lonToWorldX(this.center.lng), cy: this.latToWorldY(this.center.lat) };
      this.container.setPointerCapture?.(event.pointerId);
    });
    this.container.addEventListener('pointermove', event => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.center = { lng: this.worldXToLon(this.drag.cx - dx), lat: this.worldYToLat(this.drag.cy - dy) };
      this.render();
    });
    this.container.addEventListener('pointerup', () => { this.drag = null; });
    this.container.addEventListener('pointercancel', () => { this.drag = null; });
    new ResizeObserver(() => this.render()).observe(this.container);
  }

  setCity(city) {
    const info = state.cityCenters[city];
    if (!info) return;
    this.center = { lat: info.lat, lng: info.lng };
    this.zoom = info.zoom;
    this.routes = [];
    this.markers = [];
    this.message.hidden = false;
    this.render();
  }

  setData(routes, markers) {
    this.routes = routes || [];
    this.markers = markers || [];
    this.message.hidden = Boolean(this.routes.length || this.markers.length);
    if (this.markers.length) this.fitMarkers(); else this.render();
  }

  zoomBy(delta) { this.zoom = Math.max(3, Math.min(18, this.zoom + delta)); this.render(); }
  n() { return 256 * 2 ** this.zoom; }
  lonToWorldX(lon) { return (lon + 180) / 360 * this.n(); }
  latToWorldY(lat) { const sin = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * this.n(); }
  worldXToLon(x) { return x / this.n() * 360 - 180; }
  worldYToLat(y) { const value = Math.PI - 2 * Math.PI * y / this.n(); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(value) - Math.exp(-value))); }
  project(lat, lng) { const rect = this.container.getBoundingClientRect(); const cx = this.lonToWorldX(this.center.lng); const cy = this.latToWorldY(this.center.lat); return { x: this.lonToWorldX(lng) - cx + rect.width / 2, y: this.latToWorldY(lat) - cy + rect.height / 2 }; }

  fitMarkers() {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    this.markers.forEach(marker => { minLat = Math.min(minLat, marker.lat); maxLat = Math.max(maxLat, marker.lat); minLng = Math.min(minLng, marker.lng); maxLng = Math.max(maxLng, marker.lng); });
    this.center = { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
    const rect = this.container.getBoundingClientRect();
    for (let zoom = 14; zoom >= 7; zoom -= 1) {
      this.zoom = zoom;
      const first = this.project(minLat, minLng), second = this.project(maxLat, maxLng);
      if (Math.abs(second.x - first.x) < rect.width * 0.72 && Math.abs(second.y - first.y) < rect.height * 0.68) break;
    }
    this.render();
  }

  render() {
    const rect = this.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const tileCount = 2 ** this.zoom;
    const left = this.lonToWorldX(this.center.lng) - rect.width / 2;
    const top = this.latToWorldY(this.center.lat) - rect.height / 2;
    const minX = Math.floor(left / 256) - 1, maxX = Math.floor((left + rect.width) / 256) + 1;
    const minY = Math.floor(top / 256) - 1, maxY = Math.floor((top + rect.height) / 256) + 1;
    const fragment = document.createDocumentFragment();
    for (let tileY = minY; tileY <= maxY; tileY += 1) {
      for (let tileX = minX; tileX <= maxX; tileX += 1) {
        if (tileY < 0 || tileY >= tileCount) continue;
        const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
        const image = document.createElement('img');
        image.className = 'map-tile'; image.alt = ''; image.draggable = false;
        image.src = `https://tile.openstreetmap.org/${this.zoom}/${wrappedX}/${tileY}.png`;
        image.style.left = `${tileX * 256 - left}px`; image.style.top = `${tileY * 256 - top}px`;
        fragment.appendChild(image);
      }
    }
    this.tileLayer.replaceChildren(fragment);
    this.renderOverlay();
  }

  renderOverlay() {
    const rect = this.container.getBoundingClientRect();
    this.overlay.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    let html = '';
    this.routes.forEach((route, index) => {
      if (!route?.length) return;
      const points = route.map(([lng, lat]) => this.project(lat, lng));
      const dayClass = index === 0 ? 'day-1' : index === 1 ? 'day-2' : 'day-3';
      html += `<polyline class="route-path ${dayClass}" points="${points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')}"/>`;
    });
    this.markers.forEach((marker, index) => {
      const point = this.project(marker.lat, marker.lng);
      if (point.x < -50 || point.x > rect.width + 50 || point.y < -50 || point.y > rect.height + 50) return;
      html += `<circle class="map-marker" cx="${point.x}" cy="${point.y}" r="11"/><text class="map-marker-label" x="${point.x}" y="${point.y + 0.5}">${index + 1}</text><text class="map-marker-name" x="${point.x + 15}" y="${point.y + 3}">${esc(marker.name).slice(0, 10)}</text>`;
    });
    this.overlay.innerHTML = html;
  }
}

const mapView = new OSMMap($('#mapView'));

async function loadCities() {
  const data = await api('/api/cities');
  state.cityCenters = Object.fromEntries(data.cities.map(city => [city.name, city]));
  $('#cityOptions').innerHTML = data.cities.map(city => `<option value="${esc(city.name)}">${esc(city.displayName || city.name)}</option>`).join('');
  state.cityRef = state.cityCenters[state.city] || null;
}

let citySearchTimer = null;
let weatherRequestVersion = 0;

async function searchCities(query, updateUi = true) {
  const text = String(query || '').trim();
  if (text.length < 2) return [];
  if (updateUi) { $('#citySearchState').textContent = '搜索中'; $('#citySearchHint').textContent = '正在中国范围内查找目的地…'; }
  try {
    const data = await api(`/api/city-search?q=${encodeURIComponent(text)}`);
    (data.cities || []).forEach(city => { state.cityCenters[city.name] = city; });
    $('#cityOptions').innerHTML = (data.cities || []).map(city => `<option value="${esc(city.name)}">${esc(city.displayName || city.name)}</option>`).join('');
    if (updateUi) {
      $('#citySearchState').textContent = data.cities?.length ? `${data.cities.length} 项` : '未找到';
      $('#citySearchHint').textContent = data.cities?.length ? '选择搜索结果后即可加载该目的地的实时数据。' : '未在中国范围内找到该地点，请尝试完整城市或区县名。';
    }
    return data.cities || [];
  } catch (error) {
    if (updateUi) { $('#citySearchState').textContent = '失败'; $('#citySearchHint').textContent = error.message; }
    return [];
  }
}

async function chooseCity(value, refresh = true) {
  let city = state.cityCenters[value];
  if (!city) {
    const results = await searchCities(value);
    city = results[0];
  }
  if (!city) throw new Error('请选择中国范围内可验证的城市或目的地');
  state.city = city.name;
  state.cityRef = city;
  $('#citySelect').value = city.name;
  mapView.setCity(state.city);
  updateCityLabels();
  if (refresh) await loadWeather();
  return city;
}

function syncControls() {
  ensureBudgetOption(state.budget);
  $('#citySelect').value = state.city;
  $('#startDate').value = state.startDate;
  $('#daysValue').textContent = state.days;
  $('#budgetSelect').value = String(state.budget);
  $('#styleSelect').value = state.style;
  $('#transportSelect').value = state.transport;
  $('#hotelPreference').value = state.hotelPreference;
  $$('#preferenceChips .chip').forEach(button => button.classList.toggle('active', state.preferences.includes(button.dataset.value)));
  $$('#paceGroup button').forEach(button => button.classList.toggle('active', button.dataset.value === state.pace));
  renderQuickParameters();
}

function renderQuickParameters() {
  if (!$('#quickBudgetValue')) return;
  $('#quickBudgetValue').textContent = state.budget ? `¥${state.budget}` : '不限';
  $('#quickDateValue').textContent = state.startDate || '未设置';
  $('#quickDaysValue').textContent = `${state.days}天`;
  $('#quickPartyValue').textContent = state.partySize ? `${state.partySize}人` : '未设置';
  $('#quickCityValue').textContent = state.city || '未设置';
  $('#quickPreferenceValue').textContent = state.preferences.length ? state.preferences.join('/') : state.style;
  $('#quickPaceValue').textContent = paceText(state.pace);
  $('#quickTransportValue').textContent = state.transport.replace('优先', '').slice(0, 6);
}

function bind() {
  ['#sidebarSettingsButton', '#headerSettingsButton', '#openPromptSettings'].forEach(selector => $(selector)?.addEventListener('click', openSettingsDrawer));
  $('#settingsClose').addEventListener('click', closeSettingsDrawer);
  $('#drawerBackdrop').addEventListener('click', closeSettingsDrawer);
  $('#mobileMenuButton').addEventListener('click', () => $('.travel-sidebar').classList.toggle('mobile-open'));
  $('#sidebarCollapseButton').addEventListener('click', () => {
    if (matchMedia('(max-width: 900px)').matches) {
      $('.travel-sidebar').classList.remove('mobile-open');
      return;
    }
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    $('#sidebarCollapseButton').textContent = collapsed ? '›' : '‹';
    $('#sidebarCollapseButton').setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
  });
  $('#tripSearchInput').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    $$('.history-item').forEach(item => { item.hidden = Boolean(query) && !item.dataset.tripSearch.includes(query); });
    $$('.trip-history-group').forEach(group => {
      const visible = $$('.history-item', group).filter(item => !item.hidden).length;
      group.classList.toggle('search-empty', Boolean(query) && visible === 0);
    });
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); $('#tripSearchInput').focus();
    }
  });
  $$('.prompt-suggestions button').forEach(button => button.addEventListener('click', () => {
    $('#requestText').value = button.dataset.prompt || '';
    $('#requestText').focus();
  }));
  $$('[data-quick-setting]').forEach(button => button.addEventListener('click', () => {
    openSettingsDrawer();
    const target = ({ budget: '#budgetSelect', date: '#startDate', days: '#minusDay', city: '#citySelect', preference: '#preferenceChips', pace: '#paceGroup', transport: '#transportSelect' })[button.dataset.quickSetting];
    if (target) setTimeout(() => $(target)?.focus(), 320);
  }));
  $$('[data-workspace-tab]').forEach(button => button.addEventListener('click', () => switchWorkspaceTab(button.dataset.workspaceTab)));
  $('#citySelect').addEventListener('input', event => {
    clearTimeout(citySearchTimer);
    citySearchTimer = setTimeout(() => searchCities(event.target.value), 350);
  });
  $('#citySelect').addEventListener('change', async event => {
    try { await chooseCity(event.target.value); } catch (error) { toast(error.message); }
  });
  $('#startDate').addEventListener('change', event => { state.startDate = event.target.value; loadWeather(); });
  $('#minusDay').addEventListener('click', () => { state.days = Math.max(1, state.days - 1); syncControls(); });
  $('#plusDay').addEventListener('click', () => { state.days = Math.min(7, state.days + 1); syncControls(); });
  $('#budgetSelect').addEventListener('change', event => { state.budget = Number(event.target.value); syncControls(); });
  $('#styleSelect').addEventListener('change', event => { state.style = event.target.value; syncControls(); });
  $('#transportSelect').addEventListener('change', event => { state.transport = event.target.value; });
  $('#hotelPreference').addEventListener('change', event => { state.hotelPreference = event.target.value; });
  $$('#preferenceChips .chip').forEach(button => button.addEventListener('click', () => { button.classList.toggle('active'); state.preferences = $$('#preferenceChips .chip.active').map(item => item.dataset.value); }));
  $$('#paceGroup button').forEach(button => button.addEventListener('click', () => { state.pace = button.dataset.value; syncControls(); }));
  $('#resetButton').addEventListener('click', () => {
    Object.assign(state, { city: '杭州', cityRef: state.cityCenters['杭州'] || null, startDate: dateAfter(3), days: 3, budget: 1500, style: '自然风景', preferences: ['自然'], pace: 'medium', transport: '公共交通优先', hotelPreference: '交通方便', variant: 'relax', plans: {}, plan: null, previousPlan: null, spots: [], partySize: null, requiredAttractions: [], dayStart: null, dayEnd: null, lodgingArea: null });
    $('#requestText').value = '';
    $('#daysContainer').hidden = true; $('#planFooter').hidden = true; $('#refreshSpots').disabled = true;
    $('#loadingState').hidden = false; $('#loadingState').className = 'loading-state idle';
    $('#loadingState').innerHTML = '<div class="plan-empty-mark" aria-hidden="true">✦</div><div><strong>行程将在你确认需求后生成</strong><span>先填写城市、日期与偏好，再点击“生成智能行程”。页面不会在打开时自动调用 AI。</span></div>';
    $('#spotGrid').innerHTML = '<div class="data-empty">生成行程后，这里会展示本次规划中经过地图核验的景点；没有可靠匹配的图片将保持占位。</div>';
    $('#aiSyncCard').hidden = true; lastFormSyncSignature = '';
    $('#planInsights').hidden = true; $('#planComparison').hidden = true; $('#replanText').value = '';
    state.latestResult = null; state.pendingChange = null; state.pendingReadyResult = null;
    syncControls(); mapView.setCity('杭州'); updateCityLabels(); loadWeather(); closeSettingsDrawer(); setWorkspaceStage('EMPTY');
  });
  $('#newTripButton').addEventListener('click', () => { $('.travel-sidebar').classList.remove('mobile-open'); $('#resetButton').click(); });
  $('#generateButton').addEventListener('click', () => generatePlan());
  $('#dataStageSourcesButton').addEventListener('click', openSourceDialog);
  $('#dataStageContinueButton').addEventListener('click', () => {
    if (!state.pendingReadyResult) return;
    presentValidationResult(state.pendingReadyResult, true);
  });
  $('#openFinalWorkspace').addEventListener('click', () => {
    if (!state.pendingReadyResult) return;
    const result = state.pendingReadyResult;
    state.pendingReadyResult = null;
    applyPlanResult(result, true);
  });
  $('#readyExportButton').addEventListener('click', exportPlan);
  $('#readyShareButton').addEventListener('click', async () => {
    if (!state.plan) return;
    const shareText = `${state.plan.title} · ${state.plan.startDate} · ${state.plan.days} 天`;
    try {
      if (navigator.share) await navigator.share({ title: state.plan.title, text: shareText, url: location.href });
      else { await navigator.clipboard.writeText(`${shareText}\n${location.href}`); toast('行程链接已复制'); }
    } catch (error) { if (error.name !== 'AbortError') toast('分享暂不可用'); }
  });
  $('#readyFavoriteButton').addEventListener('click', event => {
    const active = event.currentTarget.classList.toggle('active');
    event.currentTarget.textContent = active ? '★ 已收藏' : '☆ 收藏';
    toast(active ? '已保存在当前浏览器' : '已取消收藏');
  });
  $$('#variantTabs button[data-variant]').forEach(button => button.addEventListener('click', () => selectVariant(button.dataset.variant)));
  $('#compareVariantsButton').addEventListener('click', () => {
    const matrix = $('#alternativeMatrix');
    const expanded = matrix.classList.toggle('expanded');
    matrix.hidden = !expanded;
    $('#compareVariantsButton').textContent = expanded ? '收起对比' : '方案对比';
  });
  $('#zoomIn').addEventListener('click', () => mapView.zoomBy(1));
  $('#zoomOut').addEventListener('click', () => mapView.zoomBy(-1));
  $('#refreshSpots').addEventListener('click', () => loadSpots(true));
  $('#exportButton').addEventListener('click', exportPlan);
  $('#replanButton').addEventListener('click', replanWithAdjustment);
  $$('.nav-link[data-scroll]').forEach(button => button.addEventListener('click', () => $(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' })));
  $('#openSources').addEventListener('click', openSourceDialog);
  $('#openSourcesInline').addEventListener('click', openSourceDialog);
  $('#agentSend').addEventListener('click', askAgent);
  $('#agentInput').addEventListener('keydown', event => { if (event.key === 'Enter') askAgent(); });
  $('#applyChangeButton').addEventListener('click', applyPendingChange);
  $('#discardChangeButton').addEventListener('click', () => { state.pendingChange = null; setWorkspaceStage('READY'); });
}

function switchWorkspaceTab(tab) {
  $$('[data-workspace-tab]').forEach(button => button.classList.toggle('active', button.dataset.workspaceTab === tab));
  $$('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== tab; panel.classList.toggle('active', panel.dataset.tabPanel === tab); });
  if (tab === 'map') requestAnimationFrame(() => mapView.render());
}

function updateCityLabels() {
  $('#discoverTitle').textContent = `${state.city}景点发现`;
  $('#mapTitle').textContent = `${state.city}路线地图`;
}

function statusLabel(status) {
  return status === 'live' || status === 'ready' || status === 'configured' ? '可用' : status === 'estimate' ? '估算' : status === 'available' ? '可配置' : status === 'unconfigured' ? '未配置' : status === 'unknown' ? '待请求' : '不可用';
}

async function loadHealth() {
  try {
    const [health, providerStatus] = await Promise.all([api('/api/health'), api('/api/providers/status')]);
    state.health = health; state.providerStatus = providerStatus; renderSources();
    const ai = health.ai || {};
    const available = ['live', 'configured'].includes(ai.status);
    $('#topModelDot').className = `status-dot ${available ? 'live' : 'offline'}`;
    $('#topModelStatus').textContent = available ? `元景 · ${ai.model}` : '元景 AI 未配置';
    $('#agentState').textContent = available ? ai.model : '离线';
    $('#agentState').className = `state-label ${available ? 'success' : 'offline'}`;
    $('#agentNote').textContent = ai.note || 'GLM 负责理解与咨询，DeepSeek 负责规划与决策。';
    $('#agentInput').disabled = !available;
    $('#agentSend').disabled = !available;
  } catch (error) {
    $('#sourceList').innerHTML = `<div><span class="source-status offline"></span><b>本地 API 服务</b><small>${esc(error.message)}</small></div>`;
  }
}

function renderSources() {
  const ai = state.health?.ai || {};
  const rows = [{ name: '元景双模型', provider: `${ai.extractionModel || 'GLM-5'} / ${ai.plannerModel || ai.model || 'DeepSeek V4 Pro'}`, status: ai.status, note: ai.note }, ...(state.health?.services || [])];
  $('#sourceList').innerHTML = rows.slice(0, 7).map(row => `<div><span class="source-status ${row.status === 'live' ? 'live' : row.status === 'estimate' ? 'estimate' : row.status === 'offline' ? 'offline' : 'pending'}"></span><b>${esc(row.name)}</b><small>${statusLabel(row.status)}</small></div>`).join('');
  const mcpRows = Object.values(state.providerStatus?.providers || {});
  $('#sourceDialogBody').innerHTML = [...rows.map(row => ({ ...row, group: '运行工具' })), ...mcpRows.map(row => ({ ...row, provider: row.role, note: row.fallback || row.note, group: '可选 MCP' }))]
    .map(row => {
      const active = ['live', 'ready', 'configured'].includes(row.status);
      const available = ['estimate', 'available', 'unknown'].includes(row.status);
      return `<div class="dialog-source-row"><div><strong>${esc(row.name)}</strong><small>${esc(row.group)} · ${esc(row.provider || '')}${row.note ? ` · ${esc(row.note)}` : ''}</small></div><span class="${active ? 'api-connected' : available ? 'api-estimate' : 'api-disconnected'}">${statusLabel(row.status)}</span></div>`;
    }).join('');
  renderEvidenceSourceGrid(rows);
}

function renderEvidenceSourceGrid(rows = []) {
  const root = $('#evidenceSourceGrid');
  if (!root) return;
  const preferred = rows.filter(row => !/双模型|DeepSeek|GLM/i.test(row.name)).slice(0, 6);
  const sourceRows = preferred.length ? preferred : [
    { name: '景点与地图', status: 'unknown', provider: '等待查询' },
    { name: '天气预报', status: 'unknown', provider: '等待查询' },
    { name: '酒店与路线', status: 'unknown', provider: '等待查询' },
  ];
  root.innerHTML = sourceRows.map(row => {
    const live = ['live', 'ready', 'configured'].includes(row.status);
    const unavailable = ['offline', 'unconfigured'].includes(row.status);
    const stateClass = live ? 'live' : unavailable ? 'offline' : 'pending';
    return `<article class="evidence-source-card ${stateClass}"><span class="source-glyph" aria-hidden="true">${live ? '✓' : unavailable ? '!' : '↻'}</span><div><strong>${esc(row.name)}</strong><small>${esc(row.provider || row.note || '等待查询')}</small></div><b>${statusLabel(row.status)}</b></article>`;
  }).join('');
}

function openSourceDialog() { $('#sourceDialog').showModal(); }

async function loadWeather() {
  const requestVersion = ++weatherRequestVersion;
  $('#temperature').textContent = '--°'; $('#weatherDescription').textContent = '加载中';
  $('#weatherIcon').innerHTML = weatherIconSvg(null); $('#weatherIcon').setAttribute('aria-label', '天气加载中');
  try {
    const data = await api(`/api/weather?city=${encodeURIComponent(state.city)}&startDate=${state.startDate}&days=${state.days}`);
    if (requestVersion === weatherRequestVersion) renderWeather(data);
    return data;
  } catch (error) {
    if (requestVersion === weatherRequestVersion) {
      $('#weatherDescription').textContent = '天气接口暂不可用'; $('#weatherRange').textContent = error.message;
    }
    return null;
  }
}

function renderWeather(weather) {
  const forecast = (weather.tripForecast || [])[0];
  const current = weather.current || {};
  $('#weatherSource').textContent = weather.source || '天气服务';
  if (forecast?.quality === 'forecast') {
    $('#weatherIcon').innerHTML = weatherIconSvg(forecast.weatherCode);
    $('#weatherIcon').setAttribute('aria-label', weatherText(forecast.weatherCode));
    $('#temperature').textContent = `${Math.round(forecast.temperatureMax)}°`;
    $('#weatherDescription').textContent = `${weatherText(forecast.weatherCode)} · 出发日 ${forecast.date.slice(5)}`;
    $('#weatherRange').textContent = `最低 ${Math.round(forecast.temperatureMin)}° · 降水 ${Math.round(forecast.precipitationProbability || 0)}%`;
  } else {
    $('#weatherIcon').innerHTML = weatherIconSvg(null);
    $('#weatherIcon').setAttribute('aria-label', '预报范围外');
    $('#temperature').textContent = '未覆盖';
    $('#weatherDescription').textContent = '预报范围外';
    $('#weatherRange').textContent = forecast?.note || '没有用今日天气替代';
  }
  const tips = [];
  if (forecast?.quality === 'unavailable') tips.push('出行日期超出预报范围，路线没有套用当前天气。');
  else if (Number(forecast?.precipitationProbability || 0) >= 60) tips.push('出发日降水概率较高，可选择人文室内优先方案。');
  else tips.push('出发日暂无明显高降水信号，户外节点可按计划保留。');
  if (Number(current.wind_speed_10m || 0) > 25) tips.push('当前风速较高，滨水与高空项目需在出发前复核开放状态。');
  tips.push('未接入官方客流来源，客流保持未知，不由 AI 补写。');
  tips.push('开放时间缺失时显示未知，不进行猜测。');
  $('#tipsList').innerHTML = tips.map(item => `<li>${esc(item)}</li>`).join('');
  renderReadyWeatherSummary(weather);
}

function renderReadyWeatherSummary(weather = {}) {
  const root = $('#readyWeatherSummary');
  if (!root) return;
  const forecasts = (weather.tripForecast || []).slice(0, 4);
  const source = weather.source || '天气来源未知';
  root.innerHTML = `<div class="ready-companion-title"><strong>行程天气</strong><span>${esc(source)}</span></div><div class="ready-weather-days">${forecasts.length ? forecasts.map(day => `<div><i>${weatherIconSvg(day.quality === 'forecast' ? day.weatherCode : null)}</i><span>${esc((day.date || '').slice(5) || '未定')}</span><b>${day.quality === 'forecast' ? `${Math.round(day.temperatureMin)}°–${Math.round(day.temperatureMax)}°` : '未覆盖'}</b></div>`).join('') : '<p>本次没有取得出行日期天气。</p>'}</div>`;
}

async function loadSpots(force = false) {
  $('#spotGrid').innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    const data = await api(`/api/spots?city=${encodeURIComponent(state.city)}&limit=20&startDate=${state.startDate}${force ? `&t=${Date.now()}` : ''}`);
    state.spots = data.spots || [];
    state.spots.forEach(spot => state.spotIndex.set(spot.id, spot));
    renderSpots();
  } catch (error) {
    $('#spotGrid').innerHTML = `<div class="data-empty">景点公开数据暂不可用：${esc(error.message)}</div>`;
  }
}

function renderSpots() {
  const list = state.spots.slice(0, 8);
  if (!list.length) { $('#spotGrid').innerHTML = '<div class="data-empty">没有获取到可展示的景点。</div>'; return; }
  $('#spotGrid').innerHTML = list.map(spot => `<article class="spot-card" data-id="${esc(spot.id)}" tabindex="0" role="button" aria-label="查看${esc(spot.name)}详情"><div class="spot-image"><div class="fallback-art">⌖</div><span class="spot-badge">${esc(spot.requiredByUser ? '用户必选' : spot.category)}</span></div><div class="spot-body"><strong title="${esc(spot.name)}">${esc(spot.name)}</strong><p>${spot.openingHours ? `开放：${esc(spot.openingHours)}` : '开放时间：公开数据未标注'}</p><div class="spot-score"><span>${spot.plannerScore != null ? `可解释评分 ${spot.plannerScore}` : `静态质量 ${spot.staticPoiQuality}`}</span><span>${esc(seasonalText(spot))}</span></div><a class="source-link" href="${esc(spot.sourceUrl)}" target="_blank" rel="noreferrer">景点资料来源</a></div></article>`).join('');
  $$('.spot-card').forEach(card => {
    const spot = state.spotIndex.get(card.dataset.id);
    card.addEventListener('click', event => { if (!event.target.closest('a')) openSpotDetails(spot); });
    card.addEventListener('keydown', event => { if (event.key === 'Enter') openSpotDetails(spot); });
    loadSpotImage(spot, $('.spot-image', card));
  });
}

async function loadSpotImage(spot, holder) {
  if (!holder || !spot) return;
  const excluded = new Set();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const params = new URLSearchParams({ name: spot.name || '', city: state.city || '', wikipedia: spot.wikipedia || '', wikidata: spot.wikidata || '', commons: spot.wikimediaCommons || '', image: spot.image || '', exclude: [...excluded].join(',') });
      const imageData = await api(`/api/image?${params}`);
      if (!imageData.found || !imageData.url) return;
      const image = document.createElement('img');
      // The image is preloaded before it is inserted. A detached lazy image may
      // never start downloading, so it must be eager during this verification.
      image.loading = 'eager'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.alt = spot.name;
      const loaded = await new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => finish(false), 10000);
        image.onload = () => finish(true);
        image.onerror = () => finish(false);
        image.src = imageData.url;
      });
      if (!loaded) {
        if (!imageData.provider || excluded.has(imageData.provider)) return;
        excluded.add(imageData.provider);
        continue;
      }
      spot._image = imageData;
      holder.replaceChildren(image);
      const link = holder.closest('.spot-card')?.querySelector('.source-link');
      if (link) {
        link.href = imageData.photographerUrl || imageData.sourceUrl || link.href;
        link.textContent = imageData.source === 'Unsplash' ? `摄影：${imageData.photographer} · Unsplash` : `${imageData.source || '精确页面图片'}来源`;
      }
      return;
    } catch { return; }
  }
}

function openSpotDetails(spot) {
  if (!spot) return;
  const image = spot._image?.url ? `<img src="${esc(spot._image.url)}" alt="${esc(spot.name)}" />` : '<div class="fallback-art">⌖</div>';
  const reasons = spot.recommendationReasons || ['公开数据完整度与行程匹配度较优'];
  const stops = spot.transitStops || [];
  const crowd = spot.crowd?.score == null ? '未知，没有可验证客流来源' : `透明预测 ${esc(spot.crowd.label)} ${spot.crowd.score}`;
  const imageCredit = spot._image?.source === 'Unsplash' ? `<a href="${esc(spot._image.photographerUrl)}" target="_blank" rel="noreferrer">摄影：${esc(spot._image.photographer)}</a><a href="${esc(spot._image.unsplashUrl)}" target="_blank" rel="noreferrer">图片来自 Unsplash</a>` : '';
  $('#spotDialogBody').innerHTML = `<div class="spot-detail-hero"><div class="spot-detail-image">${image}</div><div class="spot-detail-copy"><span class="section-code">ATTRACTION DETAIL</span><h2>${esc(spot.name)}</h2><p>${esc(spot.requiredByUser ? '用户必选 · ' : '')}${esc(spot.category)} · 建议游玩 ${spot.durationMin} 分钟</p><p>${reasons.map(reason => `✓ ${esc(reason)}`).join('<br>')}</p></div></div><div class="spot-detail-grid"><div class="detail-box"><span>开放时间</span><strong>${esc(spot.openingHours || '未知，出发前请复核')}</strong></div><div class="detail-box"><span>开放校验</span><strong>${esc(spot.openingStatus?.label || '未进入具体行程时段')}</strong></div><div class="detail-box"><span>时令适配</span><strong>${esc(seasonalText(spot))}</strong></div><div class="detail-box"><span>客流</span><strong>${crowd}</strong></div><div class="detail-box"><span>附近交通</span><strong>${stops.length ? stops.slice(0, 2).map(stop => `${esc(stop.name)} ${stop.distanceM}m`).join('<br>') : '未获取到附近已标注站点'}</strong></div><div class="detail-box"><span>数据更新时间</span><strong>${esc((spot.fetchedAt || '未知').replace('T', ' ').slice(0, 19))}</strong></div><div class="detail-box"><span>坐标</span><strong>${Number(spot.lat).toFixed(5)}, ${Number(spot.lng).toFixed(5)}</strong></div></div><div class="spot-detail-links"><a href="${esc(spot.sourceUrl || 'https://www.openstreetmap.org/')}" target="_blank" rel="noreferrer">查看景点数据来源</a>${imageCredit}${spot.website ? `<a href="${esc(spot.website)}" target="_blank" rel="noreferrer">景点网站</a>` : ''}</div>`;
  $('#spotDialog').showModal();
}

let planningLogHistory = {};
let lastFormSyncSignature = '';

function animateSyncedFields(elements) {
  elements.filter(Boolean).forEach(element => {
    element.classList.remove('ai-synced');
    requestAnimationFrame(() => element.classList.add('ai-synced'));
    setTimeout(() => element.classList.remove('ai-synced'), 1200);
  });
}

function applyRequestFormSync(data) {
  if (!data) return;
  const signature = JSON.stringify(data);
  if (signature === lastFormSyncSignature) return;
  lastFormSyncSignature = signature;
  const before = {
    city: state.city, startDate: state.startDate, days: state.days, budget: state.budget, style: state.style,
    preferences: [...state.preferences], pace: state.pace, transport: state.transport,
    hotelPreference: state.hotelPreference,
  };
  if (data.city) state.city = data.city;
  if (data.cityRef) state.cityRef = data.cityRef;
  if (data.startDate) state.startDate = data.startDate;
  if (data.days) state.days = Number(data.days);
  if (data.budget) state.budget = Number(data.budget);
  if (data.style) state.style = data.style;
  if (data.preferences?.length) state.preferences = data.preferences;
  if (data.pace) state.pace = data.pace;
  if (data.transport) state.transport = data.transport;
  if (data.hotelPreference) state.hotelPreference = data.hotelPreference;
  state.partySize = data.partySize ?? null;
  state.requiredAttractions = data.requiredAttractions || [];
  state.dayStart = data.dayStart || null;
  state.dayEnd = data.dayEnd || null;
  state.lodgingArea = data.lodgingArea || null;
  syncControls();
  updateCityLabels();
  mapView.setCity(state.city);

  const duration = `${data.days || state.days}天${data.nights != null ? `${data.nights}晚` : ''}`;
  const dateText = data.endDate ? `${data.startDate} → ${data.endDate}` : data.startDate || '未指定';
  const items = [
    ['目的地', data.city || '未指定', false],
    ['日期', dateText, false],
    ['时长 / 人数', `${duration}${data.partySize ? ` · ${data.partySize}人` : ''}`, false],
    ['每日时段', data.dayStart && data.dayEnd ? `${data.dayStart}—${data.dayEnd}` : '未指定', false],
    ['必选景点', data.requiredAttractions?.length ? data.requiredAttractions.join(' / ') : '未指定', true],
    ['住宿区域', data.lodgingArea || '未指定', true],
  ];
  const card = $('#aiSyncCard');
  $('#aiSyncSource').textContent = data.source || 'GLM-5 需求理解';
  $('#aiSyncFields').innerHTML = items.map(([label, value, wide]) => `<div class="ai-sync-item${wide ? ' wide' : ''}"><span>${esc(label)}</span><strong title="${esc(value)}">${esc(value)}</strong></div>`).join('');
  card.hidden = false;
  card.classList.remove('syncing');
  requestAnimationFrame(() => card.classList.add('syncing'));

  const changed = [];
  if (before.city !== state.city) changed.push($('#citySelect').closest('.select-wrap'));
  if (before.startDate !== state.startDate) changed.push($('#startDate').closest('.select-wrap'));
  if (before.days !== state.days) changed.push($('.counter-control'));
  if (before.budget !== state.budget) changed.push($('#budgetSelect').closest('.select-wrap'));
  if (before.style !== state.style) changed.push($('#styleSelect').closest('.select-wrap'));
  if (before.preferences.join('|') !== state.preferences.join('|')) changed.push($('#preferenceChips'));
  if (before.pace !== state.pace) changed.push($('#paceGroup'));
  if (before.transport !== state.transport) changed.push($('#transportSelect').closest('.select-wrap'));
  if (before.hotelPreference !== state.hotelPreference) changed.push($('#hotelPreference').closest('.select-wrap'));
  animateSyncedFields(changed);
  renderProfileSummary(data);
}

function renderProfileSummary(data) {
  if (!data) return;
  const fields = [
    ['目的地', data.city || '未指定', true],
    ['日期与时长', `${data.startDate || '未指定'} · ${data.days || state.days}天${data.nights != null ? `${data.nights}晚` : ''}`, true],
    ['同行者', data.partySize ? `${data.partySize} 人` : '未指定', false],
    ['偏好', data.preferences?.length ? data.preferences.join(' / ') : data.style || '未指定', false],
    ['必选项', data.requiredAttractions?.length ? data.requiredAttractions.join(' / ') : '未指定', true],
    ['每日时段', data.dayStart && data.dayEnd ? `${data.dayStart}—${data.dayEnd}` : '未指定', true],
    ['住宿区域', data.lodgingArea || '未指定', false],
    ['交通与节奏', `${data.transport || state.transport} · ${paceText(data.pace || state.pace)}`, false],
  ];
  $('#profileSummary').innerHTML = fields.map(([label, value, hard]) => `<div class="profile-chip${hard ? ' hard' : ''}"><span>${hard ? '硬约束 · ' : ''}${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  const duration = `${data.startDate || '日期未指定'} · ${data.days || state.days} 天${data.nights != null ? ` ${data.nights} 晚` : ''}`;
  const preference = data.preferences?.length ? data.preferences.join(' / ') : data.style || '未指定';
  const required = data.requiredAttractions?.length ? data.requiredAttractions.join(' / ') : '未指定';
  $('#profileNodeCity').textContent = data.city || '未指定';
  $('#profileNodeDuration').textContent = duration;
  $('#profileNodeParty').textContent = data.partySize ? `${data.partySize} 人` : '未指定';
  $('#profileNodePreference').textContent = preference;
  $('#profileNodePace').textContent = `${paceText(data.pace || state.pace)} · ${data.transport || state.transport}`;
  $('#profileNodeRequired').textContent = required;
  const groups = [
    ['基础信息', [`目的地：${data.city || '未指定'}`, `日期：${duration}`, `同行：${data.partySize ? `${data.partySize} 人` : '未指定'}`]],
    ['出游偏好', [`偏好：${preference}`, `节奏：${paceText(data.pace || state.pace)}`, `每日：${data.dayStart && data.dayEnd ? `${data.dayStart}—${data.dayEnd}` : '未指定'}`]],
    ['硬约束', [`必选：${required}`, `住宿：${data.lodgingArea || '未指定'}`, `避免：${data.avoidances?.length ? data.avoidances.join(' / ') : '未指定'}`]],
    ['规划约束', [`预算：${data.budget ? `¥${data.budget}` : `¥${state.budget}`}`, `交通：${data.transport || state.transport}`, '缺失事实：保持未知']],
  ];
  $('#profileDetailGrid').innerHTML = groups.map(([title, rows]) => `<article><span>${esc(title)}</span>${rows.map(row => `<p>${esc(row)}</p>`).join('')}</article>`).join('');
  $('#profileCompletion').innerHTML = '<span>✓</span><div><strong>用户画像建立完成</strong><small>硬约束已经锁定，正在连接真实资料工具</small></div><b>下一步：资料搜集 →</b>';
}

function renderLiveEvidenceStage(entry) {
  const items = entry?.items || [];
  const isRoute = entry?.phase === 'route';
  $('#dataStageHeadline').textContent = isRoute ? '正在计算景点之间的真实路线' : '正在联网搜集本次旅行资料';
  $('#dataStageSubline').textContent = '每个来源只显示真实连接状态；没有取得的开放、客流与价格信息会保持未知。';
  $('#dataStageContinueButton').hidden = true;
  $('#liveCandidateStrip').classList.remove('completed');
  $('#dataMiniRouteMap').innerHTML = '<span>路线数据返回后显示景点分布</span>';
  $('#liveDiscoveryState').textContent = isRoute ? '候选已返回，正在计算顺路程度' : '正在等待本次地图候选';
  $('#liveCandidateStrip').innerHTML = items.length
    ? items.slice(0, 6).map(item => `<div class="live-candidate-row"><span>${item.startsWith('✓') ? '✓' : item.startsWith('○') ? '○' : '…'}</span><b>${esc(item.replace(/^[✓●○…]\s*/, ''))}</b></div>`).join('')
    : '<div class="stage-empty">工具尚未返回可展示的数据。</div>';
  $('#liveRouteDraft').textContent = isRoute
    ? '已取得候选点位，正在计算景点间道路路线、每日顺序与交通缓冲。'
    : '候选景点返回后才计算景点间路线，不预先绘制虚构轨迹。';
  $('#liveCompilerState').textContent = isRoute
    ? '正在核对必选景点、开放时间、每日时段和最小缓冲。'
    : '等待路线、开放时间和硬约束数据。';
  const knownRisk = items.some(item => /客流|拥挤|天气|预约/.test(item) && item.startsWith('✓'));
  $('#liveRiskChart').classList.toggle('empty', !knownRisk);
  $('#liveRiskCopy').textContent = knownRisk
    ? '相关工具已返回状态，具体值将在候选方案校验页按来源标注。'
    : '尚未取得可核验的客流或预约结果；此处不显示固定曲线。';
  renderEvidenceSourceGrid([{ name: '景点与地图', provider: '本次任务', status: entry?.phase === 'live' || isRoute ? 'live' : 'unknown' }, { name: '天气预报', provider: '本次任务', status: entry?.phase === 'live' || isRoute ? 'live' : 'unknown' }, { name: '酒店与交通', provider: '本次任务', status: isRoute ? 'live' : 'unknown' }]);
}

function sourceStatusFromLabel(label = '') {
  const value = String(label);
  if (!value || /未知|未返回|不可用|未配置|超时|fallback/i.test(value)) return 'unknown';
  return 'live';
}

function completedSourceRows(plan) {
  const labels = [
    ['景点与地图', plan.dataSources?.spots],
    ['路线与道路', plan.dataSources?.routing],
    ['公共交通', plan.dataSources?.transit],
    ['天气预报', plan.dataSources?.weather],
    ['酒店查询', plan.dataSources?.hotels],
    ['客流与开放', plan.dataSources?.crowd],
  ];
  return labels.map(([name, provider]) => ({ name, provider: provider || '本次未取得来源', status: sourceStatusFromLabel(provider) }));
}

function renderCompletedEvidenceRisk(plan) {
  const facts = (plan.travelFacts || []).filter(fact => fact.field === '拥挤风险');
  const known = facts.filter(fact => ['predicted', 'verified'].includes(fact.status) && Number.isFinite(Number(fact.value?.score))).slice(0, 4);
  const chart = $('#liveRiskChart');
  chart.classList.toggle('empty', !known.length);
  chart.innerHTML = known.length
    ? known.map(fact => `<i style="height:${Math.max(6, Math.min(94, Number(fact.value.score)))}%"><b>${Math.round(Number(fact.value.score))}</b></i>`).join('')
    : '<i></i><i></i><i></i><i></i><span>没有来源时保持未知</span>';
  $('#liveRiskCopy').textContent = known.length
    ? `${known.length} 个候选节点取得可追溯的拥挤预测；预测不等于实时人数。`
    : '本次没有取得可追溯的拥挤数值，因此不显示固定曲线。';
}

function renderCompletedEvidenceStage(result) {
  const plan = state.plans[state.variant] || result.alternatives[0];
  const spots = [...new Map((plan.daysPlan || []).flatMap(day => day.items || []).map(spot => [spot.id, spot])).values()];
  const facts = plan.travelFacts || [];
  const knownFacts = facts.filter(fact => fact.status !== 'unknown').length;
  $('#dataStageHeadline').textContent = '资料搜集完成，候选路线已经形成';
  $('#dataStageSubline').textContent = `取得 ${spots.length} 个入选景点、${facts.length} 条旅行事实，其中 ${knownFacts} 条有来源或估算状态。`;
  $('#dataStageContinueButton').hidden = false;
  renderEvidenceSourceGrid(completedSourceRows(plan));
  $('#liveDiscoveryState').textContent = `${spots.length} 个点位进入当前候选方案`;
  $('#liveCandidateStrip').classList.add('completed');
  $('#liveCandidateStrip').innerHTML = spots.slice(0, 5).map((spot, index) => `<article class="completed-spot-card"><div class="completed-spot-thumb" data-completed-spot="${esc(spot.id)}"><span>${index + 1}</span></div><div><b title="${esc(spot.name)}">${esc(spot.name)}</b><small>${esc(spot.requiredByUser ? '用户必选' : spot.category || '已核验点位')}</small></div></article>`).join('') || '<div class="stage-empty">本次没有形成可展示的景点候选。</div>';
  $$('[data-completed-spot]').forEach(holder => loadSpotImage(state.spotIndex.get(holder.dataset.completedSpot), holder));
  renderCompletedEvidenceRisk(plan);
  const routeNodes = spots.slice(0, 4);
  $('#dataMiniRouteMap').innerHTML = routeNodes.length
    ? `<div class="data-mini-nodes" aria-label="候选景点路线示意；最终地图使用真实坐标">${routeNodes.map((spot, index) => `<i class="data-mini-node" title="${esc(spot.name)}">${index + 1}</i>`).join('')}</div><span>${plan.days} 天路线分区草图</span>`
    : '<span>尚无可展示点位</span>';
  $('#liveRouteDraft').innerHTML = (plan.daysPlan || []).map(day => `<span class="data-route-day"><b>Day ${day.day}</b>${day.items.map(item => esc(item.name)).join(' → ') || '未生成景点'}<small>${formatDistance(day.route?.distance || 0)} · ${formatDuration(day.route?.duration || 0)}</small></span>`).join('');
  $('#liveCompilerState').innerHTML = `<b>${esc(plan.compiler?.status || '已完成初检')}</b><span>硬约束满足 ${plan.evaluation?.constraintSatisfaction ?? '—'}% · 路线可靠性 ${plan.compiler?.reliability ?? '—'} · 关键未知 ${plan.uncertainty?.importantCount ?? '—'} 项</span>`;
}

function presentCompletedEvidenceResult(result, scroll = true) {
  preparePlanResult(result);
  state.pendingReadyResult = result;
  setWorkspaceStage('FETCHING_DATA');
  renderCompletedEvidenceStage(result);
  if (scroll) $('#activeStage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPlanningProgress(entry) {
  if (entry?.formSync) applyRequestFormSync(entry.formSync);
  if (entry?.phase) planningLogHistory[entry.phase] = entry;
  if (entry?.phase === 'analysis') setWorkspaceStage('BUILDING_PROFILE');
  if (entry?.phase === 'live') setWorkspaceStage('FETCHING_DATA');
  if (entry?.phase === 'route') setWorkspaceStage('GENERATING_ITINERARY');
  if (entry?.phase === 'live' || entry?.phase === 'route') renderLiveEvidenceStage(entry);
  const order = ['analysis', 'live', 'route'];
  const logRows = order.filter(key => planningLogHistory[key]).flatMap(key => {
    const section = planningLogHistory[key];
    return (section.items || []).map(item => `<div class="agent-log-row"><span>${esc(section.title.replace(/……|\.\.\./g, ''))}</span><b>${esc(item.replace(/^[✓●○…]\s*/, ''))}</b><span>${item.startsWith('✓') ? '完成' : item.startsWith('●') || item.startsWith('…') ? '进行中' : '说明'}</span></div>`);
  });
  $('#agentLog').innerHTML = `${logRows.join('')}<small class="log-truth-note">仅展示输入解析、工具调用和约束校验状态，不展示或伪造模型内部思维链。</small>`;
}

function startPlanningProgress() {
  planningLogHistory = {};
  lastFormSyncSignature = '';
  state.pendingReadyResult = null;
  $('#aiSyncCard').hidden = true;
  $('#requestEcho').textContent = $('#requestText').value.trim() || '未输入补充文案，使用旅行参数进行规划。';
  $('#profileSummary').innerHTML = '<div class="data-empty">GLM-5 正在把原始文案整理为目的地、日期、人数、偏好与硬约束。</div>';
  ['profileNodeCity', 'profileNodeDuration', 'profileNodeParty', 'profileNodePreference', 'profileNodePace', 'profileNodeRequired'].forEach(id => { $(`#${id}`).textContent = '识别中'; });
  $('#profileDetailGrid').innerHTML = '<div class="stage-empty">GLM-5 正在把原始文字整理为结构化画像，尚未返回的字段保持“识别中”。</div>';
  $('#profileCompletion').innerHTML = '<span>…</span><div><strong>正在建立用户画像</strong><small>画像完成后将自动进入资料搜集</small></div><b>等待 GLM-5</b>';
  setWorkspaceStage('BUILDING_PROFILE');
  renderPlanningProgress({ phase: 'analysis', title: '正在分析您的需求……', items: ['… GLM-5 正在整理目的地、日期、人数、必选景点和限制条件'] });
}

function stopPlanningProgress() {
  planningLogHistory = {};
}

async function waitForPlanJob(jobId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const job = await api(`/api/plan/status?id=${encodeURIComponent(jobId)}`);
    if (job.progressHistory?.length) job.progressHistory.forEach(entry => renderPlanningProgress(entry));
    else if (job.progress) renderPlanningProgress(job.progress);
    if (job.status === 'done') {
      return job.result;
    }
    if (job.status === 'error') throw new Error(job.error?.message || '规划任务失败');
    await new Promise(resolve => setTimeout(resolve, 850));
  }
  throw new Error('规划任务等待超时，请稍后重试');
}

async function generatePlan(scroll = true, options = {}) {
  const button = $('#generateButton');
  const isPreview = Boolean(options.previewAdjustment);
  const previousPlan = state.plan;
  button.disabled = true; $('span', button).textContent = isPreview ? '正在生成调整' : '正在计算';
  if (!isPreview) {
    if (state.plan) state.previousPlan = state.plan;
    state.plan = null; state.plans = {}; state.spots = []; state.spotIndex = new Map();
    $('#planInsights').hidden = true; $('#planComparison').hidden = true;
    $('#planTitle').textContent = '正在根据新需求规划'; $('#planMeta').textContent = '等待工具返回';
    $('#spotGrid').innerHTML = '<div class="data-empty">正在等待本次规划的已验证景点，不显示上一次行程数据。</div>';
    $('#refreshSpots').disabled = true; mapView.setData([], []); renderHotel({});
    $('#daysContainer').hidden = true; $('#planFooter').hidden = true;
  }
  $('#loadingState').hidden = false;
  try {
    await chooseCity($('#citySelect').value || state.city, false);
    weatherRequestVersion += 1;
    $('#discoverTitle').textContent = '本次景点发现（等待解析目的地）';
    $('#mapTitle').textContent = '本次路线地图（等待解析目的地）';
    $('#weatherIcon').innerHTML = weatherIconSvg(null); $('#weatherIcon').setAttribute('aria-label', '等待解析本次出发日');
    $('#temperature').textContent = '—'; $('#weatherDescription').textContent = '等待解析本次出发日';
    $('#weatherRange').textContent = '不会沿用上一次日期的天气';
    $('#tipsList').innerHTML = '<li>正在解析本次需求中的日期与数据可用范围。</li><li>未接入官方来源时，客流和预约状态会保持未知。</li>';
    const baseRequest = $('#requestText').value.trim();
    const freeText = isPreview ? `${baseRequest}${baseRequest ? '\n\n' : ''}在现有行程基础上执行以下调整，并尽量保持没有被点名的日期不变：${options.previewAdjustment}` : baseRequest;
    const replanContext = isPreview && previousPlan ? {
      adjustment: options.previewAdjustment,
      activeVariant: previousPlan.variant,
      days: previousPlan.daysPlan.map(day => ({ day: day.day, spotIds: day.items.map(item => item.id) })),
    } : null;
    const payload = { city: state.city, cityRef: state.cityRef, startDate: state.startDate, days: state.days, budget: state.budget, style: state.style, preferences: state.preferences, pace: state.pace, variant: state.variant, transport: state.transport, hotelPreference: state.hotelPreference, freeText, replanContext };
    startPlanningProgress();
    const started = await api('/api/plan/start', { method: 'POST', body: JSON.stringify(payload) });
    if (started.progress?.phase !== 'queued') renderPlanningProgress(started.progress);
    const result = await waitForPlanJob(started.jobId);
    if (result.request) {
      state.city = result.request.city || state.city;
      state.cityRef = result.alternatives?.[0]?.cityRef || state.cityRef;
      state.startDate = result.request.startDate || state.startDate;
      state.days = Number(result.request.days || state.days);
      state.budget = Number(result.request.budget || state.budget);
      syncControls(); updateCityLabels();
    }
    if (isPreview && previousPlan) {
      state.pendingChange = { result, adjustment: options.previewAdjustment, before: previousPlan, originalRequest: baseRequest };
      const after = result.alternatives.find(plan => plan.id === previousPlan.variant) || result.alternatives[0];
      renderChangePreview(previousPlan, after, options.previewAdjustment);
      setWorkspaceStage('READY');
      $('#changePreviewDialog').showModal();
    } else presentCompletedEvidenceResult(result, scroll);
  } catch (error) {
    stopPlanningProgress();
    if (isPreview && previousPlan) setWorkspaceStage('READY'); else setWorkspaceStage('ERROR');
    $('#loadingState').className = 'loading-state';
    $('#loadingState').innerHTML = `<div class="load-error"><strong>规划工具暂时不可用</strong><p>${esc(error.message)}</p><button class="secondary-button" id="retryPlan" type="button">重试</button></div>`;
    $('#retryPlan').addEventListener('click', () => generatePlan(false, options));
    mapView.setCity(state.city); toast('行程规划失败，已保留输入条件');
  } finally {
    if (state.plan) stopPlanningProgress();
    button.disabled = false; $('span', button).textContent = '交给智能体规划';
  }
}

function variantLabel(id) {
  return id === 'relax' ? '舒适版' : id === 'hot' ? '精华版' : '错峰版';
}

function preparePlanResult(result) {
  if (!result?.alternatives?.length) throw new Error('规划结果缺少候选方案');
  state.latestResult = result;
  state.plans = Object.fromEntries(result.alternatives.map(plan => [plan.id, plan]));
  const discovered = new Map();
  result.alternatives.flatMap(plan => plan.daysPlan || []).flatMap(day => day.items || []).forEach(spot => discovered.set(spot.id, spot));
  state.spots = [...discovered.values()];
  state.spotIndex = new Map(state.spots.map(spot => [spot.id, spot]));
  if (!state.plans[state.variant]) state.variant = result.activeId && state.plans[result.activeId] ? result.activeId : result.alternatives[0].id;
}

function renderValidationCrowd(plan) {
  const root = $('#validationCrowd');
  const facts = (plan.travelFacts || []).filter(fact => fact.field === '拥挤风险');
  const known = facts.filter(fact => ['predicted', 'verified'].includes(fact.status) && Number.isFinite(Number(fact.value?.score))).slice(0, 8);
  if (!known.length) {
    root.innerHTML = '<div class="stage-card-title"><strong>客流风险</strong><span>未知</span></div><div class="validation-unknown-chart"><i></i><i></i><i></i><p>没有取得可追溯的实时客流或预测值，因此不绘制曲线。</p></div>';
    return;
  }
  const width = 300, height = 104, pad = 18;
  const points = known.map((fact, index) => {
    const x = known.length === 1 ? width / 2 : pad + index * ((width - pad * 2) / (known.length - 1));
    const score = Math.max(0, Math.min(100, Number(fact.value.score)));
    const y = height - pad - score * ((height - pad * 2) / 100);
    return { x, y, score, label: fact.subject };
  });
  root.innerHTML = `<div class="stage-card-title"><strong>客流风险</strong><span>${known.length} 个可追溯点</span></div><svg class="validation-risk-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="候选景点拥挤风险分数曲线"><path class="risk-grid" d="M${pad} ${height - pad}H${width - pad}M${pad} ${height / 2}H${width - pad}"/><polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}"/><g>${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${esc(point.label)}：${point.score}</title></circle>`).join('')}</g></svg><div class="risk-plot-labels">${points.map(point => `<span title="${esc(point.label)}">${esc(point.label)}</span>`).join('')}</div><p>预测不等于实时人数；详情在“拥挤风险”页签中按来源标注。</p>`;
}

function renderValidationStage(result) {
  const comparison = result.alternativeComparison || [];
  const plans = result.alternatives || [];
  const rows = comparison.length ? comparison : plans.map(plan => ({ id: plan.id, title: plan.title, strategy: plan.optimization?.strategy, reliability: plan.compiler?.reliability, fragility: plan.fragility?.score, transportMinutes: plan.evaluation?.evidence?.transportMinutes, minBufferMinutes: plan.compiler?.minBufferMinutes }));
  $('#validationCandidateGrid').innerHTML = rows.map(item => `<button class="validation-candidate${item.id === state.variant ? ' active' : ''}" data-validation-variant="${esc(item.id)}" type="button"><span>${variantLabel(item.id)}</span><strong>${esc(item.title || '候选方案')}</strong><small>${esc(item.strategy || '同一组真实候选数据下的差异化排序')}</small><div><b>可靠性 ${item.reliability ?? '—'}</b><b>脆弱性 ${item.fragility ?? '—'}</b><b>交通 ${item.transportMinutes ?? '—'} 分</b><b>缓冲 ${item.minBufferMinutes ?? '—'} 分</b></div></button>`).join('');
  $$('[data-validation-variant]').forEach(button => button.addEventListener('click', () => { state.variant = button.dataset.validationVariant; renderValidationStage(result); }));
  const plan = state.plans[state.variant] || plans[0];
  const compiler = plan.compiler || {};
  const verification = plan.minimumVerification || [];
  const stress = plan.stressTest?.scenarios || [];
  const facts = plan.travelFacts || [];
  const verifiedCount = facts.filter(fact => fact.status === 'verified').length;
  const unknownCount = facts.filter(fact => fact.status === 'unknown').length;
  const reliability = Number.isFinite(Number(compiler.reliability)) ? Math.max(0, Math.min(100, Number(compiler.reliability))) : 0;
  $('#validationCompiler').innerHTML = `<div class="stage-card-title"><strong>Travel Compiler</strong><span>${esc(compiler.status || '已完成')}</span></div><div class="compiler-score"><div style="--compiler-score:${reliability}"><strong>${compiler.reliability ?? '—'}</strong><span>/100</span></div><p>${esc(compiler.note || '基于工具事实和硬约束计算，不是模型自评分。')}</p></div><ul><li>硬约束满足：${plan.evaluation?.constraintSatisfaction ?? '—'}%</li><li>信息完整度：${compiler.informationCompleteness ?? '—'}%</li><li>最小缓冲：${compiler.minBufferMinutes ?? '—'} 分钟</li></ul>`;
  $('#validationIssues').innerHTML = `<div class="stage-card-title"><strong>问题、未知与自动修复</strong><span>${verification.length} 项需核验</span></div><div class="validation-list">${verification.length ? verification.slice(0, 5).map(item => `<article><i>${item.rank}</i><div><b>${esc(item.subject)} · ${esc(item.field)}</b><p>${esc(item.action)} · ${esc(item.impact)}</p></div></article>`).join('') : '<p class="validation-ok">当前没有进入最低核验清单的关键未知项。</p>'}</div><div class="stress-summary"><b>情景压力测试</b><span>${plan.stressTest?.resilientCount ?? 0} / ${stress.length} 个情景可吸收</span><small>这是情景模拟，不是对真实延误或闭园的预测。</small></div>`;
  $('#validationEvidence').innerHTML = `<div class="stage-card-title"><strong>数据依据</strong><span>${facts.length} 条事实</span></div><div class="evidence-totals"><div><b>${verifiedCount}</b><span>已验证</span></div><div><b>${facts.length - verifiedCount - unknownCount}</b><span>估算 / 预测</span></div><div><b>${unknownCount}</b><span>保持未知</span></div></div><div class="validation-fact-list">${facts.slice(0, 6).map(fact => `<p><span class="fact-state ${esc(fact.status)}">${factStatusLabel(fact.status)}</span><b>${esc(fact.subject)}</b> · ${esc(fact.field)}</p>`).join('')}</div>`;
  renderValidationCrowd(plan);
  $('#validationRoute').innerHTML = `<div class="stage-card-title"><strong>路线摘要</strong><span>${plan.days} 天</span></div>${(plan.daysPlan || []).map(day => `<div class="validation-day-route"><b>Day ${day.day}</b><span>${day.items.map(item => esc(item.name)).join(' → ') || '未生成景点'}</span><small>${formatDistance(day.route?.distance || 0)} · ${formatDuration(day.route?.duration || 0)}</small></div>`).join('')}`;
}

function presentValidationResult(result, scroll = true) {
  preparePlanResult(result);
  state.pendingReadyResult = result;
  setWorkspaceStage('VALIDATING_ITINERARY');
  renderValidationStage(result);
  if (scroll) $('#activeStage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function applyPlanResult(result, scroll = true) {
  preparePlanResult(result);
  state.pendingReadyResult = null;
  setWorkspaceStage('READY');
  renderSpots(); $('#refreshSpots').disabled = false;
  selectVariant(state.plans[state.variant] ? state.variant : (result.activeId || result.alternatives[0].id), false);
  renderAlternativeMatrix(result.alternativeComparison || []);
  storeTripHistory(state.plan);
  if (scroll) $('#readyStage').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectVariant(variant, showToast = true) {
  state.variant = variant;
  $$('#variantTabs button').forEach(button => button.classList.toggle('active', button.dataset.variant === variant));
  if (!state.plans[variant]) return;
  state.plan = state.plans[variant];
  state.plan.daysPlan.flatMap(day => day.items).forEach(spot => state.spotIndex.set(spot.id, spot));
  renderPlan(state.plan);
  renderAlternativeMatrix(state.latestResult?.alternativeComparison || []);
  if (showToast) toast(`已切换到${variant === 'relax' ? '舒适版' : variant === 'hot' ? '精华版' : '错峰版'}`);
}

function renderPlan(plan) {
  stopPlanningProgress();
  setWorkspaceStage('READY');
  $('#loadingState').hidden = true; $('#daysContainer').hidden = false; $('#planFooter').hidden = false;
  const variantName = plan.variant === 'relax' ? '舒适版' : plan.variant === 'hot' ? '精华版' : '错峰版';
  $('#readyTripTitle').textContent = `${plan.city} · ${plan.days} 日游`;
  $('#readyTripMeta').textContent = [plan.startDate, state.partySize ? `${state.partySize} 人` : '', state.lodgingArea ? `住 ${state.lodgingArea}` : '', `预算约 ¥${state.budget}`].filter(Boolean).join(' · ');
  $('#planTitle').textContent = `${plan.title} · ${variantName}`;
  $('#planMeta').textContent = `${plan.startDate} 出发 · ${plan.days} 天 · ${plan.generatedAt.slice(0, 19).replace('T', ' ')} 更新`;
  $('#daysContainer').innerHTML = plan.daysPlan.map(day => renderDay(day)).join('');
  bindRenderedPlanInteractions();
  loadTimelineImages(plan);
  const source = plan.dataSources;
  $('#sourceCaption').textContent = `天气：${source.weather}；景点：${source.spots}；酒店：${source.hotels || '未知'}；路线：${source.routing}；交通：${source.transit}；客流：${source.crowd}`;
  renderBudget(plan.budgetBreakdown);
  renderHotel(plan.hotelPlan);
  renderWeather(plan.weather);
  renderMapFromPlan(plan);
  renderPlanInsights(plan);
  $('#planInsights').hidden = true;
  renderPlanComparison(state.previousPlan, plan);
  renderTripHealth(plan);
  renderDecisionEvidence(plan);
  loadDiningForPlan(plan);
  toast('三套差异化行程已一次生成');
}

function renderAlternativeMatrix(rows) {
  const root = $('#alternativeMatrix');
  const data = rows.length ? rows : Object.values(state.plans).map(plan => ({
    id: plan.id, title: plan.title, reliability: plan.compiler?.reliability, fragility: plan.fragility?.score,
    transportMinutes: plan.evaluation?.evidence?.transportMinutes, minBufferMinutes: plan.compiler?.minBufferMinutes,
  }));
  if (!data.length) { root.hidden = true; return; }
  root.innerHTML = data.map(item => `<article class="alternative-card${item.id === state.variant ? ' active' : ''}"><strong>${esc(item.id === 'relax' ? '舒适版' : item.id === 'hot' ? '精华版' : '错峰版')} · ${esc(item.title)}</strong><small>${esc(item.strategy || '同一组真实候选数据下的差异化排序')}</small><div class="alternative-metrics"><span>可靠性 <b>${item.reliability ?? '—'}</b></span><span>脆弱性 <b>${item.fragility ?? '—'}</b></span><span>交通 <b>${item.transportMinutes ?? '—'} 分</b></span><span>最小缓冲 <b>${item.minBufferMinutes ?? '—'} 分</b></span></div></article>`).join('');
  root.hidden = !root.classList.contains('expanded');
}

function renderTripHealth(plan) {
  const compiler = plan.compiler || {};
  const facts = plan.travelFacts || [];
  const crowdFacts = facts.filter(fact => fact.field === '拥挤风险');
  const crowdKnown = crowdFacts.filter(fact => fact.status !== 'unknown').length;
  const distance = (plan.daysPlan || []).reduce((sum, day) => sum + Number(day.route?.distance || 0), 0);
  const knownBudget = plan.budgetBreakdown?.knownEstimate;
  const satisfaction = plan.evaluation?.constraintSatisfaction;
  $('#tripHealth').innerHTML = `<article class="health-metric"><span>需求匹配</span><strong>${satisfaction ?? '—'}${satisfaction == null ? '' : '%'}</strong><small>硬约束覆盖</small></article><article class="health-metric"><span>已知花费</span><strong>${knownBudget == null ? '—' : `¥${knownBudget}`}</strong><small>未取到的价格不计入</small></article><article class="health-metric"><span>道路里程</span><strong>${distance ? formatDistance(distance) : '—'}</strong><small>真实路线累计</small></article><article class="health-metric${crowdFacts.length && !crowdKnown ? ' warning' : ''}"><span>客流风险</span><strong>${crowdKnown ? `${crowdKnown}点` : '未知'}</strong><small>不冒充实时人数</small></article><article class="health-metric"><span>行程节奏</span><strong>${esc(paceText(state.pace))}</strong><small>${compiler.minBufferMinutes ?? '—'} 分钟最小缓冲</small></article><article class="health-metric${Number(compiler.reliability || 0) < 60 ? ' danger' : ''}"><span>路线可靠性</span><strong>${compiler.reliability ?? '—'}</strong><small>Travel Compiler</small></article>`;
}

function renderPlanInsights(plan) {
  const root = $('#planInsights');
  const evaluation = plan.evaluation || {};
  const compiler = plan.compiler || {};
  const fragility = plan.fragility || {};
  const verification = plan.minimumVerification || [];
  const stress = plan.stressTest?.scenarios || [];
  const critical = plan.criticalPath?.nodes || [];
  const candidates = plan.candidatePool || [];
  root.innerHTML = `<div class="trust-overview"><article class="trust-card"><span>硬约束满足</span><strong>${evaluation.constraintSatisfaction ?? '—'}%</strong><small>必选景点覆盖与天数检查</small></article><article class="trust-card"><span>信息完整度</span><strong>${compiler.informationCompleteness ?? '—'}%</strong><small>已验证 / 估算事实占比</small></article><article class="trust-card"><span>压力测试韧性</span><strong>${plan.stressTest?.resilientCount ?? '—'} / ${stress.length || '—'}</strong><small>明确标注为情景模拟</small></article></div><div class="trust-sections"><section class="trust-section"><div class="trust-title"><strong>最低核验清单</strong><span>${verification.length} 项</span></div><div class="verification-list">${verification.length ? verification.map(item => `<div class="verification-row"><b>${item.rank}. ${esc(item.subject)} · ${esc(item.field)}</b><br><em>${esc(item.action)}</em> · ${esc(item.impact)}</div>`).join('') : '<div class="verification-row">当前没有进入最低核验清单的关键未知项。</div>'}</div></section><section class="trust-section"><div class="trust-title"><strong>脆弱性与关键路径</strong><span>${fragility.score ?? '—'} / 100</span></div><div class="critical-list">${critical.length ? critical.map(item => `<div class="critical-row"><b>${esc(item.name)}</b><br>${esc(item.reason)}</div>`).join('') : '<div class="critical-row">未识别到明显关键节点。</div>'}</div></section><section class="trust-section wide"><div class="trust-title"><strong>压力测试</strong><span>${esc(plan.stressTest?.label || '情景模拟（不是实时预测）')}</span></div><div class="stress-list">${stress.map(item => `<div class="stress-row"><div><b>${esc(item.name)}</b><br>${esc(item.note)} · ${esc(item.basis)}</div><span class="stress-badge ${esc(item.outcome)}">${item.outcome === 'resilient' ? '可吸收' : item.outcome === 'repairable' ? '可修复' : '脆弱'}</span></div>`).join('')}</div></section><section class="trust-section wide candidate-panel-v2"><div class="trust-title"><strong>候选池与计算依据</strong><span>${esc(plan.optimization?.algorithm || '')}</span></div><details><summary>查看 ${candidates.length} 个候选景点及其入选状态</summary><div class="candidate-list">${candidates.map(item => `<div class="candidate-chip${item.selected ? ' selected' : ''}${item.requiredByUser ? ' required' : ''}" title="${esc(item.scoreBasis || '')}"><b>${esc(item.name)}</b>${item.score}分 · ${item.selected ? '已入选' : '候选'}${item.requiredByUser ? ' · 必选' : ''}</div>`).join('')}</div></details></section></div>`;
  root.hidden = false;
}

function renderPlanComparison(before, after) {
  const root = $('#planComparison');
  if (!before?.evaluation || !after?.evaluation || before.generatedAt === after.generatedAt) { root.hidden = true; return; }
  const rows = [
    ['综合评分', before.evaluation.overall, after.evaluation.overall],
    ['交通分钟', before.evaluation.evidence.transportMinutes, after.evaluation.evidence.transportMinutes],
    ['入选景点', before.evaluation.evidence.selectedCount, after.evaluation.evidence.selectedCount],
    ['硬约束', `${before.evaluation.constraintSatisfaction}%`, `${after.evaluation.constraintSatisfaction}%`],
  ];
  root.innerHTML = `<strong>已按新要求完成真实重新规划</strong><div class="comparison-grid">${rows.map(([label, oldValue, newValue]) => `<div>${esc(label)}<b>${esc(oldValue)} → ${esc(newValue)}</b></div>`).join('')}</div>`;
  root.hidden = false;
}

function factStatusLabel(status) {
  return ({ verified: '已验证', estimated: '估算', predicted: '预测', unknown: '未知', conflicting: '冲突', stale: '过期' })[status] || status || '未知';
}

function renderDecisionEvidence(plan) {
  const facts = plan.travelFacts || [];
  const crowdFacts = facts.filter(fact => fact.field === '拥挤风险');
  const knownCrowdFacts = crowdFacts.filter(fact => ['predicted', 'verified'].includes(fact.status) && Number.isFinite(Number(fact.value?.score))).slice(0, 8);
  let crowdChart = '<div class="crowd-chart-unknown"><span>?</span><p>没有可追溯数值，不绘制曲线。</p></div>';
  if (knownCrowdFacts.length) {
    const width = 360, height = 126, pad = 20;
    const points = knownCrowdFacts.map((fact, index) => {
      const x = knownCrowdFacts.length === 1 ? width / 2 : pad + index * ((width - pad * 2) / (knownCrowdFacts.length - 1));
      const score = Math.max(0, Math.min(100, Number(fact.value.score)));
      const y = height - pad - score * ((height - pad * 2) / 100);
      return { x, y, score, label: fact.subject };
    });
    crowdChart = `<div class="crowd-chart-wrap"><svg class="crowd-risk-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="可追溯拥挤风险分数曲线"><path class="risk-grid" d="M${pad} ${height - pad}H${width - pad}M${pad} ${height / 2}H${width - pad}"/><polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}"/><g>${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="4"><title>${esc(point.label)}：${point.score}</title></circle>`).join('')}</g></svg><div class="risk-plot-labels">${points.map(point => `<span title="${esc(point.label)}">${esc(point.label)}</span>`).join('')}</div></div>`;
  }
  $('#crowdRiskPanel').innerHTML = `<div class="crowd-summary"><strong>拥挤风险，不冒充实时客流</strong><span>${knownCrowdFacts.length ? `${knownCrowdFacts.length} 个节点有可追溯预测，其余保持未知。预测不等于实时人数。` : '本次没有取得可验证的实时客流或可靠预测输入，因此全部显示未知；系统不会用固定数字填充。'}</span></div>${crowdChart}${crowdFacts.map(fact => `<div class="crowd-fact"><div><b>${esc(fact.subject)}</b><br>${esc(fact.uncertaintyReason || fact.sourceName)}</div><span class="fact-state ${esc(fact.status)}">${factStatusLabel(fact.status)}</span></div>`).join('')}`;
  $('#readyCrowdSummary').innerHTML = `<div class="ready-companion-title"><strong>客流风险趋势</strong><span>${knownCrowdFacts.length ? `${knownCrowdFacts.length} 个可追溯节点` : '本次保持未知'}</span></div>${crowdChart}<p>预测不等于实时人数，出发前请按来源复核。</p>`;
  const sorted = [...facts].sort((a, b) => ({ high: 3, medium: 2, low: 1 }[b.importance] || 0) - ({ high: 3, medium: 2, low: 1 }[a.importance] || 0));
  const verification = plan.minimumVerification || [];
  const stress = plan.stressTest?.scenarios || [];
  $('#evidencePanelList').innerHTML = `<div class="crowd-summary"><strong>证据状态 ${facts.length} 条</strong><span>已验证、估算、预测和未知采用不同状态；AI 不是开放时间、房价或客流的权威来源。</span></div><details class="compiler-details"><summary>查看编译校验、最低核验与压力测试</summary><div class="compiler-detail-grid"><p><b>路线可靠性</b>${plan.compiler?.reliability ?? '—'} / 100</p><p><b>信息完整度</b>${plan.compiler?.informationCompleteness ?? '—'}%</p><p><b>最低核验</b>${verification.length} 项</p><p><b>压力测试</b>${plan.stressTest?.resilientCount ?? 0} / ${stress.length}</p></div>${verification.slice(0, 5).map(item => `<div class="verification-row"><b>${item.rank}. ${esc(item.subject)} · ${esc(item.field)}</b><br><em>${esc(item.action)}</em> · ${esc(item.impact)}</div>`).join('')}</details>${sorted.slice(0, 18).map(fact => `<article class="evidence-fact"><div class="evidence-fact-head"><strong>${esc(fact.subject)} · ${esc(fact.field)}</strong><span class="fact-state ${esc(fact.status)}">${factStatusLabel(fact.status)}</span></div><p>${esc(fact.sourceName || '未取得来源')}${fact.uncertaintyReason ? ` · ${esc(fact.uncertaintyReason)}` : ''}${fact.sourceUrl ? ` · <a href="${esc(fact.sourceUrl)}" target="_blank" rel="noreferrer">查看来源</a>` : ''}</p></article>`).join('')}`;
}

async function loadDiningForPlan(plan) {
  if (plan._diningLoading || plan._diningLoaded) return;
  const meals = plan.daysPlan.flatMap(day => day.blocks || []).filter(block => block.type === 'rest' && block.mealType && block.anchor);
  if (!meals.length) { plan._diningLoaded = true; return; }
  plan._diningLoading = true;
  await Promise.all(meals.map(async block => {
    const params = new URLSearchParams({ city: plan.city, lat: String(block.anchor.lat), lng: String(block.anchor.lng), meal: block.mealType });
    try { block.dining = await api(`/api/dining?${params}`); }
    catch (error) { block.dining = { status: 'fallback', candidates: [], message: `餐饮查询暂不可用：${error.message}` }; }
  }));
  plan._diningLoading = false; plan._diningLoaded = true;
  if (state.plan === plan) {
    $('#daysContainer').innerHTML = plan.daysPlan.map(day => renderDay(day)).join('');
    bindRenderedPlanInteractions();
    loadTimelineImages(plan);
  }
}

function replanWithAdjustment() {
  const adjustment = $('#replanText').value.trim();
  if (!state.plan) { toast('请先生成一份行程'); return; }
  if (!adjustment) { $('#replanText').focus(); toast('请先输入希望调整的内容'); return; }
  generatePlan(false, { previewAdjustment: adjustment });
}

function renderChangePreview(before, after, adjustment) {
  const beforeDays = new Map(before.daysPlan.map(day => [day.day, day.items.map(item => item.name)]));
  const dayRows = after.daysPlan.map(day => {
    const oldNames = beforeDays.get(day.day) || [];
    const newNames = day.items.map(item => item.name);
    const changed = oldNames.join('|') !== newNames.join('|');
    return `<article class="day-diff${changed ? ' changed' : ''}"><strong>Day ${day.day} · ${changed ? '有变更' : '保持原景点顺序'}</strong><p>原：${esc(oldNames.join(' → ') || '无')}<br>新：${esc(newNames.join(' → ') || '无')}</p></article>`;
  }).join('');
  const scope = after.changeScope || {};
  $('#changePreviewBody').innerHTML = `<p>调整要求：${esc(adjustment)}</p><div class="change-preview-summary"><div><span>可靠性</span><b>${before.compiler?.reliability ?? '—'} → ${after.compiler?.reliability ?? '—'}</b></div><div><span>交通时间</span><b>${before.evaluation?.evidence?.transportMinutes ?? '—'} → ${after.evaluation?.evidence?.transportMinutes ?? '—'} 分</b></div><div><span>脆弱性</span><b>${before.fragility?.score ?? '—'} → ${after.fragility?.score ?? '—'}</b></div><div><span>关键未知</span><b>${before.uncertainty?.importantCount ?? '—'} → ${after.uncertainty?.importantCount ?? '—'}</b></div></div><div class="day-diff-list">${dayRows}</div><div class="change-preview-note">${esc(scope.note || '未识别到明确日期时会提供全局变更预览。只有点击“应用这次调整”后才会覆盖当前行程。')}</div>`;
}

function applyPendingChange() {
  const pending = state.pendingChange;
  if (!pending) { $('#changePreviewDialog').close(); return; }
  state.previousPlan = pending.before;
  $('#requestText').value = `${pending.originalRequest}${pending.originalRequest ? '\n\n' : ''}后续调整：${pending.adjustment}`;
  applyPlanResult(pending.result, false);
  $('#replanText').value = '';
  state.pendingChange = null;
  $('#changePreviewDialog').close();
  renderPlanComparison(state.previousPlan, state.plan);
  toast('调整已应用；未受影响日期已按可用景点 ID 尽量锁定');
}

function renderDay(day) {
  const weather = day.weather || {};
  const forecast = weather.quality === 'forecast' ? `${weatherText(weather.weatherCode)} ${Math.round(weather.temperatureMin)}°~${Math.round(weather.temperatureMax)}° · 降水 ${Math.round(weather.precipitationProbability || 0)}%` : weather.note || '预报未覆盖';
  const blocks = day.blocks.map(block => renderTimelineBlock(block)).join('');
  const conflicts = (day.conflicts || []).map(item => `<div class="conflict-note">${esc(item.name)}：${esc(item.reason)}</div>`).join('');
  return `<article class="day-card${day.day === 1 ? '' : ' collapsed'}"><header class="day-header"><button class="day-toggle" type="button" aria-expanded="${day.day === 1 ? 'true' : 'false'}"><div class="day-title"><span class="day-index">DAY ${day.day}</span><div><strong>${esc(day.date)} ${esc(day.weekday)} · ${esc(day.theme)}</strong><small class="forecast-state ${weather.quality === 'unavailable' ? 'unavailable' : ''}">${esc(forecast)}</small></div></div><span class="day-route-info">${formatDistance(day.route.distance || 0)} · ${formatDuration(day.route.duration || 0)} <i class="day-toggle-icon">⌄</i></span></button></header><div class="day-body"><div class="timeline">${blocks}</div>${conflicts}</div></article>`;
}

function bindRenderedPlanInteractions() {
  $$('.detail-trigger', $('#daysContainer')).forEach(button => button.addEventListener('click', () => openSpotDetails(state.spotIndex.get(button.dataset.id))));
  $$('.day-toggle', $('#daysContainer')).forEach(button => button.addEventListener('click', () => {
    const card = button.closest('.day-card');
    card.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
  }));
}

function loadTimelineImages(plan) {
  $$('[data-timeline-thumb]', $('#daysContainer')).forEach(holder => {
    const spot = state.spotIndex.get(holder.dataset.timelineThumb) || (plan.daysPlan || []).flatMap(day => day.items || []).find(item => item.id === holder.dataset.timelineThumb);
    loadSpotImage(spot, holder);
  });
}

function renderTimelineBlock(block) {
  if (block.type === 'leg') {
    const mcp = block.mcpTransport;
    const routeLabel = mcp ? `${mcp.mode} · 高德 MCP 已校验${mcp.durationMin ? ` · 约 ${mcp.durationMin} 分钟` : ''}` : block.mcpStatus?.status === 'no-route' ? '高德 MCP 无可用班次 · 保留道路估算' : block.quality === 'estimated' ? '道路估算' : '道路路由';
    return `<div class="timeline-row leg"><div class="timeline-time">${esc(block.startTime)}</div><div class="timeline-node"></div><div class="timeline-content"><div class="leg-card"><span><b>${esc(block.from)} → ${esc(block.to)}</b> · ${formatDistance(block.distanceM)}</span><span>${block.durationMin} 分钟 · ${esc(routeLabel)}</span></div></div></div>`;
  }
  if (block.type === 'rest') {
    const dining = block.dining;
    const candidate = dining?.candidates?.[0];
    const diningHtml = candidate
      ? `<span class="dining-candidate">候选：${esc(candidate.name)}${candidate.distanceM ? ` · 距路线锚点约 ${candidate.distanceM}m` : ''}</span><span class="dining-source">${esc(candidate.source)} · 仅为路线附近候选，营业状态与排队情况请复核</span>`
      : block.mealType && dining ? `<span class="dining-source">${esc(dining.message)}</span>` : '';
    return `<div class="timeline-row rest"><div class="timeline-time">${esc(block.startTime)}</div><div class="timeline-node"></div><div class="timeline-content"><div class="rest-card">${esc(block.label)} · ${block.durationMin} 分钟${diningHtml}</div></div></div>`;
  }
  const spot = block.item;
  const stops = spot.transitStops || [];
  const openingClass = spot.openingStatus?.status === 'open' ? 'open' : spot.openingStatus?.status === 'closed' ? 'closed' : '';
  const crowdText = spot.crowd?.score == null ? '客流未知' : `客流预测 ${esc(spot.crowd.label)} ${spot.crowd.score}`;
  return `<div class="timeline-row attraction"><div class="timeline-time">${esc(spot.startTime)}<br><small>${esc(spot.endTime)}</small></div><div class="timeline-node"></div><div class="timeline-content"><div class="timeline-attraction-grid"><div class="timeline-thumb" data-timeline-thumb="${esc(spot.id)}"><span>⌖</span></div><div class="timeline-attraction-copy"><div class="item-head"><button class="detail-trigger" data-id="${esc(spot.id)}" type="button">${esc(spot.name)}</button><span class="source-link">${esc(spot.requiredByUser ? '用户必选' : spot.category)}</span></div><div class="spot-meta"><span>游玩 ${spot.durationMin} 分钟</span><span>${esc(seasonalText(spot))}</span><span class="estimated">${crowdText}</span><span class="${openingClass}">${esc(spot.openingStatus?.label || '开放未知')}</span></div><div class="reason-row">${(spot.recommendationReasons || []).map(reason => `<span>${esc(reason)}</span>`).join('')}</div><div class="transit-reference">${stops.length ? `附近站点参考：${stops.slice(0, 2).map(stop => `${esc(stop.name)} ${stop.distanceM}m`).join(' / ')}` : '附近 850m 内未获取到已标注站点'}</div></div></div></div></div>`;
}

function renderHotel(hotel) {
  const value = hotel || {};
  $('#hotelName').textContent = value.name || '未锁定具体酒店';
  $('#hotelReason').textContent = [value.reason, value.note].filter(Boolean).join(' · ') || '没有可靠住宿数据，保持未知。';
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const container = $('#hotelCandidates');
  container.innerHTML = candidates.length ? candidates.map((candidate, index) => {
    const distance = Number(candidate.distanceM) > 0
      ? `距住宿锚点约 ${Number(candidate.distanceM) >= 1000 ? `${(Number(candidate.distanceM) / 1000).toFixed(1)}km` : `${Math.round(Number(candidate.distanceM))}m`}`
      : Number(candidate.distance) > 0 ? `距住宿锚点约 ${Number(candidate.distance).toFixed(1)}km` : '';
    const meta = [candidate.rating ? `评分 ${candidate.rating}` : '', candidate.star ? `${candidate.star} 星` : '', distance, candidate.address].filter(Boolean);
    const price = Number(candidate.price) > 0 ? `<b class="hotel-price">¥${Math.round(Number(candidate.price))}<small>起</small></b>` : '<b class="hotel-price unknown">价格待源返回</b>';
    const source = candidate.sourceUrl
      ? `<a href="${esc(candidate.sourceUrl)}" target="_blank" rel="noreferrer">${esc(candidate.source || '查看来源')}</a>`
      : `<span>${esc(candidate.source || '来源未提供链接')}</span>`;
    const products = Array.isArray(candidate.products) && candidate.products.length
      ? `<div class="hotel-products">${candidate.products.slice(0, 2).map(product => product.url
          ? `<a href="${esc(product.url)}" target="_blank" rel="noreferrer">套餐参考 ¥${Math.round(Number(product.price))}起</a>`
          : `<span>套餐参考 ¥${Math.round(Number(product.price))}起</span>`).join('')}</div>`
      : '';
    return `<article class="hotel-candidate"><div class="hotel-candidate-head"><span class="hotel-rank">${index + 1}</span><strong>${esc(candidate.name)}</strong>${price}</div><p>${meta.map(esc).join(' · ') || '地图已核验，暂无更多详情'}</p><div class="hotel-price-note">${esc(candidate.priceType || '价格来源未知')}${candidate.availability === 'unavailable' ? ' · 指定日期套餐未确认可用' : ''}</div><div class="hotel-source">${source}</div>${products}</article>`;
  }).join('') : '<div class="hotel-empty">本次查询暂未返回可核验酒店候选，请稍后重试或换一个住宿区域。</div>';
  const link = $('#hotelSourceLink');
  if (value.sourceUrl) { link.href = value.sourceUrl; link.hidden = false; }
  else { link.hidden = true; link.removeAttribute('href'); }
}

function renderBudget(budget) {
  $('#budgetEstimate').textContent = `¥${budget.knownEstimate}`;
  $('#budgetLimit').textContent = `预算上限 ¥${budget.limit}`;
  $('#budgetList').innerHTML = budget.items.slice(0, 4).map(item => `<div><span>${esc(item.name)}</span><b>${item.amount == null ? '未知' : `约 ¥${item.amount}`}</b></div>`).join('');
}

function renderMapFromPlan(plan) {
  const markers = plan.daysPlan.flatMap(day => day.items);
  const routes = plan.daysPlan.map(day => day.route?.geometry?.coordinates || []).filter(route => route.length);
  mapView.setData(routes, markers);
  let distance = 0, duration = 0;
  plan.daysPlan.forEach(day => { distance += Number(day.route.distance || 0); duration += Number(day.route.duration || 0); });
  $('#routeSummary').innerHTML = `<span>道路里程 <b>${formatDistance(distance)}</b></span><span>交通耗时 <b>${formatDuration(duration)}</b></span>`;
}

async function askAgent() {
  const input = $('#agentInput');
  const prompt = input.value.trim();
  if (!prompt) return;
  const button = $('#agentSend');
  button.disabled = true; button.textContent = '思考中';
  $('#agentAnswer').hidden = false; $('#agentAnswer').textContent = '正在调用 GLM-5 陪聊咨询，必要时会核验公开信息…';
  try {
    const context = state.plan ? {
      request: { city: state.plan.city, startDate: state.plan.startDate, days: state.plan.days, preferences: state.plan.preferences },
      variant: state.plan.variant,
      days: state.plan.daysPlan.map(day => ({ date: day.date, weather: day.weather, attractions: day.items.map(item => ({ name: item.name, time: item.startTime, crowd: item.crowd, opening: item.openingStatus, reasons: item.recommendationReasons })), route: { distance: day.route.distance, duration: day.route.duration, source: day.route.source } })),
      sources: state.plan.dataSources,
      compiler: state.plan.compiler,
      uncertainty: state.plan.uncertainty,
      minimumVerification: state.plan.minimumVerification,
      fragility: state.plan.fragility,
    } : { note: '尚未生成行程' };
    const result = await api('/api/agent', { method: 'POST', body: JSON.stringify({ prompt, context }) });
    $('#agentAnswer').textContent = result.message || 'AI 没有返回内容。';
  } catch (error) {
    $('#agentAnswer').textContent = `AI 咨询暂不可用：${error.message}`;
  } finally {
    button.disabled = false; button.textContent = '发送';
  }
}

function exportPlan() {
  if (!state.plan) return;
  const plan = state.plan;
  const variantName = plan.variant === 'relax' ? '舒适版' : plan.variant === 'hot' ? '精华版' : '错峰版';
  const lines = [`${plan.title}（${variantName}）`, `出发日期：${plan.startDate}`, `生成：${plan.generatedAt}`, ''];
  plan.daysPlan.forEach(day => {
    lines.push(`Day ${day.day}｜${day.date} ${day.weekday}｜${day.theme}`);
    day.blocks.forEach(block => {
      if (block.type === 'attraction') lines.push(`${block.item.startTime}-${block.item.endTime} ${block.item.name}｜客流 ${block.item.crowd?.score == null ? '未知' : `${block.item.crowd.label} ${block.item.crowd.score}`}｜${block.item.openingStatus.label}`);
      if (block.type === 'leg') lines.push(`${block.startTime}-${block.endTime} 前往下一站｜${block.durationMin}分钟｜${formatDistance(block.distanceM)}｜${block.source}`);
      if (block.type === 'rest') lines.push(`${block.startTime}-${block.endTime} ${block.label}`);
    });
    lines.push('');
  });
  lines.push(`数据来源：${Object.values(plan.dataSources).join(' / ')}`);
  lines.push(`路线可靠性：${plan.compiler?.reliability ?? '未知'}；脆弱性：${plan.fragility?.score ?? '未知'}；关键未知：${plan.uncertainty?.importantCount ?? '未知'}`);
  lines.push('压力测试为情景模拟，不是对真实延误、天气、客流或闭园的预测。');
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `${plan.city}-${plan.startDate}-travel-plan.txt`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 500); toast('行程已导出');
}

async function init() {
  try { await loadCities(); }
  catch { state.cityCenters = { 杭州: { name: '杭州', lat: 30.2741, lng: 120.1551, zoom: 11, countryCode: 'cn' } }; $('#cityOptions').innerHTML = '<option value="杭州"></option>'; state.cityRef = state.cityCenters['杭州']; }
  bind(); syncControls(); updateCityLabels(); mapView.setCity(state.city); renderTripHistory(); setWorkspaceStage('EMPTY');
  $('#weatherIcon').innerHTML = weatherIconSvg(null);
  await Promise.allSettled([loadHealth(), loadWeather()]);
}

init();
