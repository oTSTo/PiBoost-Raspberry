'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { CryptoVault } = require('./crypto-vault');
const { MultiSteam } = require('./multi-steam');
const { OwnerSessionStore } = require('./owner-session');
const { AdminStore } = require('./admin-store');
const { PasskeyStore } = require('./passkey-store');
const { systemStatus } = require('./system-status');

const VERSION = '4.1.1';
const OWNER_COOKIE = 'piboost_owner';

function loadEnv(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) continue;
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (_error) {}
}

loadEnv(path.resolve(__dirname, '..', '.env'));

const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const BASE_PATH = (process.env.BASE_PATH || '/steamboost').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
const OWNER_STEAM_ID64 = String(process.env.OWNER_STEAM_ID64 || '').trim();
const OWNER_RP_ID = String(process.env.OWNER_RP_ID || 'localhost').trim();
const OWNER_PASSKEY_ORIGINS = String(process.env.OWNER_PASSKEY_ORIGINS || 'http://localhost:3000')
  .split(',').map((item) => item.trim().replace(/\/$/, '')).filter(Boolean);
const OWNER_ALLOWED_ORIGINS = String(process.env.OWNER_ALLOWED_ORIGINS || OWNER_PASSKEY_ORIGINS.join(','))
  .split(',').map((item) => item.trim().replace(/\/$/, '')).filter(Boolean);
const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || "'self'")
  .split(',').map((item) => item.trim()).filter(Boolean);

if (!process.env.MASTER_KEY) {
  console.error('Manca MASTER_KEY nel file .env. Esegui scripts/install.sh oppure scripts/update.sh.');
  process.exit(1);
}
if (OWNER_STEAM_ID64 && !/^\d{17}$/.test(OWNER_STEAM_ID64)) {
  console.error('OWNER_STEAM_ID64 non valido: deve contenere esattamente 17 cifre.');
  process.exit(1);
}

const vault = new CryptoVault(DATA_DIR, process.env.MASTER_KEY);
const multi = new MultiSteam({
  dataDir: DATA_DIR,
  vault,
  sessionDays: Number(process.env.SESSION_DAYS || 90),
  maxAccounts: Number(process.env.MAX_ACCOUNTS || 20)
});
const adminStore = new AdminStore(DATA_DIR);
const passkeyStore = new PasskeyStore(DATA_DIR, {
  ownerSteamId64: OWNER_STEAM_ID64,
  rpID: OWNER_RP_ID,
  rpName: process.env.OWNER_RP_NAME || 'PiBoost Owner Admin',
  origins: OWNER_PASSKEY_ORIGINS,
  challengeMinutes: Number(process.env.OWNER_PASSKEY_CHALLENGE_MINUTES || 5)
});
const ownerSessions = new OwnerSessionStore({
  idleMinutes: Number(process.env.OWNER_IDLE_MINUTES || 30),
  absoluteHours: Number(process.env.OWNER_SESSION_HOURS || 8)
});
setInterval(() => { ownerSessions.prune(); passkeyStore.prune(); }, 10 * 60_000).unref();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      imgSrc: [
        "'self'",
        'data:',
        'https://avatars.fastly.steamstatic.com',
        'https://avatars.cloudflare.steamstatic.com',
        'https://avatars.akamai.steamstatic.com',
        'https://cdn.cloudflare.steamstatic.com',
        'https://shared.cloudflare.steamstatic.com',
        'https://shared.fastly.steamstatic.com',
        'https://shared.akamai.steamstatic.com'
      ],
      styleSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: FRAME_ANCESTORS,
      formAction: ["'self'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  strictTransportSecurity: false,
  xFrameOptions: false
}));
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|raspberrypi\.local|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$/i;
  if (origin && localOrigin.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function parseCookies(req) {
  const out = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    const key = item.slice(0, index).trim();
    try { out[key] = decodeURIComponent(item.slice(index + 1).trim()); } catch (_error) { out[key] = item.slice(index + 1).trim(); }
  }
  return out;
}

function requestIsHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setOwnerCookie(req, res, token) {
  const parts = [
    `${OWNER_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${BASE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(60, Number(process.env.OWNER_SESSION_HOURS || 8) * 3600)}`
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearOwnerCookie(req, res) {
  const parts = [
    `${OWNER_COOKIE}=`,
    `Path=${BASE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (requestIsHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function makeRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.reset - now) / 1000));
      return res.status(429).json({ error: 'Troppi tentativi. Riprova tra poco.' });
    }
    return next();
  };
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function ownerSteamIdForAccount(account) {
  if (!account) return '';
  const state = account.getPublicState();
  return String((state.profile && state.profile.steamId64) || state.steamId64 || '').trim();
}

function isOwnerAccount(account) {
  return Boolean(OWNER_STEAM_ID64 && account && ownerSteamIdForAccount(account) === OWNER_STEAM_ID64);
}

function ownerConfigured() {
  return Boolean(OWNER_STEAM_ID64);
}

function issueOwnerSession(req, res, account) {
  if (!isOwnerAccount(account)) return null;
  const issued = ownerSessions.issue({ accountId: account.accountId, steamId64: OWNER_STEAM_ID64 });
  setOwnerCookie(req, res, issued.token);
  return issued;
}

function requireAccount(req, res, next) {
  const token = bearerToken(req);
  const account = multi.getByToken(token);
  if (!account) return res.status(401).json({ error: 'Sessione scaduta. Accedi di nuovo con Steam.' });
  req.accessToken = token;
  req.steamAccount = account;
  req.isOwner = isOwnerAccount(account);
  return next();
}

function resolveOwnerSession(req) {
  const token = parseCookies(req)[OWNER_COOKIE] || '';
  const session = ownerSessions.resolve(token);
  if (!session || !OWNER_STEAM_ID64 || session.steamId64 !== OWNER_STEAM_ID64) return null;
  const account = multi.get(session.accountId);
  if (!account || !isOwnerAccount(account)) return null;
  return { token, session, account };
}

function requireOwnerSession(req, res, next) {
  const resolved = resolveOwnerSession(req);
  if (!resolved) {
    clearOwnerCookie(req, res);
    return res.status(401).json({ error: 'Accesso owner richiesto.' });
  }
  req.ownerToken = resolved.token;
  req.ownerSession = resolved.session;
  req.ownerAccount = resolved.account;
  return next();
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const candidates = new Set([
      String(req.headers.host || '').split(',')[0].trim(),
      String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
    ].filter(Boolean));
    if (candidates.has(originUrl.host)) return true;
    if (OWNER_ALLOWED_ORIGINS.includes(originUrl.origin)) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1|raspberrypi\.local|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?::\d+)?$/i.test(originUrl.origin);
  } catch (_error) {
    return false;
  }
}

function requireOwnerMutation(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Origine della richiesta non valida.' });
  const csrf = String(req.headers['x-csrf-token'] || '');
  if (!ownerSessions.verifyCsrf(req.ownerToken, csrf)) return res.status(403).json({ error: 'Token di sicurezza non valido.' });
  return next();
}

function auditContext(req) {
  return {
    ownerSteamId64: OWNER_STEAM_ID64,
    ip: req.ip || req.socket.remoteAddress || '',
    userAgent: req.headers['user-agent'] || ''
  };
}

function requireOperational(_req, res, next) {
  const maintenance = adminStore.maintenance();
  if (maintenance.enabled) return res.status(503).json({ error: maintenance.message, maintenance });
  return next();
}

function publicServiceState() {
  const maintenance = adminStore.maintenance();
  return {
    ok: true,
    version: VERSION,
    ownerConfigured: ownerConfigured(),
    maintenance: { enabled: maintenance.enabled, message: maintenance.message }
  };
}

function gameImage(appid) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${Number(appid)}/header.jpg`;
}

function cleanGames(raw, limit = 32) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).slice(0, limit).map((item) => ({
    appid: Number(item && item.appid),
    name: String((item && item.name) || `App ${item && item.appid}`).slice(0, 120),
    image: String((item && item.image) || gameImage(item && item.appid)).slice(0, 500)
  })).filter((item) => Number.isInteger(item.appid) && item.appid > 0 && !seen.has(item.appid) && seen.add(item.appid));
}

const loginLimiter = makeRateLimiter({ windowMs: 10 * 60_000, max: 20 });
const guardLimiter = makeRateLimiter({ windowMs: 10 * 60_000, max: 30 });

function withOwnerState(account) {
  return {
    ...account.getPublicState(),
    owner: isOwnerAccount(account),
    ownerConfigured: ownerConfigured()
  };
}

function createApiRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => res.json({
    ok: true,
    service: 'PiBoost MultiUser Favorites',
    version: VERSION,
    ownerConfigured: ownerConfigured(),
    attention: multi.attentionCount(),
    time: new Date().toISOString()
  }));

  router.get('/public-state', (_req, res) => res.json(publicServiceState()));

  router.post('/owner/session', requireAccount, makeRateLimiter({ windowMs: 10 * 60_000, max: 30 }), (req, res) => {
    if (!req.isOwner) return res.status(403).json({ error: 'Questo account Steam non è autorizzato come owner.' });
    res.json({
      ok: true,
      owner: true,
      passkeyConfigured: passkeyStore.configured(),
      ownerAuthUrl: `${BASE_PATH}/owner-auth`,
      adminUrl: `${BASE_PATH}/admin`
    });
  });

  router.get('/owner/status', requireAccount, (req, res) => {
    res.json({
      owner: req.isOwner,
      ownerConfigured: ownerConfigured(),
      passkeyConfigured: req.isOwner ? passkeyStore.configured() : false,
      ownerAuthUrl: `${BASE_PATH}/owner-auth`,
      adminUrl: `${BASE_PATH}/admin`
    });
  });

  router.get('/owner/passkey/status', requireAccount, (req, res) => {
    if (!req.isOwner) return res.status(403).json({ error: 'Questo account Steam non è autorizzato come owner.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, owner: true, sessionActive: Boolean(resolveOwnerSession(req)), ...passkeyStore.publicStatus(), adminUrl: `${BASE_PATH}/admin` });
  });

  router.post('/owner/passkey/register/options', requireAccount, makeRateLimiter({ windowMs: 10 * 60_000, max: 10 }), asyncRoute(async (req, res) => {
    if (!req.isOwner) return res.status(403).json({ error: 'Questo account Steam non è autorizzato come owner.' });
    const profile = req.steamAccount.getPublicState().profile || {};
    const options = await passkeyStore.registrationOptions({ accountId: req.steamAccount.accountId, personaName: profile.personaName });
    res.setHeader('Cache-Control', 'no-store');
    res.json(options);
  }));

  router.post('/owner/passkey/register/verify', requireAccount, makeRateLimiter({ windowMs: 10 * 60_000, max: 10 }), asyncRoute(async (req, res) => {
    if (!req.isOwner) return res.status(403).json({ error: 'Questo account Steam non è autorizzato come owner.' });
    await passkeyStore.verifyRegistration({
      accountId: req.steamAccount.accountId,
      response: req.body && req.body.response,
      label: req.body && req.body.label
    });
    const issued = issueOwnerSession(req, res, req.steamAccount);
    adminStore.log('owner_passkey_registered', { accountId: req.steamAccount.accountId }, auditContext(req));
    adminStore.log('owner_session_created', { accountId: req.steamAccount.accountId, method: 'passkey_registration' }, auditContext(req));
    res.json({ ok: true, verified: true, expiresAt: issued.expiresAt, adminUrl: `${BASE_PATH}/admin` });
  }));

  router.post('/owner/passkey/auth/options', requireAccount, makeRateLimiter({ windowMs: 10 * 60_000, max: 20 }), asyncRoute(async (req, res) => {
    if (!req.isOwner) return res.status(403).json({ error: 'Questo account Steam non è autorizzato come owner.' });
    const options = await passkeyStore.authenticationOptions({ accountId: req.steamAccount.accountId });
    res.setHeader('Cache-Control', 'no-store');
    res.json(options);
  }));

  router.post('/owner/passkey/auth/verify', requireAccount, makeRateLimiter({ windowMs: 10 * 60_000, max: 20 }), asyncRoute(async (req, res) => {
    if (!req.isOwner) return res.status(403).json({ error: 'Questo account Steam non è autorizzato come owner.' });
    await passkeyStore.verifyAuthentication({ accountId: req.steamAccount.accountId, response: req.body && req.body.response });
    const issued = issueOwnerSession(req, res, req.steamAccount);
    adminStore.log('owner_session_created', { accountId: req.steamAccount.accountId, method: 'passkey' }, auditContext(req));
    res.json({ ok: true, verified: true, expiresAt: issued.expiresAt, adminUrl: `${BASE_PATH}/admin` });
  }));

  router.get('/admin/session', requireOwnerSession, (req, res) => {
    const csrfToken = ownerSessions.rotateCsrf(req.ownerToken);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      csrfToken,
      owner: {
        steamId64: OWNER_STEAM_ID64,
        personaName: req.ownerAccount.getPublicState().profile.personaName || 'Owner'
      },
      idleMinutes: Number(process.env.OWNER_IDLE_MINUTES || 30),
      absoluteHours: Number(process.env.OWNER_SESSION_HOURS || 8),
      passkeys: passkeyStore.publicStatus()
    });
  });

  router.post('/admin/logout', requireOwnerSession, requireOwnerMutation, (req, res) => {
    adminStore.log('owner_session_closed', {}, auditContext(req));
    ownerSessions.revoke(req.ownerToken);
    clearOwnerCookie(req, res);
    res.json({ ok: true });
  });

  router.get('/admin/overview', requireOwnerSession, asyncRoute(async (req, res) => {
    const accounts = multi.adminAccounts();
    const server = await systemStatus({
      piboostVersion: VERSION,
      registeredAccounts: accounts.length,
      connectedAccounts: accounts.filter((item) => item.connection === 'online').length,
      activeBoosts: accounts.filter((item) => item.boosting).length
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      owner: { steamId64: OWNER_STEAM_ID64, personaName: req.ownerAccount.getPublicState().profile.personaName || 'Owner' },
      maintenance: adminStore.maintenance(),
      server,
      accounts,
      audit: adminStore.audit(40),
      passkeys: passkeyStore.publicStatus()
    });
  }));

  router.get('/admin/accounts/:accountId', requireOwnerSession, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(multi.adminAccountDetails(req.params.accountId));
  });

  router.put('/admin/maintenance', requireOwnerSession, requireOwnerMutation, (req, res) => {
    const input = req.body || {};
    let stoppedBoosts = 0;
    let cancelledLogins = 0;
    if (Boolean(input.enabled)) {
      cancelledLogins = multi.cancelAllLogins();
      if (Boolean(input.stopActiveBoosts)) stoppedBoosts = multi.stopAllBoosts('maintenance');
    }
    const maintenance = adminStore.setMaintenance(input);
    adminStore.log('maintenance_updated', { maintenance, stoppedBoosts, cancelledLogins }, auditContext(req));
    res.json({ ok: true, maintenance, stoppedBoosts, cancelledLogins });
  });

  router.post('/admin/accounts/:accountId/stop', requireOwnerSession, requireOwnerMutation, (req, res) => {
    const state = multi.stopAccountBoost(req.params.accountId, 'admin_stop');
    adminStore.log('account_boost_stopped', { accountId: req.params.accountId }, auditContext(req));
    res.json({ ok: true, state });
  });

  router.post('/admin/accounts/:accountId/disconnect', requireOwnerSession, requireOwnerMutation, (req, res) => {
    const state = multi.disconnectAccount(req.params.accountId);
    adminStore.log('account_disconnected', { accountId: req.params.accountId }, auditContext(req));
    res.json({ ok: true, state });
  });

  router.delete('/admin/accounts/:accountId', requireOwnerSession, requireOwnerMutation, (req, res) => {
    if (req.params.accountId === req.ownerAccount.accountId) return res.status(400).json({ error: 'Non puoi eliminare l’account owner dal pannello.' });
    multi.removeAccount(req.params.accountId);
    adminStore.log('account_deleted', { accountId: req.params.accountId }, auditContext(req));
    res.json({ ok: true });
  });

  router.post('/auth/steam-login', loginLimiter, requireOperational, asyncRoute(async (req, res) => {
    const result = await multi.startCredentialLogin(req.body && req.body.accountName, req.body && req.body.password);
    res.json(result);
  }));

  router.post('/auth/steam-qr', loginLimiter, requireOperational, asyncRoute(async (_req, res) => {
    const result = await multi.startQrLogin();
    res.json(result);
  }));

  router.post('/auth/steam-guard', guardLimiter, asyncRoute(async (req, res) => {
    await multi.submitGuard(req.body && req.body.loginId, req.body && req.body.code);
    res.json({ ok: true });
  }));

  router.post('/auth/steam-force-poll', guardLimiter, (req, res) => {
    multi.forcePoll(req.body && req.body.loginId);
    res.json({ ok: true });
  });

  router.post('/auth/steam-cancel', (req, res) => {
    multi.cancelLogin(req.body && req.body.loginId);
    res.json({ ok: true });
  });

  router.get('/auth/steam-status', (req, res) => {
    const result = multi.loginStatus(req.query.loginId);
    if (result.authenticated && result.token) {
      const account = multi.getByToken(result.token);
      result.owner = isOwnerAccount(account);
      result.ownerConfigured = ownerConfigured();
    }
    res.json(result);
  });

  router.post('/auth/logout', requireAccount, (req, res) => {
    const input = req.body || {};
    const keepBoostOnLogout = Boolean(input.keepBoostOnLogout !== undefined ? input.keepBoostOnLogout : input.continueBoost);
    req.steamAccount.store.update((draft) => { draft.settings.keepBoostOnLogout = keepBoostOnLogout; });
    req.steamAccount.recordChange('logout_preference_changed', { keepBoostOnLogout });
    if (input.autoStartBoostOnBoot !== undefined) req.steamAccount.setAutoStartBoostOnBoot(Boolean(input.autoStartBoostOnBoot));
    const accountId = req.steamAccount.accountId;
    const result = multi.logout(req.accessToken, { continueBoost: Boolean(input.continueBoost) });
    ownerSessions.revokeAccount(accountId);
    clearOwnerCookie(req, res);
    res.json({
      ok: true,
      ...result,
      keepBoostOnLogout,
      autoStartBoostOnBoot: req.steamAccount.store.get().settings.autoStartBoostOnBoot,
      preserved: ['games', 'favorites', 'settings', 'statistics', 'dates', 'changeLog', 'boostMemory']
    });
  });

  router.put('/preferences/logout', requireAccount, (req, res) => {
    const keepBoostOnLogout = Boolean(req.body && req.body.keepBoostOnLogout);
    req.steamAccount.store.update((draft) => { draft.settings.keepBoostOnLogout = keepBoostOnLogout; });
    req.steamAccount.recordChange('logout_preference_changed', { keepBoostOnLogout });
    res.json({ ...withOwnerState(req.steamAccount), maintenance: adminStore.maintenance() });
  });

  router.put('/preferences/boot', requireAccount, (req, res) => {
    const autoStartBoostOnBoot = req.steamAccount.setAutoStartBoostOnBoot(Boolean(req.body && req.body.autoStartBoostOnBoot));
    req.steamAccount.recordChange('boot_preference_changed', { autoStartBoostOnBoot });
    res.json({ ...withOwnerState(req.steamAccount), maintenance: adminStore.maintenance() });
  });

  router.get('/status', requireAccount, (req, res) => {
    if (req.isOwner && !resolveOwnerSession(req)) issueOwnerSession(req, res, req.steamAccount);
    res.json({ ...withOwnerState(req.steamAccount), maintenance: adminStore.maintenance() });
  });

  router.get('/history', requireAccount, (req, res) => res.json(req.steamAccount.getHistory()));

  router.post('/profile/refresh', requireAccount, requireOperational, asyncRoute(async (req, res) => {
    await req.steamAccount.refreshPublicProfile();
    res.json({ ...withOwnerState(req.steamAccount), maintenance: adminStore.maintenance() });
  }));

  router.post('/account/disconnect', requireAccount, (req, res) => {
    req.steamAccount.disconnect({ removeToken: Boolean(req.body && req.body.removeToken) });
    ownerSessions.revokeAccount(req.steamAccount.accountId);
    clearOwnerCookie(req, res);
    res.json(withOwnerState(req.steamAccount));
  });

  router.delete('/account', requireAccount, (req, res) => {
    const accountId = req.steamAccount.accountId;
    multi.removeAccount(accountId);
    ownerSessions.revokeAccount(accountId);
    clearOwnerCookie(req, res);
    res.json({ ok: true });
  });

  router.post('/boost/start', requireAccount, requireOperational, (req, res) => {
    const suppliedGames = cleanGames(req.body && req.body.games, 32);
    if (suppliedGames.length) {
      req.steamAccount.store.update((draft) => {
        draft.games = suppliedGames;
        if (!draft.bootBoost || typeof draft.bootBoost !== 'object') draft.bootBoost = {};
        draft.bootBoost.games = suppliedGames.map((game) => ({ ...game }));
        draft.bootBoost.updatedAt = new Date().toISOString();
      });
      req.steamAccount.recordChange('games_autosaved_before_boost', {
        count: suppliedGames.length,
        appids: suppliedGames.map((game) => game.appid)
      });
    }
    req.steamAccount.startBoost();
    res.json(withOwnerState(req.steamAccount));
  });

  router.post('/boost/favorite', requireAccount, requireOperational, (req, res) => {
    req.steamAccount.startFavoriteBoost(req.body && req.body.appid);
    res.json(withOwnerState(req.steamAccount));
  });

  router.post('/boost/stop', requireAccount, (req, res) => {
    req.steamAccount.stopBoost('manual');
    res.json(withOwnerState(req.steamAccount));
  });

  router.get('/games/search', requireAccount, requireOperational, asyncRoute(async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json({ items: [] });
    if (/^\d{1,10}$/.test(query)) {
      const appid = Number(query);
      const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=italian&cc=IT`, {
        signal: AbortSignal.timeout(7000),
        headers: { 'User-Agent': `PiBoost/${VERSION}` }
      });
      const data = await response.json();
      const appData = data[String(appid)] && data[String(appid)].data;
      return res.json({ items: appData ? [{ appid, name: String(appData.name || `App ${appid}`), image: gameImage(appid) }] : [] });
    }
    const response = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=italian&cc=IT`, {
      signal: AbortSignal.timeout(7000),
      headers: { 'User-Agent': `PiBoost/${VERSION}` }
    });
    if (!response.ok) throw new Error('Ricerca Steam non disponibile. Inserisci direttamente l’AppID.');
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items.slice(0, 12).map((item) => ({
      appid: Number(item.id),
      name: String(item.name || `App ${item.id}`),
      image: gameImage(item.id)
    })) : [];
    res.json({ items });
  }));

  router.put('/games', requireAccount, requireOperational, (req, res) => {
    const games = cleanGames(req.body && req.body.games, 32);
    req.steamAccount.store.update((draft) => {
      draft.games = games;
      if (!draft.bootBoost || typeof draft.bootBoost !== 'object') draft.bootBoost = {};
      draft.bootBoost.games = games.map((game) => ({ ...game }));
      draft.bootBoost.updatedAt = new Date().toISOString();
      if (!draft.boostMemory || typeof draft.boostMemory !== 'object') draft.boostMemory = {};
      if (draft.boostMemory.mode === 'games' || !draft.boostMemory.mode || draft.boostMemory.mode === 'none') {
        draft.boostMemory.games = games.map((game) => ({ ...game }));
        draft.boostMemory.gameAppIds = games.map((game) => game.appid);
        draft.boostMemory.updatedAt = new Date().toISOString();
      }
    });
    req.steamAccount.recordChange('games_updated', { count: games.length, appids: games.map((game) => game.appid) });
    req.steamAccount.updateSettings();
    res.json(withOwnerState(req.steamAccount));
  });

  router.put('/favorites', requireAccount, requireOperational, (req, res) => {
    const favorites = cleanGames(req.body && req.body.favorites, 100);
    req.steamAccount.store.update((draft) => { draft.favorites = favorites; });
    req.steamAccount.recordChange('favorites_updated', { count: favorites.length, appids: favorites.map((game) => game.appid) });
    req.steamAccount.updateSettings();
    res.json(withOwnerState(req.steamAccount));
  });

  router.put('/settings', requireAccount, requireOperational, (req, res) => {
    const input = req.body || {};
    req.steamAccount.store.update((draft) => {
      const current = draft.settings;
      current.customTitleEnabled = Boolean(input.customTitleEnabled);
      current.customTitle = String(input.customTitle || '').slice(0, 120);
      current.awayMessageEnabled = Boolean(input.awayMessageEnabled);
      current.awayMessage = String(input.awayMessage || '').slice(0, 300);
      current.persona = ['Online', 'Away', 'Invisible', 'Busy', 'LookingToPlay'].includes(input.persona) ? input.persona : 'Online';
      current.uiMode = ['Normal', 'BigPicture', 'Mobile', 'VR'].includes(input.uiMode) ? input.uiMode : 'Normal';
      current.autoRestart = Boolean(input.autoRestart);
      current.autoFriend = Boolean(input.autoFriend);
      current.autoStopEnabled = Boolean(input.autoStopEnabled);
      current.autoStopHours = Math.min(720, Math.max(0.05, Number(input.autoStopHours) || 8));
      current.cardFarmer = Boolean(input.cardFarmer);
      current.cardCycleMinutes = Math.min(1440, Math.max(5, Number(input.cardCycleMinutes) || 120));
    });
    req.steamAccount.recordChange('settings_updated', {
      customTitleEnabled: Boolean(input.customTitleEnabled),
      awayMessageEnabled: Boolean(input.awayMessageEnabled),
      persona: input.persona,
      uiMode: input.uiMode,
      autoRestart: Boolean(input.autoRestart),
      autoFriend: Boolean(input.autoFriend),
      autoStopEnabled: Boolean(input.autoStopEnabled),
      autoStopHours: Number(input.autoStopHours) || 8,
      cardFarmer: Boolean(input.cardFarmer),
      cardCycleMinutes: Number(input.cardCycleMinutes) || 120
    });
    req.steamAccount.updateSettings();
    res.json(withOwnerState(req.steamAccount));
  });

  return router;
}

const api = createApiRouter();
app.use('/api', api);
app.use(`${BASE_PATH}/api`, api);

const publicDir = path.resolve(__dirname, '..', 'public');

app.get(`${BASE_PATH}/owner-auth`, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'owner-auth.html'));
});
app.get(`${BASE_PATH}/owner-auth/`, (_req, res) => res.redirect(302, `${BASE_PATH}/owner-auth`));

app.get(`${BASE_PATH}/admin`, (req, res) => {
  const resolved = resolveOwnerSession(req);
  if (!resolved) {
    clearOwnerCookie(req, res);
    return res.redirect(302, `${BASE_PATH}/`);
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.sendFile(path.join(publicDir, 'admin.html'));
});
app.get(`${BASE_PATH}/admin/`, (_req, res) => res.redirect(302, `${BASE_PATH}/admin`));
app.get(`${BASE_PATH}/admin.html`, (req, res) => {
  const resolved = resolveOwnerSession(req);
  if (!resolved) return res.redirect(302, `${BASE_PATH}/`);
  return res.redirect(302, `${BASE_PATH}/admin`);
});

app.use(BASE_PATH, express.static(publicDir, { index: false, maxAge: '10m' }));
app.get(['/setup', '/setup/'], (_req, res) => res.redirect(BASE_PATH));
app.get([BASE_PATH, `${BASE_PATH}/`], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/', (_req, res) => res.redirect(BASE_PATH));

app.use((error, _req, res, _next) => {
  console.error(error);
  const message = error && error.message ? error.message : 'Errore interno.';
  const status = /obbligatori|Inserisci|scaduto|non disponibile|limite|Steam Guard|Seleziona|Prima collega|preferiti|password|codice|accesso|QR|rifiutato|tentativo|owner|Origine|Token|passkey|WebAuthn|autenticazione|registrazione|verificat/i.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`PiBoost ${VERSION} attivo su http://${BIND_HOST}:${PORT}${BASE_PATH}`);
  if (!ownerConfigured()) console.warn('ATTENZIONE: OWNER_STEAM_ID64 non configurato. Il pannello admin resta disabilitato.');
  setTimeout(() => multi.connectSavedAll(), 1000).unref();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: salvo le sessioni di boost e arresto PiBoost...`);
  try { multi.shutdownAll('service_stop'); } catch (error) { console.error(error); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
