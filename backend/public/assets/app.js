'use strict';

const pagePath = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
const basePath = pagePath.includes('/steamboost')
  ? pagePath.slice(0, pagePath.indexOf('/steamboost') + '/steamboost'.length)
  : '/steamboost';
const apiBase = `${basePath}/api`;
const state = {
  token: localStorage.getItem('piboostToken') || '',
  loginId: '',
  loginTimer: null,
  loginBusy: false,
  authMode: 'password',
  qrStarting: false,
  data: null,
  selectedGames: [],
  searchItems: [],
  searchTimer: null,
  refreshBusy: false,
  history: null,
  historyBusy: false,
  currentView: 'dashboard',
  maintenance: { enabled: false, message: '' },
  logoutPreferenceBusy: false,
  bootPreferenceBusy: false,
  gamesSaveQueue: Promise.resolve(),
  gamesSavePending: false
};
const $ = (id) => document.getElementById(id);

async function request(path, options = {}, authenticated = true) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authenticated && state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, { ...options, headers });
  } catch (_error) {
    throw new Error('PiBoost non è raggiungibile. Controlla che il Raspberry sia acceso e collegato alla rete.');
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && authenticated) {
    enterLogin('La sessione è scaduta. Accedi nuovamente con Steam.', true);
    throw new Error(body.error || 'Sessione scaduta.');
  }
  if (!response.ok) throw new Error(body.error || `Errore HTTP ${response.status}`);
  return body;
}

function api(path, options = {}) { return request(path, options, true); }
function publicApi(path, options = {}) { return request(path, options, false); }

function toast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.add('hidden'), 4000);
}

function setLoginStatus(message, error = false) {
  $('loginStatus').textContent = message;
  $('loginStatus').classList.toggle('error', error);
}

function formatDuration(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}


function formatLongDuration(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours >= 100) return `${hours.toLocaleString('it-IT')} ore`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

function formatDayLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return String(value || '—');
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(date);
}

function dateKeyInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function reasonLabel(reason) {
  const labels = {
    manual: 'Stop manuale',
    auto_stop: 'Stop automatico',
    switch_favorite: 'Cambio preferito',
    switch_to_games: 'Passaggio ai giochi multipli',
    disconnect: 'Logout o disconnessione',
    new_login: 'Nuovo accesso',
    empty_selection: 'Elenco giochi vuoto',
    service_stop: 'Riavvio o arresto del servizio',
    service_interrupted: 'Servizio interrotto',
    maintenance: 'Manutenzione',
    admin_stop: 'Stop amministratore',
    running: 'In esecuzione',
    unknown: 'Terminata'
  };
  return labels[String(reason || '')] || String(reason || 'Terminata');
}

function modeLabel(mode) {
  return mode === 'favorite' ? 'Preferito' : 'Giochi multipli';
}

function sessionGameDurations(session) {
  const totals = new Map();
  for (const game of session.games || []) {
    totals.set(Number(game.appid), { ...game, seconds: 0 });
  }
  for (const segment of session.segments || []) {
    const appid = Number(segment.appid);
    const current = totals.get(appid) || { appid, name: segment.name || `App ${appid}`, image: segment.image || '', seconds: 0 };
    current.name = segment.name || current.name;
    current.image = segment.image || current.image;
    current.seconds += Math.max(0, Number(segment.seconds) || 0);
    totals.set(appid, current);
  }
  return [...totals.values()].sort((a, b) => b.seconds - a.seconds);
}

function historyEmpty(message) {
  const box = document.createElement('div');
  box.className = 'history-empty';
  box.textContent = message;
  return box;
}

function renderGameTotals(history) {
  const items = Array.isArray(history.gameTotals) ? history.gameTotals : [];
  const box = $('gameTotalsList');
  box.replaceChildren();
  $('gameTotalsCount').textContent = `${items.length} ${items.length === 1 ? 'gioco' : 'giochi'}`;
  if (!items.length) {
    box.append(historyEmpty('Nessun gioco ancora registrato.'));
    return;
  }
  for (const game of items) {
    const row = document.createElement('div');
    row.className = 'game-total-row';
    const img = document.createElement('img');
    img.src = game.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
    img.alt = game.name;
    img.onerror = () => gameFallback(img, game.appid);
    const info = document.createElement('div');
    info.className = 'game-total-info';
    const name = document.createElement('strong');
    name.textContent = game.name || `App ${game.appid}`;
    const meta = document.createElement('span');
    meta.textContent = `AppID ${game.appid} · ${Number(game.sessions) || 0} sessioni · ultimo boost ${formatDateTime(game.lastBoostedAt)}`;
    info.append(name, meta);
    const duration = document.createElement('div');
    duration.className = 'game-total-duration';
    const strong = document.createElement('strong');
    strong.textContent = formatLongDuration(game.totalSeconds);
    const small = document.createElement('span');
    small.textContent = `${((Number(game.totalSeconds) || 0) / 3600).toFixed(2)} ore`;
    duration.append(strong, small);
    row.append(img, info, duration);
    box.append(row);
  }
}

function renderDailyTotals(history) {
  const days = Array.isArray(history.dailyTotals) ? history.dailyTotals : [];
  const box = $('dailyTotalsList');
  box.replaceChildren();
  $('dailyTotalsCount').textContent = `${days.length} ${days.length === 1 ? 'giorno' : 'giorni'}`;
  if (!days.length) {
    box.append(historyEmpty('Nessun dato giornaliero.'));
    return;
  }
  days.forEach((day, index) => {
    const details = document.createElement('details');
    details.className = 'daily-total-card';
    if (index < 3) details.open = true;
    const summary = document.createElement('summary');
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = formatDayLabel(day.date);
    const sub = document.createElement('span');
    sub.textContent = `${(day.games || []).length} ${(day.games || []).length === 1 ? 'gioco' : 'giochi'}`;
    title.append(strong, sub);
    const total = document.createElement('div');
    total.className = 'daily-total-time';
    total.textContent = formatLongDuration(day.totalSeconds);
    summary.append(title, total);
    const games = document.createElement('div');
    games.className = 'daily-game-list';
    for (const game of day.games || []) {
      const row = document.createElement('div');
      row.className = 'daily-game-row';
      const left = document.createElement('div');
      const img = document.createElement('img');
      img.src = game.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
      img.alt = game.name;
      img.onerror = () => gameFallback(img, game.appid);
      const name = document.createElement('span');
      name.textContent = game.name || `App ${game.appid}`;
      left.append(img, name);
      const duration = document.createElement('strong');
      duration.textContent = formatLongDuration(game.seconds);
      row.append(left, duration);
      games.append(row);
    }
    details.append(summary, games);
    box.append(details);
  });
}

function renderSessionLog(history) {
  const sessions = Array.isArray(history.sessions) ? history.sessions : [];
  const box = $('sessionLogList');
  box.replaceChildren();
  $('sessionLogCount').textContent = `${sessions.length} ${sessions.length === 1 ? 'sessione' : 'sessioni'}`;
  if (!sessions.length) {
    box.append(historyEmpty('Il log apparirà dopo il primo boost.'));
    return;
  }
  for (const session of sessions) {
    const card = document.createElement('article');
    card.className = `session-log-card${session.running ? ' running' : ''}`;
    const head = document.createElement('div');
    head.className = 'session-log-head';
    const title = document.createElement('div');
    const status = document.createElement('span');
    status.className = `session-status${session.running ? ' running' : ''}`;
    status.textContent = session.running ? 'IN CORSO' : reasonLabel(session.reason).toUpperCase();
    const strong = document.createElement('strong');
    strong.textContent = `${modeLabel(session.mode)} · ${formatDateTime(session.startedAt)}`;
    title.append(status, strong);
    const duration = document.createElement('div');
    duration.className = 'session-duration';
    duration.textContent = formatLongDuration(session.seconds);
    head.append(title, duration);

    const metrics = document.createElement('div');
    metrics.className = 'session-metrics';
    const metricValues = [
      ['Avvio', formatDateTime(session.startedAt)],
      ['Fine', session.running ? 'Ancora in esecuzione' : formatDateTime(session.endedAt)],
      ['Totale prima', formatLongDuration(session.totalBeforeSeconds)],
      ['Totale dopo', formatLongDuration(session.totalAfterSeconds)]
    ];
    for (const [label, value] of metricValues) {
      const item = document.createElement('div');
      const small = document.createElement('span');
      small.textContent = label;
      const val = document.createElement('strong');
      val.textContent = value;
      item.append(small, val);
      metrics.append(item);
    }

    const gamesWrap = document.createElement('div');
    gamesWrap.className = 'session-games';
    for (const game of sessionGameDurations(session)) {
      const item = document.createElement('div');
      item.className = 'session-game';
      const img = document.createElement('img');
      img.src = game.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
      img.alt = game.name;
      img.onerror = () => gameFallback(img, game.appid);
      const text = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = game.name || `App ${game.appid}`;
      const sub = document.createElement('span');
      sub.textContent = `AppID ${game.appid} · ${formatLongDuration(game.seconds)}`;
      text.append(name, sub);
      item.append(img, text);
      gamesWrap.append(item);
    }
    card.append(head, metrics, gamesWrap);
    box.append(card);
  }
}

function svgElement(name, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function shortDayLabel(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return String(dateKey || '');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(date).replace('.', '');
}

function shiftDateKey(dateKey, offsetDays) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays, 12));
  return date.toISOString().slice(0, 10);
}

function showChartTooltip(event, text) {
  let tip = document.querySelector('.chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    document.body.append(tip);
  }
  tip.textContent = text;
  tip.style.left = `${event.clientX + 12}px`;
  tip.style.top = `${event.clientY + 12}px`;
  tip.classList.remove('hidden');
}

function hideChartTooltip() {
  const tip = document.querySelector('.chart-tooltip');
  if (tip) tip.classList.add('hidden');
}

function renderDailyHoursChart(history) {
  const host = $('dailyHoursChart');
  host.replaceChildren();
  const summary = history.periodSummary || {};
  const todayKey = summary.today || dateKeyInZone(new Date(), history.reportTimeZone || 'Europe/Rome');
  const byDate = new Map((history.dailyTotals || []).map((day) => [day.date, Math.max(0, Number(day.totalSeconds) || 0)]));
  const items = [];
  for (let offset = -13; offset <= 0; offset += 1) {
    const date = shiftDateKey(todayKey, offset);
    items.push({ date, seconds: byDate.get(date) || 0 });
  }

  const width = 760;
  const height = 270;
  const margin = { top: 20, right: 14, bottom: 42, left: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxHours = Math.max(1, ...items.map((item) => item.seconds / 3600));
  const roundedMax = Math.max(1, Math.ceil(maxHours * 2) / 2);
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const defs = svgElement('defs');
  const gradient = svgElement('linearGradient', { id: 'piboostBarGradient', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(svgElement('stop', { offset: '0%', 'stop-color': '#52d5ff' }), svgElement('stop', { offset: '100%', 'stop-color': '#2589d8' }));
  defs.append(gradient);
  svg.append(defs);

  for (let step = 0; step <= 4; step += 1) {
    const y = margin.top + (plotHeight * step / 4);
    svg.append(svgElement('line', { x1: margin.left, y1: y, x2: width - margin.right, y2: y, class: 'chart-grid-line' }));
    const label = svgElement('text', { x: margin.left - 8, y: y + 4, 'text-anchor': 'end', class: 'chart-axis-label' });
    label.textContent = `${(roundedMax * (4 - step) / 4).toFixed(1)}h`;
    svg.append(label);
  }

  const slot = plotWidth / items.length;
  const barWidth = Math.max(10, Math.min(28, slot * .58));
  items.forEach((item, index) => {
    const hours = item.seconds / 3600;
    const barHeight = Math.max(item.seconds > 0 ? 2 : 0, (hours / roundedMax) * plotHeight);
    const x = margin.left + index * slot + (slot - barWidth) / 2;
    const y = margin.top + plotHeight - barHeight;
    const bar = svgElement('rect', { x, y, width: barWidth, height: barHeight, class: 'chart-bar', rx: 5 });
    bar.addEventListener('mousemove', (event) => showChartTooltip(event, `${formatDayLabel(item.date)} · ${formatLongDuration(item.seconds)}`));
    bar.addEventListener('mouseleave', hideChartTooltip);
    svg.append(bar);
    if (index % 2 === 0 || index === items.length - 1) {
      const label = svgElement('text', { x: x + barWidth / 2, y: height - 15, 'text-anchor': 'middle', class: 'chart-axis-label' });
      label.textContent = shortDayLabel(item.date);
      svg.append(label);
    }
  });
  host.append(svg);
}

function truncateChartLabel(value, max = 22) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderGameHoursChart(history) {
  const host = $('gameHoursChart');
  host.replaceChildren();
  const items = (history.gameTotals || []).slice(0, 7);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'chart-empty';
    empty.textContent = 'Il grafico apparirà dopo il primo boost.';
    host.append(empty);
    return;
  }
  const width = 620;
  const rowHeight = 34;
  const height = Math.max(270, 42 + rowHeight * items.length);
  const labelWidth = 165;
  const right = 56;
  const maxSeconds = Math.max(1, ...items.map((item) => Number(item.totalSeconds) || 0));
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' });
  items.forEach((item, index) => {
    const y = 22 + index * rowHeight;
    const label = svgElement('text', { x: 0, y: y + 16, class: 'chart-game-label' });
    label.textContent = truncateChartLabel(item.name || `App ${item.appid}`);
    svg.append(label);
    const trackX = labelWidth;
    const trackWidth = width - labelWidth - right;
    svg.append(svgElement('rect', { x: trackX, y: y + 4, width: trackWidth, height: 15, rx: 7, class: 'chart-game-track' }));
    const fillWidth = Math.max(3, ((Number(item.totalSeconds) || 0) / maxSeconds) * trackWidth);
    const fill = svgElement('rect', { x: trackX, y: y + 4, width: fillWidth, height: 15, rx: 7, class: 'chart-game-fill' });
    fill.addEventListener('mousemove', (event) => showChartTooltip(event, `${item.name} · ${formatLongDuration(item.totalSeconds)}`));
    fill.addEventListener('mouseleave', hideChartTooltip);
    svg.append(fill);
    const value = svgElement('text', { x: width - 2, y: y + 16, 'text-anchor': 'end', class: 'chart-value-label' });
    value.textContent = formatLongDuration(item.totalSeconds);
    svg.append(value);
  });
  host.append(svg);
}

function renderHistory(history) {
  state.history = history;
  const timeZone = history.reportTimeZone || 'Europe/Rome';
  const period = history.periodSummary || {};
  const todayKey = period.today || dateKeyInZone(new Date(), timeZone);
  const today = (history.dailyTotals || []).find((day) => day.date === todayKey);
  $('historyTotalTime').textContent = formatLongDuration(history.totalSeconds);
  $('historySessionCount').textContent = String((history.sessions || []).length);
  $('historyGameCount').textContent = String((history.gameTotals || []).length);
  $('historyTodayTime').textContent = formatLongDuration(period.todaySeconds ?? (today ? today.totalSeconds : 0));
  $('historyWeekTime').textContent = formatLongDuration(period.weekSeconds || 0);
  $('historyMonthTime').textContent = formatLongDuration(period.monthSeconds || 0);
  $('historyTimeZone').textContent = `Fuso orario ${timeZone}`;
  renderDailyHoursChart(history);
  renderGameHoursChart(history);
  renderGameTotals(history);
  renderDailyTotals(history);
  renderSessionLog(history);
}

async function refreshHistory({ silent = false } = {}) {
  if (!state.token || state.historyBusy) return false;
  state.historyBusy = true;
  if (!silent) $('refreshHistoryBtn').disabled = true;
  try {
    renderHistory(await api('/history'));
    return true;
  } catch (error) {
    if (!silent) toast(error.message, true);
    return false;
  } finally {
    state.historyBusy = false;
    if (!silent) $('refreshHistoryBtn').disabled = false;
  }
}

function avatarFallback(img) {
  img.onerror = null;
  img.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="100%" height="100%" fill="#20344d"/><circle cx="40" cy="31" r="14" fill="#7690ac"/><path d="M15 72c3-17 14-25 25-25s22 8 25 25" fill="#7690ac"/></svg>');
}

function gameFallback(img, appid) {
  img.onerror = null;
  img.src = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="184" height="86"><rect width="100%" height="100%" rx="8" fill="#20344d"/><text x="50%" y="52%" fill="#9fb2ca" font-family="Arial" font-size="13" text-anchor="middle">AppID ${appid}</text></svg>`);
}

function payloadFor(game) {
  return encodeURIComponent(JSON.stringify({
    appid: Number(game.appid),
    name: String(game.name || `App ${game.appid}`),
    image: String(game.image || '')
  }));
}

function stopLoginPolling() {
  clearTimeout(state.loginTimer);
  state.loginTimer = null;
  state.loginBusy = false;
}

function setMethodButtons(mode) {
  state.authMode = mode;
  const password = mode === 'password';
  const qr = !password;
  $('passwordMethodBtn').classList.toggle('active', password);
  $('passwordMethodBtn').setAttribute('aria-selected', String(password));
  $('qrMethodBtn').classList.toggle('active', qr);
  $('qrMethodBtn').setAttribute('aria-selected', String(qr));
  $('loginPanel').classList.toggle('qr-mode', qr);
  $('loginLayout').classList.toggle('qr-mode', qr);
}

function resetLoginUi({ keepAccountName = true, keepMode = true } = {}) {
  stopLoginPolling();
  if (!keepMode) setMethodButtons('password');
  state.loginId = '';
  state.qrStarting = false;
  $('loginBtn').disabled = false;
  $('guardSubmitBtn').disabled = false;
  $('approvedBtn').disabled = false;
  $('newQrBtn').disabled = false;
  $('steamPassword').value = '';
  $('guardCode').value = '';
  if (!keepAccountName) $('steamAccountName').value = '';
  $('verificationPanel').classList.add('hidden');
  $('approvalOption').classList.add('hidden');
  $('approvedBtn').classList.add('hidden');
  $('guardForm').classList.add('hidden');
  $('verificationDivider').classList.add('hidden');
  $('steamQrImage').classList.add('hidden');
  $('steamQrImage').removeAttribute('src');
  $('qrLoading').classList.add('hidden');
  $('steamLoginForm').classList.toggle('hidden', state.authMode !== 'password');
  $('qrLoginPanel').classList.toggle('hidden', state.authMode !== 'qr');
}

async function cancelCurrentLogin() {
  const loginId = state.loginId;
  state.loginId = '';
  stopLoginPolling();
  if (!loginId) return;
  try {
    await publicApi('/auth/steam-cancel', {
      method: 'POST',
      body: JSON.stringify({ loginId })
    });
  } catch (_error) {}
}

function applyMaintenanceState(maintenance = {}) {
  state.maintenance = {
    enabled: Boolean(maintenance.enabled),
    message: String(maintenance.message || 'PiBoost è temporaneamente in manutenzione.')
  };
  const enabled = state.maintenance.enabled;
  $('maintenanceGate').classList.toggle('hidden', !enabled);
  $('maintenanceGateMessage').textContent = state.maintenance.message;
  for (const id of ['passwordMethodBtn', 'qrMethodBtn', 'loginBtn', 'newQrBtn']) {
    if ($(id)) $(id).disabled = enabled;
  }
  if (enabled && !state.loginId) {
    $('steamLoginForm').classList.add('hidden');
    $('qrLoginPanel').classList.add('hidden');
    $('verificationPanel').classList.add('hidden');
    setLoginStatus(state.maintenance.message);
  } else if (!enabled && !$('loginScreen').classList.contains('hidden') && !state.loginId) {
    $('steamLoginForm').classList.toggle('hidden', state.authMode !== 'password');
    $('qrLoginPanel').classList.toggle('hidden', state.authMode !== 'qr');
  }
}

async function refreshPublicState() {
  try {
    const info = await publicApi('/public-state');
    applyMaintenanceState(info.maintenance || {});
    return info;
  } catch (_error) {
    return null;
  }
}

function enterLogin(message = 'Scegli nome e password oppure QR Code.', error = false) {
  state.token = '';
  state.data = null;
  localStorage.removeItem('piboostToken');
  resetLoginUi({ keepMode: false });
  setLoginStatus(message, error);
  $('appShell').classList.add('hidden');
  $('loginScreen').classList.remove('hidden');
  document.body.classList.add('login-active');
  $('profileMenu').classList.remove('open');
  state.currentView = 'dashboard';
  for (const id of ['dashboardContent', 'historyContent', 'settingsContent']) {
    if ($(id)) $(id).classList.toggle('hidden', id !== 'dashboardContent');
  }
  $('dashboardNavBtn').classList.add('active');
  $('historyNavBtn').classList.remove('active');
  $('settingsNavBtn').classList.remove('active');
  refreshPublicState();
}

function enterApp() {
  $('loginScreen').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  document.body.classList.remove('login-active');
}

function finishLogin(result) {
  stopLoginPolling();
  state.token = result.token;
  localStorage.setItem('piboostToken', state.token);
  resetLoginUi({ keepAccountName: false, keepMode: false });
  enterApp();
  refresh();
  toast(`Accesso completato${result.profile && result.profile.personaName ? `: ${result.profile.personaName}` : ''}.`);
}

function scheduleLoginPoll(delay = 900) {
  clearTimeout(state.loginTimer);
  if (!state.loginId) return;
  state.loginTimer = setTimeout(pollLogin, delay);
}

function renderLoginAttempt(result) {
  setLoginStatus(result.message || 'Connessione a Steam...');

  if (result.qrImage) {
    $('steamQrImage').src = result.qrImage;
    $('steamQrImage').classList.remove('hidden');
    $('qrLoading').classList.add('hidden');
  }

  const showVerification = Boolean(result.verificationRequired || result.canApprove || result.canCode || result.remoteInteraction);
  if (state.authMode === 'password') $('steamLoginForm').classList.toggle('hidden', showVerification);
  $('verificationPanel').classList.toggle('hidden', !showVerification);

  $('approvalOption').classList.toggle('hidden', !result.canApprove);
  $('approvedBtn').classList.toggle('hidden', !result.canApprove);
  $('guardForm').classList.toggle('hidden', !result.canCode);
  $('verificationDivider').classList.toggle('hidden', !(result.canApprove && result.canCode));

  if (result.canCode) {
    $('guardCodeLabel').textContent = result.codeKind === 'email'
      ? `Codice inviato via email${result.guardDetail ? ` (${result.guardDetail})` : ''}`
      : 'Codice Steam Guard dell’app';
  }

  if (result.remoteInteraction) {
    $('guardHint').textContent = 'Richiesta aperta nell’app Steam: premi Approva.';
  } else if (result.canApprove && result.canCode) {
    $('guardHint').textContent = 'Scegli: approva dall’app oppure inserisci il codice.';
  } else if (result.canApprove) {
    $('guardHint').textContent = 'Apri l’app Steam e premi Approva.';
  } else if (result.canCode) {
    $('guardHint').textContent = 'Inserisci il codice Steam Guard.';
  }
}

async function pollLogin() {
  if (!state.loginId || state.loginBusy) return;
  state.loginBusy = true;
  let continuePolling = true;
  try {
    const result = await publicApi(`/auth/steam-status?loginId=${encodeURIComponent(state.loginId)}`);
    renderLoginAttempt(result);
    if (result.authenticated && result.token) {
      continuePolling = false;
      finishLogin(result);
      return;
    }
    if (result.connection === 'error') {
      continuePolling = false;
      const message = result.message || 'Accesso Steam non riuscito.';
      resetLoginUi({ keepMode: true });
      setLoginStatus(message, true);
    }
  } catch (error) {
    continuePolling = false;
    resetLoginUi({ keepMode: true });
    setLoginStatus(error.message, true);
  } finally {
    state.loginBusy = false;
    if (continuePolling && state.loginId) scheduleLoginPoll();
  }
}

async function startQrLogin() {
  if (state.qrStarting) return;
  state.qrStarting = true;
  await cancelCurrentLogin();
  setMethodButtons('qr');
  $('steamLoginForm').classList.add('hidden');
  $('qrLoginPanel').classList.remove('hidden');
  $('verificationPanel').classList.add('hidden');
  $('steamQrImage').classList.add('hidden');
  $('qrLoading').classList.remove('hidden');
  $('newQrBtn').disabled = true;
  setLoginStatus('Generazione del QR Code Steam...');

  try {
    const result = await publicApi('/auth/steam-qr', { method: 'POST', body: '{}' });
    state.loginId = result.loginId;
    renderLoginAttempt(result.status || {});
    scheduleLoginPoll(250);
  } catch (error) {
    $('qrLoading').classList.add('hidden');
    setLoginStatus(error.message, true);
  } finally {
    state.qrStarting = false;
    $('newQrBtn').disabled = false;
  }
}

$('passwordMethodBtn').addEventListener('click', async () => {
  await cancelCurrentLogin();
  setMethodButtons('password');
  resetLoginUi({ keepMode: true });
  $('steamLoginForm').classList.remove('hidden');
  $('qrLoginPanel').classList.add('hidden');
  setLoginStatus('Inserisci il nome account e la password Steam.');
});

$('qrMethodBtn').addEventListener('click', startQrLogin);
$('newQrBtn').addEventListener('click', startQrLogin);

$('steamLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await cancelCurrentLogin();
  setMethodButtons('password');
  $('loginBtn').disabled = true;
  setLoginStatus('Avvio dell’accesso Steam...');
  try {
    const result = await publicApi('/auth/steam-login', {
      method: 'POST',
      body: JSON.stringify({
        accountName: $('steamAccountName').value.trim(),
        password: $('steamPassword').value
      })
    });
    $('steamPassword').value = '';
    state.loginId = result.loginId;
    renderLoginAttempt(result.status || {});
    scheduleLoginPoll(250);
  } catch (error) {
    $('steamPassword').value = '';
    $('loginBtn').disabled = false;
    setLoginStatus(error.message, true);
  }
});

$('guardForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('guardSubmitBtn').disabled = true;
  try {
    await publicApi('/auth/steam-guard', {
      method: 'POST',
      body: JSON.stringify({ loginId: state.loginId, code: $('guardCode').value.trim() })
    });
    $('guardCode').value = '';
    setLoginStatus('Codice inviato. Attendo la conferma di Steam...');
    scheduleLoginPoll(150);
  } catch (error) {
    setLoginStatus(error.message, true);
  } finally {
    $('guardSubmitBtn').disabled = false;
  }
});

$('approvedBtn').addEventListener('click', async () => {
  $('approvedBtn').disabled = true;
  try {
    await publicApi('/auth/steam-force-poll', {
      method: 'POST',
      body: JSON.stringify({ loginId: state.loginId })
    });
    setLoginStatus('Controllo della conferma nell’app Steam...');
    await pollLogin();
  } catch (error) {
    setLoginStatus(error.message, true);
  } finally {
    $('approvedBtn').disabled = false;
  }
});

$('backToLoginBtn').addEventListener('click', async () => {
  await cancelCurrentLogin();
  setMethodButtons('password');
  resetLoginUi({ keepMode: true });
  $('steamLoginForm').classList.remove('hidden');
  $('qrLoginPanel').classList.add('hidden');
  setLoginStatus('Tentativo annullato. Scegli un metodo di accesso.');
});

function updateLogoutModeUi() {
  const keep = Boolean($('keepBoostOnLogout').checked);
  const boosting = Boolean(state.data && (state.data.boosting || state.data.desiredBoosting));
  $('logoutBtnText').textContent = keep ? 'Esci e continua il boost' : 'Log out completo';
}

async function logout() {
  const keepRequested = Boolean($('keepBoostOnLogout').checked);
  const boosting = Boolean(state.data && (state.data.boosting || state.data.desiredBoosting));
  const keepBoost = keepRequested && boosting;
  const question = keepBoost
    ? 'Uscire dal pannello lasciando il boost attivo sul Raspberry? Per fermarlo dovrai rientrare, usare Stop oppure riavviare PiBoost.'
    : 'Fare un logout completo? Il boost verrà fermato, Steam verrà disconnesso e il token sarà rimosso. Giochi, preferiti, impostazioni e statistiche resteranno salvati.';
  if (!confirm(question)) return;

  const oldToken = state.token;
  let continuedBoost = false;
  try {
    if (oldToken) {
      const response = await fetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oldToken}` },
        body: JSON.stringify({
          continueBoost: keepBoost,
          keepBoostOnLogout: keepRequested,
          autoStartBoostOnBoot: Boolean($('autoStartBoostOnBoot').checked)
        })
      });
      const result = await response.json().catch(() => ({}));
      continuedBoost = Boolean(response.ok && result.continuedBoost);
    }
  } catch (_error) {
    // Anche se il Raspberry non risponde, la sessione del browser viene sempre cancellata.
  }

  enterLogin(continuedBoost
    ? 'Sei uscito dal pannello. Il boost continua sul Raspberry e verrà ritrovato al prossimo accesso.'
    : 'Logout completo. Boost fermato; giochi, preferiti e storico restano salvati sul Raspberry.');
}

async function saveLogoutPreference() {
  const checkbox = $('keepBoostOnLogout');
  const requested = Boolean(checkbox.checked);
  updateLogoutModeUi();
  if (!state.token || state.logoutPreferenceBusy) return;

  state.logoutPreferenceBusy = true;
  checkbox.disabled = true;
  try {
    const data = await api('/preferences/logout', {
      method: 'PUT',
      body: JSON.stringify({ keepBoostOnLogout: requested })
    });
    render(data);
    toast(requested
      ? 'La preferenza “Continua il boost dopo il logout” è stata salvata.'
      : 'La preferenza è stata disattivata.');
  } catch (error) {
    checkbox.checked = !requested;
    if (state.data && state.data.settings) {
      state.data.settings.keepBoostOnLogout = !requested;
    }
    updateLogoutModeUi();
    toast(error.message, true);
  } finally {
    state.logoutPreferenceBusy = false;
    checkbox.disabled = false;
  }
}

async function saveBootPreference() {
  const checkbox = $('autoStartBoostOnBoot');
  const requested = Boolean(checkbox.checked);
  if (!state.token || state.bootPreferenceBusy) return;

  state.bootPreferenceBusy = true;
  checkbox.disabled = true;
  try {
    const data = await api('/preferences/boot', {
      method: 'PUT',
      body: JSON.stringify({ autoStartBoostOnBoot: requested })
    });
    render(data);
    toast(requested
      ? 'Avvio automatico del boost salvato. Ripartirà al prossimo riavvio.'
      : 'Avvio automatico al riavvio disattivato.');
  } catch (error) {
    checkbox.checked = !requested;
    if (state.data && state.data.settings) {
      state.data.settings.autoStartBoostOnBoot = !requested;
    }
    toast(error.message, true);
  } finally {
    state.bootPreferenceBusy = false;
    checkbox.disabled = false;
  }
}

$('keepBoostOnLogout').addEventListener('change', saveLogoutPreference);
$('autoStartBoostOnBoot').addEventListener('change', saveBootPreference);
$('logoutBtn').addEventListener('click', logout);
$('profileTrigger').addEventListener('click', () => {
  updateLogoutModeUi();
  const menu = $('profileMenu');
  const open = menu.classList.toggle('open');
  $('profileTrigger').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#profileMenu')) {
    $('profileMenu').classList.remove('open');
    $('profileTrigger').setAttribute('aria-expanded', 'false');
  }
});

function isFavorite(appid) {
  return Boolean(state.data && state.data.favorites && state.data.favorites.some((game) => Number(game.appid) === Number(appid)));
}

function favoriteByAppid(appid) {
  return state.data && state.data.favorites
    ? state.data.favorites.find((game) => Number(game.appid) === Number(appid))
    : null;
}

function renderActiveGames(games, active = false) {
  const box = $('activeGamesPreview');
  box.replaceChildren();
  if (!games.length) {
    const empty = document.createElement('span');
    empty.className = 'muted small';
    empty.textContent = active ? 'Nessun gioco attivo' : 'Nessun gioco salvato';
    box.append(empty);
    return;
  }
  for (const game of games.slice(0, 10)) {
    const card = document.createElement('div');
    card.className = `mini-game-card${active ? ' active' : ''}`;
    const img = document.createElement('img');
    img.src = game.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
    img.alt = game.name;
    img.onerror = () => gameFallback(img, game.appid);
    const name = document.createElement('span');
    name.textContent = game.name;
    card.append(img, name);
    if (active) {
      const tag = document.createElement('div');
      tag.className = 'active-tag';
      tag.textContent = 'Attivo';
      card.append(tag);
    }
    box.append(card);
  }
  if (games.length > 10) {
    const more = document.createElement('div');
    more.className = 'more-games';
    more.textContent = `+${games.length - 10}`;
    box.append(more);
  }
}

function render(data) {
  state.data = data;
  const boosting = Boolean(data.boosting);
  const online = data.connection === 'online';
  const connecting = data.connection === 'connecting' || data.connection === 'guard_required';
  const activeGames = Array.isArray(data.activeGames) ? data.activeGames : [];
  const favorites = Array.isArray(data.favorites) ? data.favorites : [];
  const games = Array.isArray(data.games) ? data.games : [];
  const maintenance = data.maintenance || state.maintenance || {};
  state.maintenance = { enabled: Boolean(maintenance.enabled), message: String(maintenance.message || '') };
  const maintenanceEnabled = state.maintenance.enabled;
  const keepBoostOnLogout = Boolean(data.settings && data.settings.keepBoostOnLogout);
  const autoStartBoostOnBoot = Boolean(data.settings && data.settings.autoStartBoostOnBoot);
  if (!state.logoutPreferenceBusy) {
    $('keepBoostOnLogout').checked = keepBoostOnLogout;
    updateLogoutModeUi();
  }
  if (!state.bootPreferenceBusy) {
    $('autoStartBoostOnBoot').checked = autoStartBoostOnBoot;
  }

  $('plansRunning').textContent = boosting ? '1' : '0';
  $('gamesBoosting').textContent = boosting ? String(activeGames.length) : '0';
  $('sessionTime').textContent = String(Math.floor((data.activeSeconds || 0) / 60));
  $('totalTime').textContent = ((data.totalSeconds || 0) / 3600).toFixed((data.totalSeconds || 0) >= 36000 ? 0 : 1);
  $('gamesValue').textContent = `${games.length} / 32`;
  $('favoriteValue').textContent = String(favorites.length);
  $('favoritesBadge').textContent = String(favorites.length);
  $('uptimeValue').textContent = data.activeSeconds ? formatDuration(data.activeSeconds) : '--';
  $('steamIdValue').textContent = data.profile.steamId64 || data.steamId64 || 'Rilevamento...';

  const name = data.profile.personaName || data.profile.accountName || (online ? 'Steam' : 'Non collegato');
  $('accountName').textContent = name;
  $('topName').textContent = name;
  $('menuName').textContent = name;
  $('settingsSteamName').textContent = name;
  $('menuSteamId').textContent = data.profile.steamId64 || data.steamId64 || 'SteamID64 in rilevamento';
  const ownerAccess = Boolean(data.owner);
  if ($('adminEntryBtn')) $('adminEntryBtn').classList.toggle('hidden', !ownerAccess);
  if ($('adminNavBtn')) $('adminNavBtn').classList.toggle('hidden', !ownerAccess);
  const avatar = data.profile.avatar || '';
  for (const id of ['accountAvatar', 'topAvatar', 'menuAvatar']) {
    const img = $(id);
    img.onerror = () => avatarFallback(img);
    if (avatar) img.src = avatar; else avatarFallback(img);
  }

  const dot = $('statusDot');
  dot.className = `dot${online ? ' online' : connecting ? ' connecting' : ''}`;
  $('statusText').textContent = maintenanceEnabled && !boosting ? (state.maintenance.message || 'Modalità manutenzione') : (boosting ? data.message : (data.message || 'Fermato'));
  $('startBtn').disabled = maintenanceEnabled || !online || !games.length || (boosting && data.boostMode === 'games');
  $('stopBtn').disabled = !boosting && !data.desiredBoosting;
  for (const id of ['gamesBtn', 'gamesNavBtn', 'favoritesBtn', 'favoritesNavBtn', 'settingsNavBtn']) {
    if ($(id)) $(id).disabled = maintenanceEnabled;
  }

  const pill = $('boostModePill');
  pill.className = 'mode-pill';
  if (boosting && data.boostMode === 'favorite') {
    const game = activeGames[0];
    pill.classList.add('favorite');
    pill.textContent = `★ Preferito${game ? ` · ${game.name}` : ''}`;
  } else if (boosting && data.boostMode === 'games') {
    pill.classList.add('games');
    pill.textContent = `⌘ Giochi multipli · ${activeGames.length}`;
  } else {
    pill.textContent = 'Nessun boost';
  }


  const previewGames = boosting ? activeGames : games;
  $('previewTitle').textContent = boosting ? 'Giochi attivi' : 'Giochi salvati';
  $('previewCount').textContent = String(previewGames.length);
  renderActiveGames(previewGames, boosting);
  renderFavorites();
}

async function refresh({ bootstrap = false } = {}) {
  if (!state.token || state.refreshBusy) return false;
  state.refreshBusy = true;
  try {
    const data = await api('/status');
    render(data);
    enterApp();
    return true;
  } catch (error) {
    if (bootstrap && state.token) enterLogin(error.message, true);
    else if (state.token) toast(error.message, true);
    return false;
  } finally {
    state.refreshBusy = false;
  }
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function openGames() {
  state.selectedGames = (state.data && state.data.games ? state.data.games : []).map((game) => ({ ...game }));
  state.searchItems = [];
  renderSelectedGames();
  $('gameSearch').value = '';
  $('searchResults').classList.add('hidden');
  setGamesSaveStatus('Salvato sul Raspberry');
  openModal('gamesModal');
  setTimeout(() => $('gameSearch').focus(), 30);
}

function openFavorites() {
  renderFavorites();
  openModal('favoritesModal');
}

function populateSettingsFields() {
  if (!state.data) return;
  const settings = state.data.settings || {};
  for (const key of ['customTitleEnabled', 'awayMessageEnabled', 'autoRestart', 'autoFriend', 'autoStopEnabled', 'cardFarmer']) $(key).checked = Boolean(settings[key]);
  for (const key of ['customTitle', 'awayMessage', 'persona', 'uiMode', 'autoStopHours', 'cardCycleMinutes']) {
    if (settings[key] !== undefined && settings[key] !== null) $(key).value = settings[key];
  }
}

function showContent(view) {
  state.currentView = view;
  $('dashboardContent').classList.toggle('hidden', view !== 'dashboard');
  $('historyContent').classList.toggle('hidden', view !== 'history');
  $('settingsContent').classList.toggle('hidden', view !== 'settings');
  $('dashboardNavBtn').classList.toggle('active', view === 'dashboard');
  $('historyNavBtn').classList.toggle('active', view === 'history');
  $('settingsNavBtn').classList.toggle('active', view === 'settings');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showDashboard() {
  showContent('dashboard');
}

function openHistory() {
  showContent('history');
  refreshHistory();
}

function openSettings() {
  if (!state.data) return;
  populateSettingsFields();
  showContent('settings');
}

$('gamesBtn').addEventListener('click', openGames);
$('gamesNavBtn').addEventListener('click', openGames);
$('favoritesBtn').addEventListener('click', openFavorites);
$('favoritesNavBtn').addEventListener('click', openFavorites);
$('historyNavBtn').addEventListener('click', openHistory);
$('refreshHistoryBtn').addEventListener('click', () => refreshHistory());
$('settingsNavBtn').addEventListener('click', openSettings);
$('settingsBackBtn').addEventListener('click', showDashboard);
$('cancelSettingsBtn').addEventListener('click', () => { populateSettingsFields(); showDashboard(); });
$('dashboardNavBtn').addEventListener('click', showDashboard);

$('startBtn').addEventListener('click', async () => {
  try {
    await state.gamesSaveQueue.catch(() => {});
    const games = state.selectedGames.length
      ? state.selectedGames
      : ((state.data && state.data.games) || []);
    render(await api('/boost/start', { method: 'POST', body: JSON.stringify({ games }) }));
    state.selectedGames = games.map((game) => ({ ...game }));
    toast('Giochi salvati e boost multiplo avviato.');
  } catch (error) { toast(error.message, true); }
});
$('stopBtn').addEventListener('click', async () => {
  try {
    render(await api('/boost/stop', { method: 'POST', body: '{}' }));
    toast('Boost fermato.');
  } catch (error) { toast(error.message, true); }
});

async function toggleFavorite(game) {
  if (!state.data) return;
  const favorites = (state.data.favorites || []).map((item) => ({ ...item }));
  const exists = favorites.some((item) => Number(item.appid) === Number(game.appid));
  const next = exists
    ? favorites.filter((item) => Number(item.appid) !== Number(game.appid))
    : [...favorites, { appid: Number(game.appid), name: String(game.name), image: String(game.image || '') }];
  try {
    render(await api('/favorites', { method: 'PUT', body: JSON.stringify({ favorites: next }) }));
    renderSearchResults(state.searchItems);
    renderSelectedGames();
    toast(exists ? `${game.name} rimosso dai preferiti.` : `${game.name} aggiunto ai preferiti.`);
  } catch (error) { toast(error.message, true); }
}

async function startFavorite(appid) {
  const game = favoriteByAppid(appid);
  if (!game) return toast('Preferito non trovato.', true);
  try {
    render(await api('/boost/favorite', { method: 'POST', body: JSON.stringify({ appid: Number(appid) }) }));
    closeModal('favoritesModal');
    toast(`Boost avviato: ${game.name}.`);
  } catch (error) { toast(error.message, true); }
}

function setGamesSaveStatus(message, error = false) {
  const label = $('gamesSaveStatus');
  if (!label) return;
  label.textContent = message;
  label.classList.toggle('error', error);
}

function queueGamesAutosave() {
  const snapshot = state.selectedGames.map((game) => ({
    appid: Number(game.appid),
    name: String(game.name || `App ${game.appid}`),
    image: String(game.image || '')
  }));
  state.gamesSavePending = true;
  setGamesSaveStatus('Salvataggio...');
  state.gamesSaveQueue = state.gamesSaveQueue
    .catch(() => {})
    .then(async () => {
      const result = await api('/games', { method: 'PUT', body: JSON.stringify({ games: snapshot }) });
      render(result);
      setGamesSaveStatus('Salvato automaticamente');
      return result;
    })
    .catch((error) => {
      setGamesSaveStatus('Errore nel salvataggio', true);
      toast(error.message, true);
      throw error;
    })
    .finally(() => { state.gamesSavePending = false; });
  return state.gamesSaveQueue;
}

document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close]');
  if (close) closeModal(close.dataset.close);

  const add = event.target.closest('[data-add-appid]');
  if (add) {
    const item = JSON.parse(decodeURIComponent(add.dataset.payload));
    if (!state.selectedGames.some((game) => Number(game.appid) === Number(item.appid)) && state.selectedGames.length < 32) {
      state.selectedGames.push(item);
      renderSelectedGames();
      queueGamesAutosave();
    }
  }

  const remove = event.target.closest('[data-remove-appid]');
  if (remove) {
    state.selectedGames = state.selectedGames.filter((game) => Number(game.appid) !== Number(remove.dataset.removeAppid));
    renderSelectedGames();
    queueGamesAutosave();
  }

  const favorite = event.target.closest('[data-toggle-favorite]');
  if (favorite) {
    event.preventDefault();
    event.stopPropagation();
    const item = JSON.parse(decodeURIComponent(favorite.dataset.payload));
    toggleFavorite(item);
  }

  const launch = event.target.closest('[data-start-favorite]');
  if (launch) startFavorite(Number(launch.dataset.startFavorite));
});

function renderSelectedGames() {
  const box = $('selectedGames');
  box.replaceChildren();
  if (!state.selectedGames.length) {
    const text = document.createElement('span');
    text.className = 'muted small';
    text.textContent = 'Nessun gioco selezionato';
    box.append(text);
  }
  for (const game of state.selectedGames) {
    const card = document.createElement('div');
    card.className = 'selected-game-card';
    const img = document.createElement('img');
    img.src = game.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
    img.alt = game.name;
    img.onerror = () => gameFallback(img, game.appid);
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = game.name;
    const sub = document.createElement('span');
    sub.textContent = `AppID ${game.appid}`;
    info.append(title, sub);
    const actions = document.createElement('div');
    actions.className = 'selected-card-actions';
    const star = document.createElement('button');
    star.type = 'button';
    star.className = `card-icon-btn${isFavorite(game.appid) ? ' active' : ''}`;
    star.textContent = '★';
    star.title = isFavorite(game.appid) ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
    star.dataset.toggleFavorite = String(game.appid);
    star.dataset.payload = payloadFor(game);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'card-icon-btn remove';
    remove.textContent = '×';
    remove.title = 'Rimuovi dai giochi multipli';
    remove.dataset.removeAppid = game.appid;
    actions.append(star, remove);
    card.append(img, info, actions);
    box.append(card);
  }
  $('gamesCounter').textContent = `${state.selectedGames.length} / 32`;
}

function renderSearchResults(items) {
  const box = $('searchResults');
  box.replaceChildren();
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'search-item';
    const img = document.createElement('img');
    img.className = 'game-cover';
    img.src = item.image;
    img.alt = item.name;
    img.onerror = () => gameFallback(img, item.appid);
    const text = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'search-title';
    title.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'small muted';
    sub.textContent = `AppID ${item.appid}`;
    text.append(title, sub);
    const actions = document.createElement('div');
    actions.className = 'search-actions';
    const star = document.createElement('button');
    star.className = `icon-btn star${isFavorite(item.appid) ? ' active' : ''}`;
    star.type = 'button';
    star.textContent = '★';
    star.title = isFavorite(item.appid) ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
    star.dataset.toggleFavorite = String(item.appid);
    star.dataset.payload = payloadFor(item);
    const add = document.createElement('button');
    add.className = 'icon-btn';
    add.type = 'button';
    add.textContent = '+';
    add.title = 'Aggiungi ai giochi multipli';
    add.dataset.addAppid = item.appid;
    add.dataset.payload = payloadFor(item);
    actions.append(star, add);
    row.append(img, text, actions);
    box.append(row);
  }
  if (!items.length) {
    const none = document.createElement('div');
    none.className = 'search-empty';
    none.textContent = 'Nessun risultato. Prova con l’AppID.';
    box.append(none);
  }
  box.classList.remove('hidden');
}

function renderFavorites() {
  const box = $('favoritesList');
  if (!box || !state.data) return;
  const favorites = state.data.favorites || [];
  box.replaceChildren();
  $('favoritesCounter').textContent = `${favorites.length} ${favorites.length === 1 ? 'preferito' : 'preferiti'}`;
  if (!favorites.length) {
    const empty = document.createElement('div');
    empty.className = 'favorite-empty';
    const strong = document.createElement('strong');
    strong.textContent = 'Nessun preferito';
    const span = document.createElement('span');
    span.textContent = 'Apri Giochi e premi la stella accanto a un titolo.';
    empty.append(strong, span);
    box.append(empty);
    return;
  }

  for (const game of favorites) {
    const running = Boolean(state.data.boosting && state.data.boostMode === 'favorite' && Number(state.data.activeFavoriteAppId) === Number(game.appid));
    const card = document.createElement('div');
    card.className = `favorite-card${running ? ' running' : ''}`;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'favorite-card-main';
    main.dataset.startFavorite = game.appid;
    const img = document.createElement('img');
    img.src = game.image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`;
    img.alt = game.name;
    img.onerror = () => gameFallback(img, game.appid);
    const info = document.createElement('div');
    info.className = 'favorite-card-info';
    const title = document.createElement('strong');
    title.textContent = game.name;
    const appid = document.createElement('span');
    appid.textContent = `AppID ${game.appid}`;
    const play = document.createElement('span');
    play.className = 'favorite-play';
    play.textContent = running ? 'Boost attivo' : 'Avvia questo preferito →';
    info.append(title, appid, play);
    main.append(img, info);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'favorite-remove';
    remove.textContent = '★';
    remove.title = 'Rimuovi dai preferiti';
    remove.dataset.toggleFavorite = String(game.appid);
    remove.dataset.payload = payloadFor(game);
    card.append(main, remove);
    if (running) {
      const label = document.createElement('div');
      label.className = 'favorite-running-label';
      label.textContent = 'IN ESECUZIONE';
      card.append(label);
    }
    box.append(card);
  }
}

$('gameSearch').addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  const query = $('gameSearch').value.trim();
  if (query.length < 2) {
    state.searchItems = [];
    $('searchResults').classList.add('hidden');
    return;
  }
  state.searchTimer = setTimeout(async () => {
    try {
      const result = await api(`/games/search?q=${encodeURIComponent(query)}`);
      state.searchItems = result.items || [];
      renderSearchResults(state.searchItems);
    } catch (error) { toast(error.message, true); }
  }, 350);
});

$('saveGamesBtn').addEventListener('click', async () => {
  try {
    await queueGamesAutosave();
    closeModal('gamesModal');
    toast('Elenco dei giochi salvato sul Raspberry.');
  } catch (_error) {}
});

$('saveSettingsBtn').addEventListener('click', async () => {
  const payload = {};
  for (const key of ['customTitleEnabled', 'awayMessageEnabled', 'autoRestart', 'autoFriend', 'autoStopEnabled', 'cardFarmer']) payload[key] = $(key).checked;
  for (const key of ['customTitle', 'awayMessage', 'persona', 'uiMode']) payload[key] = $(key).value;
  payload.autoStopHours = Number($('autoStopHours').value);
  payload.cardCycleMinutes = Number($('cardCycleMinutes').value);
  try {
    render(await api('/settings', { method: 'PUT', body: JSON.stringify(payload) }));
    populateSettingsFields();
    toast('Impostazioni salvate.');
  } catch (error) { toast(error.message, true); }
});

$('refreshProfileBtn').addEventListener('click', async () => {
  try {
    render(await api('/profile/refresh', { method: 'POST', body: '{}' }));
    toast('Nome e avatar aggiornati.');
  } catch (error) { toast(error.message, true); }
});

async function openOwnerAdmin() {
  if (!state.data || !state.data.owner) {
    toast('Il tuo account Steam non è autorizzato come owner.', true);
    return;
  }
  const buttons = [$('adminEntryBtn'), $('adminNavBtn')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api('/owner/session', { method: 'POST', body: '{}' });
    window.location.assign(result.ownerAuthUrl || `${basePath}/owner-auth`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

$('adminEntryBtn').addEventListener('click', openOwnerAdmin);
$('adminNavBtn').addEventListener('click', openOwnerAdmin);

async function bootstrap() {
  await refreshPublicState();
  if (state.token) {
    const ok = await refresh({ bootstrap: true });
    if (!ok && !state.token) return;
  } else {
    enterLogin();
  }
}

bootstrap();
setInterval(() => {
  if (state.token && !$('appShell').classList.contains('hidden')) refresh();
}, 2500);

setInterval(() => {
  if (state.token && state.currentView === 'history' && !$('appShell').classList.contains('hidden')) refreshHistory({ silent: true });
}, 5000);

setInterval(() => {
  if (!state.token && !$('loginScreen').classList.contains('hidden')) refreshPublicState();
}, 10000);
