'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const {
  LoginSession,
  EAuthTokenPlatformType,
  EAuthSessionGuardType
} = require('steam-session');
const { AccountRegistry } = require('./account-registry');
const { PersistentSessionStore } = require('./session-store');
const { SteamAccount } = require('./steam-account');

function accountIdForName(accountName) {
  return crypto.createHash('sha256').update(String(accountName).trim().toLowerCase()).digest('hex').slice(0, 24);
}

function friendlySteamError(error) {
  const raw = error && error.message ? String(error.message) : String(error || 'Errore Steam');
  const map = {
    InvalidPassword: 'Nome account o password Steam errati.',
    TwoFactorCodeMismatch: 'Codice Steam Guard non corretto. Attendi il nuovo codice e riprova.',
    InvalidLoginAuthCode: 'Codice ricevuto via email non corretto.',
    RateLimitExceeded: 'Troppi tentativi Steam. Attendi qualche minuto e riprova.',
    Expired: 'Il tentativo di accesso è scaduto. Ricomincia il login.',
    AccessDenied: 'Steam ha rifiutato l’accesso.',
    AccountLoginDeniedNeedTwoFactor: 'È richiesta la verifica Steam Guard.',
    AccountLogonDenied: 'È richiesta la verifica Steam Guard.'
  };
  return map[raw] || raw;
}

function normalizeActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  const has = (type) => list.some((item) => Number(item && item.type) === Number(type));
  const email = list.find((item) => Number(item && item.type) === Number(EAuthSessionGuardType.EmailCode));
  return {
    canApprove: has(EAuthSessionGuardType.DeviceConfirmation) || has(EAuthSessionGuardType.EmailConfirmation),
    canCode: has(EAuthSessionGuardType.DeviceCode) || has(EAuthSessionGuardType.EmailCode),
    codeKind: has(EAuthSessionGuardType.EmailCode) ? 'email' : (has(EAuthSessionGuardType.DeviceCode) ? 'mobile' : ''),
    guardDetail: email && email.detail ? String(email.detail) : ''
  };
}

class MultiSteam {
  constructor({ dataDir, vault, sessionDays = 90, maxAccounts = 20 }) {
    this.dataDir = dataDir;
    this.vault = vault;
    this.maxAccounts = Math.max(1, Number(maxAccounts) || 20);
    this.registry = new AccountRegistry(dataDir);
    this.sessions = new PersistentSessionStore(dataDir, sessionDays);
    this.accounts = new Map();
    this.pending = new Map();

    for (const record of this.registry.list()) {
      this.#createManager(record.id, record.accountName || '');
    }

    setInterval(() => this.#prunePending(), 60_000).unref();
  }

  #accountDir(accountId) {
    return path.join(this.dataDir, 'accounts', accountId);
  }

  #migrateLegacyState(accountId) {
    const accountDir = this.#accountDir(accountId);
    const destination = path.join(accountDir, 'state.json');
    const legacy = path.join(this.dataDir, 'state.json');
    if (fs.existsSync(destination) || !fs.existsSync(legacy)) return;
    if (this.registry.list().length > 1) return;
    fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    try { fs.copyFileSync(legacy, destination, fs.constants.COPYFILE_EXCL); } catch (_error) {}
  }

  #createManager(accountId, accountName, { replace = false } = {}) {
    if (!replace && this.accounts.has(accountId)) return this.accounts.get(accountId);
    if (replace) {
      const old = this.accounts.get(accountId);
      if (old) old.shutdownForReplacement();
      this.accounts.delete(accountId);
    }
    this.#migrateLegacyState(accountId);
    const manager = new SteamAccount({
      accountId,
      accountName,
      accountDir: this.#accountDir(accountId),
      vault: this.vault,
      registry: this.registry
    });
    this.accounts.set(accountId, manager);
    return manager;
  }

  #newAttempt(mode, knownAccountName = '') {
    const loginId = crypto.randomBytes(18).toString('base64url');
    const authSession = new LoginSession(EAuthTokenPlatformType.SteamClient);
    authSession.loginTimeout = 5 * 60_000;

    const pending = {
      loginId,
      mode,
      authSession,
      knownAccountName: String(knownAccountName || '').trim(),
      accountId: '',
      sessionToken: '',
      status: 'starting',
      message: mode === 'qr' ? 'Generazione QR Code Steam...' : 'Contatto Steam...',
      canApprove: false,
      canCode: false,
      codeKind: '',
      guardDetail: '',
      remoteInteraction: false,
      qrImage: '',
      expiresAt: Date.now() + 10 * 60_000,
      error: ''
    };

    authSession.on('polling', () => {
      if (!this.pending.has(loginId)) return;
      if (pending.status !== 'connecting') pending.status = 'verification';
    });

    authSession.on('remoteInteraction', () => {
      if (!this.pending.has(loginId)) return;
      pending.remoteInteraction = true;
      pending.message = 'Richiesta aperta nell’app Steam. Premi Approva per continuare.';
    });

    authSession.on('steamGuardMachineToken', () => {
      if (!pending.knownAccountName || !authSession.steamGuardMachineToken) return;
      const accountId = accountIdForName(pending.knownAccountName);
      this.vault.set(`steamMachineToken:${accountId}`, authSession.steamGuardMachineToken);
    });

    authSession.on('authenticated', () => {
      this.#completeAuthentication(pending).catch((error) => {
        pending.status = 'error';
        pending.error = friendlySteamError(error);
        pending.message = pending.error;
      });
    });

    authSession.on('timeout', () => {
      if (!this.pending.has(loginId)) return;
      pending.status = 'error';
      pending.error = 'Il tentativo di accesso è scaduto. Genera un nuovo QR o riprova con le credenziali.';
      pending.message = pending.error;
    });

    authSession.on('error', (error) => {
      if (!this.pending.has(loginId)) return;
      pending.status = 'error';
      pending.error = friendlySteamError(error);
      pending.message = pending.error;
    });

    this.pending.set(loginId, pending);
    return pending;
  }

  #setActions(pending, actions) {
    const normalized = normalizeActions(actions);
    Object.assign(pending, normalized);

    if (normalized.canApprove && normalized.canCode) {
      pending.message = normalized.codeKind === 'email'
        ? `Approva dall’app Steam oppure inserisci il codice inviato a ${normalized.guardDetail || 'email'}.`
        : 'Approva dall’app Steam oppure inserisci il codice Steam Guard.';
    } else if (normalized.canApprove) {
      pending.message = 'Apri l’app Steam e premi Approva. PiBoost entrerà automaticamente.';
    } else if (normalized.canCode) {
      pending.message = normalized.codeKind === 'email'
        ? `Inserisci il codice inviato a ${normalized.guardDetail || 'email'}.`
        : 'Inserisci il codice Steam Guard mostrato nell’app.';
    } else {
      pending.message = 'Autenticazione in corso...';
    }
  }

  async #completeAuthentication(pending) {
    if (!this.pending.has(pending.loginId)) return;
    const authSession = pending.authSession;
    const accountName = String(authSession.accountName || pending.knownAccountName || '').trim();
    const refreshToken = String(authSession.refreshToken || '');
    const steamId64 = authSession.steamID && typeof authSession.steamID.getSteamID64 === 'function'
      ? authSession.steamID.getSteamID64()
      : '';

    if (!accountName || !refreshToken) throw new Error('Steam non ha restituito una sessione valida.');

    const accountId = accountIdForName(accountName);
    const exists = Boolean(this.registry.get(accountId));
    if (!exists && this.registry.list().length >= this.maxAccounts) {
      throw new Error(`Limite di ${this.maxAccounts} account raggiunto sul Raspberry.`);
    }

    for (const [otherId, other] of this.pending.entries()) {
      if (otherId !== pending.loginId && other.accountId === accountId) this.cancelLogin(otherId);
    }

    this.registry.upsert(accountId, { accountName, steamId64 });
    const existing = this.get(accountId);
    const existingState = existing ? existing.getPublicState() : null;
    const canReuse = Boolean(existing && ['online', 'connecting', 'guard_required'].includes(existingState.connection));
    const manager = canReuse
      ? existing
      : this.#createManager(accountId, accountName, { replace: true });

    pending.accountId = accountId;
    pending.knownAccountName = accountName;
    pending.status = 'connecting';
    pending.expiresAt = Date.now() + 5 * 60_000;

    if (canReuse) {
      manager.updateSavedAuthentication(accountName, refreshToken, steamId64);
      pending.message = existingState.boosting || existingState.desiredBoosting
        ? 'Accesso completato. Il boost rimasto attivo è ancora in esecuzione.'
        : 'Accesso completato. Account Steam già collegato al Raspberry.';
    } else {
      pending.message = 'Verifica completata. Connessione al client Steam...';
      manager.loginWithRefreshToken(accountName, refreshToken, steamId64);
    }
  }

  get(accountId) {
    return this.accounts.get(accountId) || null;
  }

  getByToken(token) {
    const accountId = this.sessions.resolve(token);
    if (!accountId) return null;
    return this.get(accountId);
  }

  accountIdByToken(token) {
    return this.sessions.resolve(token) || '';
  }

  async startCredentialLogin(accountName, password) {
    const cleanName = String(accountName || '').trim();
    const cleanPassword = String(password || '');
    if (!cleanName || !cleanPassword) throw new Error('Inserisci nome account e password Steam.');

    const accountId = accountIdForName(cleanName);
    const exists = Boolean(this.registry.get(accountId));
    if (!exists && this.registry.list().length >= this.maxAccounts) {
      throw new Error(`Limite di ${this.maxAccounts} account raggiunto sul Raspberry.`);
    }

    for (const [pendingId, pending] of this.pending.entries()) {
      if (pending.knownAccountName.toLowerCase() === cleanName.toLowerCase()) this.cancelLogin(pendingId);
    }

    const pending = this.#newAttempt('password', cleanName);
    try {
      const machineToken = this.vault.get(`steamMachineToken:${accountId}`) || undefined;
      const result = await pending.authSession.startWithCredentials({
        accountName: cleanName,
        password: cleanPassword,
        steamGuardMachineToken: machineToken
      });
      if (!pending.accountId && pending.status !== 'error') {
        this.#setActions(pending, result.validActions);
        pending.status = result.actionRequired ? 'verification' : 'starting';
      }
      return { loginId: pending.loginId, status: this.loginStatus(pending.loginId) };
    } catch (error) {
      pending.status = 'error';
      pending.error = friendlySteamError(error);
      pending.message = pending.error;
      throw new Error(pending.error);
    }
  }

  async startQrLogin() {
    const pending = this.#newAttempt('qr');
    try {
      const result = await pending.authSession.startWithQR();
      if (!pending.accountId && pending.status !== 'error') {
        this.#setActions(pending, result.validActions);
        pending.status = 'verification';
        pending.message = 'Scansiona il QR con l’app Steam, poi premi Approva.';
      }
      pending.qrImage = await QRCode.toDataURL(result.qrChallengeUrl, {
        width: 280,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#07111fff', light: '#ffffffff' }
      });
      return { loginId: pending.loginId, status: this.loginStatus(pending.loginId) };
    } catch (error) {
      pending.status = 'error';
      pending.error = friendlySteamError(error);
      pending.message = pending.error;
      throw new Error(pending.error);
    }
  }

  async submitGuard(loginId, code) {
    const pending = this.#requirePending(loginId);
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('Inserisci il codice Steam Guard.');
    try {
      await pending.authSession.submitSteamGuardCode(cleanCode);
      pending.status = 'verification';
      pending.message = 'Codice accettato. Attendo la conferma di Steam...';
    } catch (error) {
      const message = friendlySteamError(error);
      pending.message = message;
      throw new Error(message);
    }
  }

  forcePoll(loginId) {
    const pending = this.#requirePending(loginId);
    try {
      pending.authSession.forcePoll();
      pending.message = 'Controllo immediato della conferma Steam...';
    } catch (_error) {
      // Il polling automatico potrebbe non essere ancora partito oppure potrebbe essere già terminato.
    }
  }

  cancelLogin(loginId) {
    const key = String(loginId || '');
    const pending = this.pending.get(key);
    if (!pending) return;
    try { pending.authSession.cancelLoginAttempt(); } catch (_error) {}
    this.pending.delete(key);
  }

  #requirePending(loginId) {
    const key = String(loginId || '');
    const pending = this.pending.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      if (pending) this.cancelLogin(key);
      throw new Error('Tentativo di accesso scaduto. Ricomincia il login.');
    }
    if (pending.status === 'error') throw new Error(pending.message || 'Accesso Steam non riuscito.');
    return pending;
  }

  loginStatus(loginId) {
    const pending = this.#requirePending(loginId);
    let authenticated = false;
    let token = '';
    let profile = null;
    let connection = pending.status;
    let message = pending.message;

    if (pending.accountId) {
      const manager = this.get(pending.accountId);
      if (!manager) throw new Error('Account non disponibile.');
      const steam = manager.getPublicState();
      connection = steam.connection;
      message = steam.message || message;

      if (steam.connection === 'online') {
        authenticated = true;
        if (!pending.sessionToken) pending.sessionToken = this.sessions.issue(pending.accountId);
        token = pending.sessionToken;
        profile = steam.profile;
        pending.expiresAt = Date.now() + 2 * 60_000;
      } else if (steam.connection === 'error') {
        pending.status = 'error';
        pending.error = steam.message || 'Connessione Steam non riuscita.';
      }
    }

    return {
      loginId: pending.loginId,
      mode: pending.mode,
      connection,
      message,
      verificationRequired: pending.status === 'verification',
      canApprove: pending.canApprove,
      canCode: pending.canCode,
      codeKind: pending.codeKind,
      guardDetail: pending.guardDetail,
      remoteInteraction: pending.remoteInteraction,
      qrImage: pending.qrImage,
      authenticated,
      token,
      profile
    };
  }

  logout(token, { continueBoost = false } = {}) {
    const accountId = this.sessions.resolve(token);
    if (!accountId) {
      this.sessions.revoke(token);
      return { continuedBoost: false, boostWasActive: false };
    }

    const manager = this.get(accountId);
    const steam = manager ? manager.getPublicState() : null;
    const boostWasActive = Boolean(steam && (steam.boosting || steam.desiredBoosting));
    const continuedBoost = Boolean(continueBoost && boostWasActive && manager);

    if (!continuedBoost && manager) manager.logoutFully();

    // Il logout rimuove tutte le sessioni web dell'account. In modalità
    // continua-boost il client Steam e il refresh token restano sul Raspberry.
    this.sessions.revokeAccount(accountId);
    return { continuedBoost, boostWasActive };
  }

  removeAccount(accountId) {
    const manager = this.get(accountId);
    if (!manager) return;
    manager.disconnect({ removeToken: true });
    manager.shutdownForReplacement();
    this.sessions.revokeAccount(accountId);
    this.vault.remove(`steamRefreshToken:${accountId}`);
    this.vault.remove(`steamMachineToken:${accountId}`);
    this.registry.remove(accountId);
    this.accounts.delete(accountId);
    try { fs.rmSync(this.#accountDir(accountId), { recursive: true, force: true }); } catch (_error) {}
  }

  connectSavedAll() {
    let delay = 0;
    for (const manager of this.accounts.values()) {
      setTimeout(() => manager.connectWithSavedToken(), delay).unref();
      delay += 900;
    }
  }

  adminAccounts() {
    return this.registry.list().map((record) => {
      const manager = this.get(record.id);
      const state = manager ? manager.getPublicState() : null;
      return {
        id: record.id,
        accountName: record.accountName || '',
        steamId64: (state && (state.profile.steamId64 || state.steamId64)) || record.steamId64 || '',
        personaName: (state && state.profile.personaName) || record.personaName || record.accountName || 'Steam',
        avatar: (state && state.profile.avatar) || record.avatar || '',
        connection: state ? state.connection : 'offline',
        message: state ? state.message : 'Non caricato',
        boosting: Boolean(state && (state.boosting || state.desiredBoosting)),
        boostMode: state ? state.boostMode : 'none',
        activeGames: state ? state.activeGames : [],
        activeSeconds: state ? state.activeSeconds : 0,
        totalSeconds: state ? state.totalSeconds : 0,
        gamesCount: state && Array.isArray(state.games) ? state.games.length : 0,
        favoritesCount: state && Array.isArray(state.favorites) ? state.favorites.length : 0,
        autoRestart: Boolean(state && state.settings && state.settings.autoRestart),
        keepBoostOnLogout: Boolean(state && state.settings && state.settings.keepBoostOnLogout),
        autoStartBoostOnBoot: Boolean(state && state.settings && state.settings.autoStartBoostOnBoot),
        lastModifiedAt: state && state.lastModifiedAt || record.updatedAt || '',
        createdAt: record.createdAt || '',
        updatedAt: record.updatedAt || ''
      };
    }).sort((a, b) => Number(b.boosting) - Number(a.boosting) || a.personaName.localeCompare(b.personaName));
  }

  adminAccountDetails(accountId) {
    const manager = this.get(String(accountId || ''));
    if (!manager) throw new Error('Account non trovato.');
    return manager.getAdminSnapshot();
  }

  stopAccountBoost(accountId, reason = 'admin_stop') {
    const manager = this.get(String(accountId || ''));
    if (!manager) throw new Error('Account non trovato.');
    manager.stopBoost(reason);
    return manager.getPublicState();
  }

  disconnectAccount(accountId) {
    const manager = this.get(String(accountId || ''));
    if (!manager) throw new Error('Account non trovato.');
    manager.disconnect({ removeToken: false });
    this.sessions.revokeAccount(String(accountId || ''));
    return manager.getPublicState();
  }

  stopAllBoosts(reason = 'maintenance') {
    let stopped = 0;
    for (const manager of this.accounts.values()) {
      const state = manager.getPublicState();
      if (state.boosting || state.desiredBoosting) {
        manager.stopBoost(reason);
        stopped += 1;
      }
    }
    return stopped;
  }

  cancelAllLogins() {
    const count = this.pending.size;
    for (const loginId of [...this.pending.keys()]) this.cancelLogin(loginId);
    return count;
  }

  shutdownAll(reason = 'service_stop') {
    for (const loginId of [...this.pending.keys()]) this.cancelLogin(loginId);
    for (const manager of this.accounts.values()) {
      try { manager.shutdownGracefully(reason); } catch (_error) {}
    }
  }

  #prunePending() {
    const now = Date.now();
    for (const [key, pending] of this.pending.entries()) {
      if (pending.expiresAt < now) this.cancelLogin(key);
    }
    this.sessions.prune();
  }
}

module.exports = { MultiSteam, accountIdForName };
