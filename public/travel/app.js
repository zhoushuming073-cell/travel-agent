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
};

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
}

function bind() {
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
    Object.assign(state, { city: '杭州', cityRef: state.cityCenters['杭州'] || null, startDate: dateAfter(3), days: 3, budget: 1500, style: '自然风景', preferences: ['自然'], pace: 'medium', transport: '公共交通优先', hotelPreference: '交通方便', variant: 'relax', plans: {}, plan: null, spots: [], partySize: null, requiredAttractions: [], dayStart: null, dayEnd: null, lodgingArea: null });
    $('#requestText').value = '';
    $('#daysContainer').hidden = true; $('#planFooter').hidden = true; $('#refreshSpots').disabled = true;
    $('#loadingState').hidden = false; $('#loadingState').className = 'loading-state idle';
    $('#loadingState').innerHTML = '<div class="plan-empty-mark" aria-hidden="true">✦</div><div><strong>行程将在你确认需求后生成</strong><span>先填写城市、日期与偏好，再点击“生成智能行程”。页面不会在打开时自动调用 AI。</span></div>';
    $('#spotGrid').innerHTML = '<div class="data-empty">生成行程后，这里会展示本次规划中经过地图核验的景点；没有可靠匹配的图片将保持占位。</div>';
    $('#aiSyncCard').hidden = true; lastFormSyncSignature = '';
    syncControls(); mapView.setCity('杭州'); updateCityLabels(); loadWeather();
  });
  $('#generateButton').addEventListener('click', () => generatePlan());
  $$('#variantTabs button').forEach(button => button.addEventListener('click', () => selectVariant(button.dataset.variant)));
  $('#zoomIn').addEventListener('click', () => mapView.zoomBy(1));
  $('#zoomOut').addEventListener('click', () => mapView.zoomBy(-1));
  $('#refreshSpots').addEventListener('click', () => loadSpots(true));
  $('#exportButton').addEventListener('click', exportPlan);
  $$('.nav-link[data-scroll]').forEach(button => button.addEventListener('click', () => $(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' })));
  $('#openSources').addEventListener('click', openSourceDialog);
  $('#openSourcesInline').addEventListener('click', openSourceDialog);
  $('#agentSend').addEventListener('click', askAgent);
  $('#agentInput').addEventListener('keydown', event => { if (event.key === 'Enter') askAgent(); });
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
    $('#topModelStatus').textContent = available ? `DeepSeek · ${ai.model}` : 'DeepSeek 未配置';
    $('#agentState').textContent = available ? ai.model : '离线';
    $('#agentState').className = `state-label ${available ? 'success' : 'offline'}`;
    $('#agentNote').textContent = ai.note || 'DeepSeek 只使用后端提供的已验证工具数据。';
    $('#agentInput').disabled = !available;
    $('#agentSend').disabled = !available;
  } catch (error) {
    $('#sourceList').innerHTML = `<div><span class="source-status offline"></span><b>本地 API 服务</b><small>${esc(error.message)}</small></div>`;
  }
}

function renderSources() {
  const ai = state.health?.ai || {};
  const rows = [{ name: 'DeepSeek 路线规划', provider: ai.model || '未配置', status: ai.status, note: ai.note }, ...(state.health?.services || [])];
  $('#sourceList').innerHTML = rows.slice(0, 7).map(row => `<div><span class="source-status ${row.status === 'live' ? 'live' : row.status === 'estimate' ? 'estimate' : row.status === 'offline' ? 'offline' : 'pending'}"></span><b>${esc(row.name)}</b><small>${statusLabel(row.status)}</small></div>`).join('');
  const mcpRows = Object.values(state.providerStatus?.providers || {});
  $('#sourceDialogBody').innerHTML = [...rows.map(row => ({ ...row, group: '运行工具' })), ...mcpRows.map(row => ({ ...row, provider: row.role, note: row.fallback || row.note, group: '可选 MCP' }))]
    .map(row => {
      const active = ['live', 'ready', 'configured'].includes(row.status);
      const available = ['estimate', 'available', 'unknown'].includes(row.status);
      return `<div class="dialog-source-row"><div><strong>${esc(row.name)}</strong><small>${esc(row.group)} · ${esc(row.provider || '')}${row.note ? ` · ${esc(row.note)}` : ''}</small></div><span class="${active ? 'api-connected' : available ? 'api-estimate' : 'api-disconnected'}">${statusLabel(row.status)}</span></div>`;
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
  $('#spotGrid').innerHTML = list.map(spot => `<article class="spot-card" data-id="${esc(spot.id)}" tabindex="0" role="button" aria-label="查看${esc(spot.name)}详情"><div class="spot-image"><div class="fallback-art">⌖</div><span class="spot-badge">${esc(spot.requiredByUser ? '用户必选' : spot.category)}</span></div><div class="spot-body"><strong title="${esc(spot.name)}">${esc(spot.name)}</strong><p>${spot.openingHours ? `开放：${esc(spot.openingHours)}` : '开放时间：公开数据未标注'}</p><div class="spot-score"><span>静态质量 ${spot.staticPoiQuality}</span><span>${esc(seasonalText(spot))}</span></div><a class="source-link" href="${esc(spot.sourceUrl)}" target="_blank" rel="noreferrer">景点资料来源</a></div></article>`).join('');
  $$('.spot-card').forEach(card => {
    const spot = state.spotIndex.get(card.dataset.id);
    card.addEventListener('click', event => { if (!event.target.closest('a')) openSpotDetails(spot); });
    card.addEventListener('keydown', event => { if (event.key === 'Enter') openSpotDetails(spot); });
    loadSpotImage(spot, $('.spot-image', card));
  });
}

async function loadSpotImage(spot, holder) {
  if (!holder || !spot) return;
  try {
    const params = new URLSearchParams({ name: spot.name || '', city: state.city || '', wikipedia: spot.wikipedia || '', wikidata: spot.wikidata || '', commons: spot.wikimediaCommons || '', image: spot.image || '' });
    const imageData = await api(`/api/image?${params}`);
    if (!imageData.found) return;
    spot._image = imageData;
    const image = document.createElement('img'); image.loading = 'lazy'; image.alt = spot.name; image.src = imageData.url; image.onerror = () => image.remove(); holder.appendChild(image);
    const link = holder.closest('.spot-card')?.querySelector('.source-link');
    if (link) { link.href = imageData.sourceUrl || link.href; link.textContent = `${imageData.source || '精确页面图片'}来源`; }
  } catch { /* image is optional */ }
}

function openSpotDetails(spot) {
  if (!spot) return;
  const image = spot._image?.url ? `<img src="${esc(spot._image.url)}" alt="${esc(spot.name)}" />` : '<div class="fallback-art">⌖</div>';
  const reasons = spot.recommendationReasons || ['公开数据完整度与行程匹配度较优'];
  const stops = spot.transitStops || [];
  const crowd = spot.crowd?.score == null ? '未知，没有可验证客流来源' : `透明预测 ${esc(spot.crowd.label)} ${spot.crowd.score}`;
  $('#spotDialogBody').innerHTML = `<div class="spot-detail-hero"><div class="spot-detail-image">${image}</div><div class="spot-detail-copy"><span class="section-code">ATTRACTION DETAIL</span><h2>${esc(spot.name)}</h2><p>${esc(spot.requiredByUser ? '用户必选 · ' : '')}${esc(spot.category)} · 建议游玩 ${spot.durationMin} 分钟</p><p>${reasons.map(reason => `✓ ${esc(reason)}`).join('<br>')}</p></div></div><div class="spot-detail-grid"><div class="detail-box"><span>开放时间</span><strong>${esc(spot.openingHours || '未知，出发前请复核')}</strong></div><div class="detail-box"><span>开放校验</span><strong>${esc(spot.openingStatus?.label || '未进入具体行程时段')}</strong></div><div class="detail-box"><span>时令适配</span><strong>${esc(seasonalText(spot))}</strong></div><div class="detail-box"><span>客流</span><strong>${crowd}</strong></div><div class="detail-box"><span>附近交通</span><strong>${stops.length ? stops.slice(0, 2).map(stop => `${esc(stop.name)} ${stop.distanceM}m`).join('<br>') : '未获取到附近已标注站点'}</strong></div><div class="detail-box"><span>数据更新时间</span><strong>${esc((spot.fetchedAt || '未知').replace('T', ' ').slice(0, 19))}</strong></div><div class="detail-box"><span>坐标</span><strong>${Number(spot.lat).toFixed(5)}, ${Number(spot.lng).toFixed(5)}</strong></div></div><div class="spot-detail-links"><a href="${esc(spot.sourceUrl || 'https://www.openstreetmap.org/')}" target="_blank" rel="noreferrer">查看数据来源</a>${spot.website ? `<a href="${esc(spot.website)}" target="_blank" rel="noreferrer">景点网站</a>` : ''}</div>`;
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
    city: state.city, startDate: state.startDate, days: state.days, style: state.style,
    preferences: [...state.preferences], pace: state.pace, transport: state.transport,
    hotelPreference: state.hotelPreference,
  };
  if (data.city) state.city = data.city;
  if (data.cityRef) state.cityRef = data.cityRef;
  if (data.startDate) state.startDate = data.startDate;
  if (data.days) state.days = Number(data.days);
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
  $('#aiSyncSource').textContent = data.source || 'DeepSeek 第 1 阶段';
  $('#aiSyncFields').innerHTML = items.map(([label, value, wide]) => `<div class="ai-sync-item${wide ? ' wide' : ''}"><span>${esc(label)}</span><strong title="${esc(value)}">${esc(value)}</strong></div>`).join('');
  card.hidden = false;
  card.classList.remove('syncing');
  requestAnimationFrame(() => card.classList.add('syncing'));

  const changed = [];
  if (before.city !== state.city) changed.push($('#citySelect').closest('.select-wrap'));
  if (before.startDate !== state.startDate) changed.push($('#startDate').closest('.select-wrap'));
  if (before.days !== state.days) changed.push($('.counter-control'));
  if (before.style !== state.style) changed.push($('#styleSelect').closest('.select-wrap'));
  if (before.preferences.join('|') !== state.preferences.join('|')) changed.push($('#preferenceChips'));
  if (before.pace !== state.pace) changed.push($('#paceGroup'));
  if (before.transport !== state.transport) changed.push($('#transportSelect').closest('.select-wrap'));
  if (before.hotelPreference !== state.hotelPreference) changed.push($('#hotelPreference').closest('.select-wrap'));
  animateSyncedFields(changed);
}

function renderPlanningProgress(entry) {
  if (entry?.formSync) applyRequestFormSync(entry.formSync);
  if (entry?.phase) planningLogHistory[entry.phase] = entry;
  const order = ['analysis', 'live', 'route'];
  const sections = order.filter(key => planningLogHistory[key]).map(key => {
    const section = planningLogHistory[key];
    return `<section class="progress-phase ${key === entry?.phase ? 'current' : ''}"><strong>${esc(section.title)}</strong><ul>${(section.items || []).map(item => {
      const kind = item.startsWith('✓') ? 'done' : item.startsWith('○') ? 'note' : 'pending';
      return `<li class="${kind}">${esc(item)}</li>`;
    }).join('')}</ul></section>`;
  }).join('');
  $('#loadingState').className = 'loading-state';
  $('#loadingState').innerHTML = `<div class="planning-progress"><div class="progress-head"><div class="loader"></div><div><strong>智能体正在规划</strong><span>实时读取后端工具执行状态</span></div></div><div class="progress-phases">${sections}</div><small class="progress-note">仅展示可验证的输入解析、工具调用与校验结果，不展示或伪造模型内部思维链。</small></div>`;
}

function startPlanningProgress(payload) {
  planningLogHistory = {};
  lastFormSyncSignature = '';
  $('#aiSyncCard').hidden = true;
  renderPlanningProgress({ phase: 'analysis', title: '正在分析您的需求……', items: ['… DeepSeek 第 1 阶段正在整理目的地、日期、人数、必选景点和限制条件'] });
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
      await new Promise(resolve => setTimeout(resolve, 900));
      return job.result;
    }
    if (job.status === 'error') throw new Error(job.error?.message || '规划任务失败');
    await new Promise(resolve => setTimeout(resolve, 850));
  }
  throw new Error('规划任务等待超时，请稍后重试');
}

async function generatePlan(scroll = true) {
  const button = $('#generateButton');
  button.disabled = true; $('span', button).textContent = '正在计算';
  state.plan = null; state.plans = {}; state.spots = []; state.spotIndex = new Map();
  $('#planTitle').textContent = '正在根据新需求规划'; $('#planMeta').textContent = '旧行程已清除';
  $('#spotGrid').innerHTML = '<div class="data-empty">正在等待本次规划的已验证景点，不显示上一次行程数据。</div>';
  $('#refreshSpots').disabled = true;
  mapView.setData([], []);
  renderHotel({});
  $('#loadingState').hidden = false; $('#daysContainer').hidden = true; $('#planFooter').hidden = true;
  try {
    await chooseCity($('#citySelect').value || state.city, false);
    weatherRequestVersion += 1;
    $('#discoverTitle').textContent = '本次景点发现（等待解析目的地）';
    $('#mapTitle').textContent = '本次路线地图（等待解析目的地）';
    $('#weatherIcon').innerHTML = weatherIconSvg(null); $('#weatherIcon').setAttribute('aria-label', '等待解析本次出发日');
    $('#temperature').textContent = '—'; $('#weatherDescription').textContent = '等待解析本次出发日';
    $('#weatherRange').textContent = '不会沿用上一次日期的天气';
    $('#tipsList').innerHTML = '<li>正在解析本次需求中的日期与数据可用范围。</li><li>未接入官方来源时，客流和预约状态会保持未知。</li>';
    const payload = { city: state.city, cityRef: state.cityRef, startDate: state.startDate, days: state.days, budget: state.budget, style: state.style, preferences: state.preferences, pace: state.pace, variant: state.variant, transport: state.transport, hotelPreference: state.hotelPreference, freeText: $('#requestText').value };
    startPlanningProgress(payload);
    const started = await api('/api/plan/start', { method: 'POST', body: JSON.stringify(payload) });
    if (started.progress?.phase !== 'queued') renderPlanningProgress(started.progress);
    const result = await waitForPlanJob(started.jobId);
    if (result.request) {
      state.city = result.request.city || state.city;
      state.cityRef = result.alternatives?.[0]?.cityRef || state.cityRef;
      state.startDate = result.request.startDate || state.startDate;
      state.days = Number(result.request.days || state.days);
      state.budget = Number(result.request.budget || state.budget);
      syncControls();
      updateCityLabels();
    }
    state.plans = Object.fromEntries(result.alternatives.map(plan => [plan.id, plan]));
    const discovered = new Map();
    result.alternatives.flatMap(plan => plan.daysPlan || []).flatMap(day => day.items || []).forEach(spot => discovered.set(spot.id, spot));
    state.spots = [...discovered.values()];
    state.spotIndex = new Map(state.spots.map(spot => [spot.id, spot]));
    renderSpots();
    $('#refreshSpots').disabled = false;
    selectVariant(result.activeId || state.variant, false);
    if (scroll) $('#itinerarySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    stopPlanningProgress();
    $('#loadingState').className = 'loading-state';
    $('#loadingState').innerHTML = `<div class="load-error"><strong>规划工具暂时不可用</strong><p>${esc(error.message)}</p><button class="secondary-button" id="retryPlan" type="button">重试</button></div>`;
    $('#retryPlan').addEventListener('click', () => generatePlan(false));
    mapView.setCity(state.city); toast('行程规划失败，已保留输入条件');
  } finally {
    if (state.plan) stopPlanningProgress();
    button.disabled = false; $('span', button).textContent = '生成智能行程';
  }
}

function selectVariant(variant, showToast = true) {
  state.variant = variant;
  $$('#variantTabs button').forEach(button => button.classList.toggle('active', button.dataset.variant === variant));
  if (!state.plans[variant]) return;
  state.plan = state.plans[variant];
  state.plan.daysPlan.flatMap(day => day.items).forEach(spot => state.spotIndex.set(spot.id, spot));
  renderPlan(state.plan);
  if (showToast) toast(`已切换到${variant === 'relax' ? '轻松版' : variant === 'hot' ? '热门版' : '小众版'}`);
}

function renderPlan(plan) {
  stopPlanningProgress();
  $('#loadingState').hidden = true; $('#daysContainer').hidden = false; $('#planFooter').hidden = false;
  const variantName = plan.variant === 'relax' ? '轻松版' : plan.variant === 'hot' ? '热门版' : '小众版';
  $('#planTitle').textContent = `${plan.title} · ${variantName}`;
  $('#planMeta').textContent = `${plan.startDate} 出发 · ${plan.generatedAt.slice(0, 19).replace('T', ' ')} · DeepSeek 两阶段 + 已验证工具`;
  $('#daysContainer').innerHTML = plan.daysPlan.map((day, index) => renderDay(day, index)).join('');
  $$('.detail-trigger', $('#daysContainer')).forEach(button => button.addEventListener('click', () => openSpotDetails(state.spotIndex.get(button.dataset.id))));
  const source = plan.dataSources;
  $('#sourceCaption').textContent = `天气：${source.weather}；景点：${source.spots}；酒店：${source.hotels || '未知'}；路线：${source.routing}；交通：${source.transit}；客流：${source.crowd}`;
  renderBudget(plan.budgetBreakdown);
  renderHotel(plan.hotelPlan);
  renderWeather(plan.weather);
  renderMapFromPlan(plan);
  toast('三套差异化行程已一次生成');
}

function renderDay(day, index) {
  const weather = day.weather || {};
  const forecast = weather.quality === 'forecast' ? `${weatherText(weather.weatherCode)} ${Math.round(weather.temperatureMin)}°~${Math.round(weather.temperatureMax)}° · 降水 ${Math.round(weather.precipitationProbability || 0)}%` : weather.note || '预报未覆盖';
  const blocks = day.blocks.map(block => renderTimelineBlock(block)).join('');
  const conflicts = (day.conflicts || []).map(item => `<div class="conflict-note">${esc(item.name)}：${esc(item.reason)}</div>`).join('');
  return `<article class="day-card"><header class="day-header"><div class="day-title"><span class="day-index">DAY ${day.day}</span><div><strong>${esc(day.date)} ${esc(day.weekday)} · ${esc(day.theme)}</strong><small class="forecast-state ${weather.quality === 'unavailable' ? 'unavailable' : ''}">${esc(forecast)}</small></div></div><span class="day-route-info">${formatDistance(day.route.distance || 0)}<br>${formatDuration(day.route.duration || 0)}</span></header><div class="timeline">${blocks}</div>${conflicts}</article>`;
}

function renderTimelineBlock(block) {
  if (block.type === 'leg') {
    const mcp = block.mcpTransport;
    const routeLabel = mcp ? `${mcp.mode} · 高德 MCP 已校验${mcp.durationMin ? ` · 约 ${mcp.durationMin} 分钟` : ''}` : block.mcpStatus?.status === 'no-route' ? '高德 MCP 无可用班次 · 保留道路估算' : block.quality === 'estimated' ? '道路估算' : '道路路由';
    return `<div class="timeline-row leg"><div class="timeline-time">${esc(block.startTime)}</div><div class="timeline-node"></div><div class="timeline-content"><div class="leg-card"><span><b>${esc(block.from)} → ${esc(block.to)}</b> · ${formatDistance(block.distanceM)}</span><span>${block.durationMin} 分钟 · ${esc(routeLabel)}</span></div></div></div>`;
  }
  if (block.type === 'rest') {
    return `<div class="timeline-row rest"><div class="timeline-time">${esc(block.startTime)}</div><div class="timeline-node"></div><div class="timeline-content"><div class="rest-card">${esc(block.label)} · ${block.durationMin} 分钟</div></div></div>`;
  }
  const spot = block.item;
  const stops = spot.transitStops || [];
  const openingClass = spot.openingStatus?.status === 'open' ? 'open' : spot.openingStatus?.status === 'closed' ? 'closed' : '';
  const crowdText = spot.crowd?.score == null ? '客流未知' : `客流预测 ${esc(spot.crowd.label)} ${spot.crowd.score}`;
  return `<div class="timeline-row attraction"><div class="timeline-time">${esc(spot.startTime)}<br><small>${esc(spot.endTime)}</small></div><div class="timeline-node"></div><div class="timeline-content"><div class="item-head"><button class="detail-trigger" data-id="${esc(spot.id)}" type="button">${esc(spot.name)}</button><span class="source-link">${esc(spot.requiredByUser ? '用户必选' : spot.category)}</span></div><div class="spot-meta"><span>游玩 ${spot.durationMin} 分钟</span><span>${esc(seasonalText(spot))}</span><span class="estimated">${crowdText}</span><span class="${openingClass}">${esc(spot.openingStatus?.label || '开放未知')}</span></div><div class="reason-row">${(spot.recommendationReasons || []).map(reason => `<span>${esc(reason)}</span>`).join('')}</div><div class="transit-reference">${stops.length ? `附近站点参考：${stops.slice(0, 2).map(stop => `${esc(stop.name)} ${stop.distanceM}m`).join(' / ')}` : '附近 850m 内未获取到已标注站点'}</div></div></div>`;
}

function renderHotel(hotel) {
  const value = hotel || {};
  $('#hotelName').textContent = value.name || '未锁定具体酒店';
  $('#hotelReason').textContent = [value.reason, value.note].filter(Boolean).join(' · ') || '没有可靠住宿数据，保持未知。';
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
  $('#agentAnswer').hidden = false; $('#agentAnswer').textContent = '正在调用 DeepSeek，并限制其只读取当前已验证行程…';
  try {
    const context = state.plan ? {
      request: { city: state.plan.city, startDate: state.plan.startDate, days: state.plan.days, preferences: state.plan.preferences },
      variant: state.plan.variant,
      days: state.plan.daysPlan.map(day => ({ date: day.date, weather: day.weather, attractions: day.items.map(item => ({ name: item.name, time: item.startTime, crowd: item.crowd, opening: item.openingStatus, reasons: item.recommendationReasons })), route: { distance: day.route.distance, duration: day.route.duration, source: day.route.source } })),
      sources: state.plan.dataSources,
    } : { note: '尚未生成行程' };
    const result = await api('/api/agent', { method: 'POST', body: JSON.stringify({ prompt, context }) });
    $('#agentAnswer').textContent = result.message || 'DeepSeek 没有返回内容。';
  } catch (error) {
    $('#agentAnswer').textContent = `DeepSeek 暂不可用：${error.message}`;
  } finally {
    button.disabled = false; button.textContent = '发送';
  }
}

function exportPlan() {
  if (!state.plan) return;
  const plan = state.plan;
  const variantName = plan.variant === 'relax' ? '轻松版' : plan.variant === 'hot' ? '热门版' : '小众版';
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
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `${plan.city}-${plan.startDate}-travel-plan.txt`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 500); toast('行程已导出');
}

async function init() {
  try { await loadCities(); }
  catch { state.cityCenters = { 杭州: { name: '杭州', lat: 30.2741, lng: 120.1551, zoom: 11, countryCode: 'cn' } }; $('#cityOptions').innerHTML = '<option value="杭州"></option>'; state.cityRef = state.cityCenters['杭州']; }
  bind(); syncControls(); updateCityLabels(); mapView.setCity(state.city);
  $('#weatherIcon').innerHTML = weatherIconSvg(null);
  await Promise.allSettled([loadHealth(), loadWeather()]);
}

init();
