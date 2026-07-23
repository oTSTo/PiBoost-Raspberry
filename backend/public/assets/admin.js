'use strict';

const pagePath = window.location.pathname.replace(/\/admin\/?$/, '');
const basePath = pagePath || '/steamboost';
const apiBase = `${basePath}/api`;
const state = { session: null, overview: null, csrfToken: '', currentView: 'overview', confirmAction: null };
const $ = (id) => document.getElementById(id);
let navigationStarted = false;

function smoothNavigate(target, { replace = true, message = 'Ritorno alla dashboard…' } = {}) {
  if (navigationStarted) return;
  navigationStarted = true;
  const label = $('pageTransitionText');
  const overlay = $('pageTransition');
  if (label) label.textContent = message;
  if (overlay) overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('page-leaving');
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.setTimeout(() => {
    if (replace) window.location.replace(target);
    else window.location.assign(target);
  }, reducedMotion ? 20 : 280);
}

function fmtDuration(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}g ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function fmtBytes(bytes) {
  let value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function notice(message, error = false) {
  const box = $('notice');
  box.textContent = message;
  box.classList.toggle('error', error);
  box.classList.remove('hidden');
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => box.classList.add('hidden'), 4500);
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.mutation && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(`${apiBase}/admin${path}`, {
    credentials: 'same-origin',
    ...options,
    headers
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    smoothNavigate(`${basePath}/`, { message: 'Sessione owner scaduta…' });
    throw new Error('Sessione owner scaduta.');
  }
  if (!response.ok) throw new Error(body.error || `Errore HTTP ${response.status}`);
  return body;
}

async function loadSession() {
  const session = await request('/session');
  state.session = session;
  state.csrfToken = session.csrfToken;
  $('ownerName').textContent = session.owner.personaName || 'Owner';
  $('ownerSteamId').textContent = session.owner.steamId64;
  $('securitySteamId').textContent = session.owner.steamId64;
  $('securityIdle').textContent = `${session.idleMinutes} minuti`;
  $('securityAbsolute').textContent = `${session.absoluteHours} ore`;
  const passkeys = session.passkeys || { count: 0, credentials: [] };
  $('securityPasskeys').textContent = String(passkeys.count || 0);
  const lastUsed = (passkeys.credentials || []).map((item) => item.lastUsedAt).filter(Boolean).sort().pop();
  $('securityPasskeyLastUsed').textContent = fmtDate(lastUsed);
}

function meter(id, value) {
  $(id).style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
}

function renderSystem(server) {
  $('metricTemp').textContent = server.cpuTemperatureC == null ? '—' : `${Number(server.cpuTemperatureC).toFixed(1)}°C`;
  $('metricVersion').textContent = server.piboostVersion || '—';
  $('metricUptime').textContent = `Uptime ${fmtDuration(server.uptimeSeconds)}`;
  $('systemCpu').textContent = `${Number(server.cpuPercent || 0).toFixed(1)}%`;
  $('systemRam').textContent = `${Number(server.memory && server.memory.percent || 0).toFixed(1)}% · ${fmtBytes(server.memory && server.memory.used)}`;
  $('systemDisk').textContent = `${Number(server.disk && server.disk.percent || 0).toFixed(1)}% · ${fmtBytes(server.disk && server.disk.used)}`;
  $('systemNode').textContent = `${server.nodeVersion || '—'} · ${server.architecture || '—'}`;
  $('systemAddresses').textContent = (server.addresses || []).map((item) => `${item.name}: ${item.address}`).join(' · ') || '—';
  meter('systemCpuBar', server.cpuPercent);
  meter('systemRamBar', server.memory && server.memory.percent);
  meter('systemDiskBar', server.disk && server.disk.percent);
}

function accountIdentity(account) {
  return `<div class="identity"><img src="${escapeHtml(account.avatar || '')}" alt=""><div><strong>${escapeHtml(account.personaName || account.accountName || 'Steam')}</strong><small>${escapeHtml(account.steamId64 || account.accountName || 'SteamID non disponibile')}</small></div></div>`;
}

function renderActiveBoosts(accounts) {
  const active = accounts.filter((account) => account.boosting);
  $('activeBoostCount').textContent = String(active.length);
  const box = $('activeBoostList');
  if (!active.length) {
    box.innerHTML = '<div class="empty">Nessun boost attivo.</div>';
    return;
  }
  box.innerHTML = active.map((account) => `
    <article class="boost-row">
      ${accountIdentity(account)}
      <div><span class="state-pill boosting">${escapeHtml(account.boostMode === 'favorite' ? 'Preferito' : 'Multiplo')}</span><div class="muted">${account.activeGames.length} giochi</div></div>
      <div><strong>${fmtDuration(account.activeSeconds)}</strong><div class="muted">${escapeHtml(account.message || '')}</div></div>
      <div class="row-actions"><button class="btn danger" data-stop="${escapeHtml(account.id)}" type="button">Ferma boost</button><button class="btn" data-details="${escapeHtml(account.id)}" type="button">Dettagli</button></div>
    </article>`).join('');
}

function renderAccounts(accounts) {
  const query = String($('accountSearch').value || '').trim().toLowerCase();
  const filtered = accounts.filter((account) => !query || [account.personaName, account.accountName, account.steamId64, account.connection, account.message].join(' ').toLowerCase().includes(query));
  const box = $('accountsList');
  if (!filtered.length) {
    box.innerHTML = '<div class="empty">Nessun account corrisponde alla ricerca.</div>';
    return;
  }
  box.innerHTML = filtered.map((account) => `
    <article class="account-row">
      ${accountIdentity(account)}
      <div><span class="state-pill ${account.boosting ? 'boosting' : account.connection === 'online' ? 'online' : ''}">${escapeHtml(account.boosting ? 'Boost attivo' : account.connection)}</span><div class="muted">${account.gamesCount} giochi · ${account.favoritesCount} preferiti</div></div>
      <div><strong>${fmtDuration(account.totalSeconds)}</strong><div class="muted">Totale registrato · ${fmtDate(account.lastModifiedAt)}</div></div>
      <div class="row-actions"><button class="btn" data-details="${escapeHtml(account.id)}" type="button">Apri</button><button class="btn danger" data-stop="${escapeHtml(account.id)}" type="button" ${account.boosting ? '' : 'disabled'}>Stop</button><button class="btn" data-disconnect="${escapeHtml(account.id)}" type="button">Disconnetti</button><button class="btn danger" data-delete="${escapeHtml(account.id)}" data-name="${escapeHtml(account.personaName || account.accountName)}" type="button">Elimina</button></div>
    </article>`).join('');
}

function actionLabel(action) {
  const labels = {
    owner_session_created: 'Accesso owner', owner_session_closed: 'Uscita owner', owner_passkey_registered: 'Passkey owner registrata', maintenance_updated: 'Manutenzione aggiornata',
    account_boost_stopped: 'Boost fermato', account_disconnected: 'Account disconnesso', account_deleted: 'Account eliminato'
  };
  return labels[action] || action;
}

function renderAudit(audit) {
  $('auditCount').textContent = String(audit.length);
  $('auditList').innerHTML = audit.length ? audit.map((entry) => `
    <article class="audit-row"><time>${fmtDate(entry.at)}</time><strong>${escapeHtml(actionLabel(entry.action))}</strong><code>${escapeHtml(JSON.stringify(entry.details || {}))}</code></article>`).join('') : '<div class="empty">Nessuna azione amministrativa registrata.</div>';
}

function renderOverview(data) {
  state.overview = data;
  const accounts = data.accounts || [];
  const activeGames = accounts.reduce((sum, account) => sum + (account.boosting ? account.activeGames.length : 0), 0);
  $('metricAccounts').textContent = String(accounts.length);
  $('metricOnline').textContent = `${accounts.filter((account) => account.connection === 'online').length} online`;
  $('metricBoosts').textContent = String(accounts.filter((account) => account.boosting).length);
  $('metricGames').textContent = `${activeGames} giochi attivi`;
  renderSystem(data.server || {});
  renderActiveBoosts(accounts);
  renderAccounts(accounts);
  renderAudit(data.audit || []);
  const maintenance = data.maintenance || {};
  $('maintenanceEnabled').checked = Boolean(maintenance.enabled);
  $('maintenanceMessage').value = maintenance.message || 'PiBoost è temporaneamente in manutenzione.';
  $('maintenanceStopBoosts').checked = Boolean(maintenance.stopActiveBoosts);
  $('lastRefresh').textContent = `Aggiornato ${new Intl.DateTimeFormat('it-IT', { timeStyle: 'medium' }).format(new Date())}`;
}

async function refresh() {
  $('refreshBtn').disabled = true;
  try { renderOverview(await request('/overview')); }
  catch (error) { notice(error.message, true); }
  finally { $('refreshBtn').disabled = false; }
}

function showView(name) {
  state.currentView = name;
  const map = { overview: 'Panoramica', accounts: 'Utenti', security: 'Sicurezza', audit: 'Registro' };
  $('viewTitle').textContent = map[name] || 'Panoramica';
  for (const viewName of Object.keys(map)) $(`${viewName}View`).classList.toggle('hidden', viewName !== name);
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
}

function gameCards(games) {
  if (!games || !games.length) return '<div class="muted">Nessun gioco.</div>';
  return `<div class="game-grid">${games.map((game) => `<div class="game-card"><img src="${escapeHtml(game.image || '')}" alt=""><div><strong>${escapeHtml(game.name)}</strong><small>AppID ${escapeHtml(game.appid)}</small></div></div>`).join('')}</div>`;
}

function compactItems(items, renderer, emptyText) {
  if (!items || !items.length) return `<div class="muted">${escapeHtml(emptyText)}</div>`;
  return `<div class="compact-list">${items.map(renderer).join('')}</div>`;
}

async function openDetails(accountId) {
  $('accountDrawer').classList.remove('hidden');
  $('drawerBody').innerHTML = '<div class="empty">Caricamento dettagli…</div>';
  try {
    const data = await request(`/accounts/${encodeURIComponent(accountId)}`);
    const info = data.state || {};
    const history = data.history || {};
    $('drawerTitle').textContent = info.profile && (info.profile.personaName || info.profile.accountName) || 'Account Steam';
    const settings = info.settings || {};
    $('drawerBody').innerHTML = `
      <div class="detail-summary">
        <div class="detail-chip"><span>Connessione</span><strong>${escapeHtml(info.connection || 'offline')}</strong><small>${escapeHtml(info.message || '')}</small></div>
        <div class="detail-chip"><span>Boost</span><strong>${info.boosting || info.desiredBoosting ? 'Attivo' : 'Fermato'}</strong><small>${escapeHtml(info.boostMode || 'none')}</small></div>
        <div class="detail-chip"><span>Ore totali</span><strong>${fmtDuration(history.totalSeconds)}</strong><small>${(history.sessions || []).length} sessioni</small></div>
        <div class="detail-chip"><span>Ultima modifica</span><strong>${fmtDate(info.lastModifiedAt)}</strong><small>${(data.changeLog || []).length} modifiche registrate</small></div>
      </div>
      <section class="detail-section"><h3>Giochi salvati (${(info.games || []).length}/32)</h3>${gameCards(info.games || [])}</section>
      <section class="detail-section"><h3>Preferiti (${(info.favorites || []).length})</h3>${gameCards(info.favorites || [])}</section>
      <section class="detail-section"><h3>Impostazioni ricordate</h3>
        <div class="compact-list">
          ${Object.entries(settings).map(([key, value]) => `<div class="compact-item"><span>${escapeHtml(key)}</span><strong>${escapeHtml(typeof value === 'boolean' ? (value ? 'Attivo' : 'Disattivo') : value)}</strong></div>`).join('')}
        </div>
      </section>
      <section class="detail-section"><h3>Ore per gioco e ultima data</h3>${compactItems(history.gameTotals || [], (game) => `<div class="compact-item"><div><strong>${escapeHtml(game.name)}</strong><small>AppID ${game.appid} · ${game.sessions} sessioni · ultimo ${fmtDate(game.lastBoostedAt)}</small></div><strong>${fmtDuration(game.totalSeconds)}</strong></div>`, 'Nessuna ora registrata.')}</section>
      <section class="detail-section"><h3>Totali giornalieri</h3>${compactItems((history.dailyTotals || []).slice(0, 60), (day) => `<div class="compact-item"><div><strong>${escapeHtml(day.date)}</strong><small>${(day.games || []).length} giochi</small></div><strong>${fmtDuration(day.totalSeconds)}</strong></div>`, 'Nessun giorno registrato.')}</section>
      <section class="detail-section"><h3>Sessioni recenti</h3>${compactItems((history.sessions || []).slice(0, 100), (session) => `<div class="compact-item"><div><strong>${escapeHtml(session.mode === 'favorite' ? 'Preferito' : 'Multiplo')} · ${escapeHtml(session.reason)}</strong><small>${fmtDate(session.startedAt)} → ${fmtDate(session.endedAt)}</small></div><strong>${fmtDuration(session.seconds)}</strong></div>`, 'Nessuna sessione.')}</section>
      <section class="detail-section"><h3>Modifiche salvate</h3>${compactItems(data.changeLog || [], (change) => `<div class="compact-item"><div><strong>${escapeHtml(change.type)}</strong><small>${fmtDate(change.at)}</small></div><small>${escapeHtml(JSON.stringify(change.details || {}))}</small></div>`, 'Le modifiche effettuate prima della versione 4.0 non possono essere ricostruite; lo stato corrente è stato comunque migrato.')}</section>`;
  } catch (error) {
    $('drawerBody').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function confirmAction(title, text, action) {
  state.confirmAction = action;
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmDialog').classList.remove('hidden');
}

async function mutate(path, method = 'POST') {
  const result = await request(path, { method, body: '{}', mutation: true });
  await refresh();
  return result;
}

document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
$('refreshBtn').addEventListener('click', refresh);
$('accountSearch').addEventListener('input', () => renderAccounts((state.overview && state.overview.accounts) || []));
$('closeDrawerBtn').addEventListener('click', () => $('accountDrawer').classList.add('hidden'));
$('accountDrawer').addEventListener('click', (event) => { if (event.target === $('accountDrawer')) $('accountDrawer').classList.add('hidden'); });
$('confirmCancelBtn').addEventListener('click', () => { state.confirmAction = null; $('confirmDialog').classList.add('hidden'); });
$('confirmOkBtn').addEventListener('click', async () => {
  const action = state.confirmAction;
  state.confirmAction = null;
  $('confirmDialog').classList.add('hidden');
  if (!action) return;
  try { await action(); notice('Operazione completata.'); } catch (error) { notice(error.message, true); }
});

for (const id of ['activeBoostList', 'accountsList']) {
  $(id).addEventListener('click', (event) => {
    const details = event.target.closest('[data-details]');
    const stop = event.target.closest('[data-stop]');
    const disconnect = event.target.closest('[data-disconnect]');
    const remove = event.target.closest('[data-delete]');
    if (details) openDetails(details.dataset.details);
    if (stop) confirmAction('Fermare il boost?', 'La sessione verrà chiusa e le ore maturate saranno salvate nello storico.', () => mutate(`/accounts/${encodeURIComponent(stop.dataset.stop)}/stop`));
    if (disconnect) confirmAction('Disconnettere l’account?', 'Il boost verrà fermato e le sessioni web dell’account verranno revocate.', () => mutate(`/accounts/${encodeURIComponent(disconnect.dataset.disconnect)}/disconnect`));
    if (remove) confirmAction('Eliminare definitivamente l’account?', `Verranno eliminati dal Raspberry dati, giochi, preferiti, impostazioni e storico di ${remove.dataset.name || 'questo account'}.`, () => mutate(`/accounts/${encodeURIComponent(remove.dataset.delete)}`, 'DELETE'));
  });
}

$('saveMaintenanceBtn').addEventListener('click', async () => {
  $('saveMaintenanceBtn').disabled = true;
  try {
    const payload = {
      enabled: $('maintenanceEnabled').checked,
      message: $('maintenanceMessage').value,
      stopActiveBoosts: $('maintenanceStopBoosts').checked
    };
    await request('/maintenance', { method: 'PUT', body: JSON.stringify(payload), mutation: true });
    await refresh();
    notice('Modalità manutenzione salvata.');
  } catch (error) { notice(error.message, true); }
  finally { $('saveMaintenanceBtn').disabled = false; }
});

$('backToPiBoostBtn').addEventListener('click', (event) => {
  event.preventDefault();
  smoothNavigate(`${basePath}/`, { replace: false, message: 'Ritorno a PiBoost…' });
});

$('ownerLogoutBtn').addEventListener('click', () => confirmAction('Uscire dal pannello owner?', 'La dashboard PiBoost normale resterà accessibile.', async () => {
  await request('/logout', { method: 'POST', body: '{}', mutation: true });
  smoothNavigate(`${basePath}/`, { message: 'Chiusura del pannello owner…' });
}));

(async function boot() {
  try {
    await loadSession();
    await refresh();
    setInterval(() => refresh().catch(() => {}), 20_000);
  } catch (_error) {
    smoothNavigate(`${basePath}/`, { message: 'Ritorno alla dashboard…' });
  }
})();
