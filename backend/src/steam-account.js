'use strict';

const path = require('path');
const SteamUser = require('steam-user');
const { JsonStore } = require('./json-store');
const { recordSession, historySnapshot, normalizeSession } = require('./stats-utils');

const PERSONA = {
  Online: SteamUser.EPersonaState.Online,
  Away: SteamUser.EPersonaState.Away,
  Invisible: SteamUser.EPersonaState.Invisible,
  Busy: SteamUser.EPersonaState.Busy,
  LookingToPlay: SteamUser.EPersonaState.LookingToPlay
};

const UI_MODE = {
  Normal: SteamUser.EClientUIMode && SteamUser.EClientUIMode.Normal,
  BigPicture: SteamUser.EClientUIMode && SteamUser.EClientUIMode.BigPicture,
  Mobile: SteamUser.EClientUIMode && SteamUser.EClientUIMode.Mobile,
  VR: SteamUser.EClientUIMode && SteamUser.EClientUIMode.VR
};

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlValue(xml, tag) {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml);
  if (cdata) return decodeXml(cdata[1].trim());
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return plain ? decodeXml(plain[1].trim()) : '';
}

function avatarUrlFromHash(hashValue) {
  if (!hashValue) return '';
  let hex = '';
  if (Buffer.isBuffer(hashValue)) hex = hashValue.toString('hex');
  else if (Array.isArray(hashValue)) hex = Buffer.from(hashValue).toString('hex');
  else if (typeof hashValue === 'string') hex = hashValue.replace(/[^a-fA-F0-9]/g, '');
  if (!/^[a-fA-F0-9]{40}$/.test(hex) || /^0+$/.test(hex)) return '';
  return `https://avatars.fastly.steamstatic.com/${hex}_full.jpg`;
}

function stableLogonId(value) {
  let hash = 2166136261;
  for (const char of String(value || 'piboost')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

class SteamAccount {
  constructor({ accountId, accountName, accountDir, vault, registry }) {
    this.accountId = accountId;
    this.accountName = accountName || '';
    this.accountDir = accountDir;
    this.vault = vault;
    this.registry = registry;
    this.store = new JsonStore(accountDir);
    this.tokenKey = `steamRefreshToken:${accountId}`;
    this.logonID = stableLogonId(accountId);

    this.client = new SteamUser({
      renewRefreshTokens: true,
      dataDirectory: path.join(accountDir, 'steam-client'),
      autoRelogin: true,
      webCompatibilityMode: false
    });

    this.state = {
      connection: 'offline',
      message: 'Steam non collegato',
      steamId64: '',
      guardRequired: false,
      guardDomain: null,
      guardWrong: false,
      guardNotBefore: 0,
      blockedByOtherSession: false,
      playingElsewhereAppId: 0,
      boosting: false,
      desiredBoosting: false,
      boostMode: 'none',
      activeFavoriteAppId: 0,
      startedAt: null,
      currentGameIndex: 0,
      lastError: '',
      sessionExpiredAt: 0
    };

    this.pendingGuardCallback = null;
    this.autoStopTimer = null;
    this.rotationTimer = null;
    this.sessionId = '';
    this.sessionStart = null;
    this.sessionGames = [];
    this.sessionMode = 'none';
    this.sessionTotalBeforeSeconds = 0;
    this.sessionIntervals = [];
    this.sessionActiveStartedAt = null;
    this.sessionSegments = [];
    this.activeSegmentStartedAt = null;
    this.activeSegmentGames = [];
    this.checkpointTimer = null;
    this.resumeTimer = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastAwayReply = new Map();
    this.disposed = false;

    this.store.update((draft) => {
      if (!draft.profile.accountName && this.accountName) draft.profile.accountName = this.accountName;
    });
    this.#recoverRememberedGames();
    this.#recoverInterruptedSession();
    this.#restoreBootBoostIntent();

    this.#bindEvents();
  }

  #bindEvents() {
    this.client.on('refreshToken', (token) => {
      if (!this.disposed) this.vault.set(this.tokenKey, token);
    });

    this.client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      if (this.disposed) return;
      this.pendingGuardCallback = callback;
      this.state.connection = 'guard_required';
      this.state.guardRequired = true;
      this.state.guardDomain = domain || 'mobile';
      this.state.guardWrong = Boolean(lastCodeWrong);
      this.state.guardNotBefore = lastCodeWrong ? Date.now() + 30_000 : 0;
      this.state.message = lastCodeWrong
        ? 'Codice Steam Guard errato. Attendi 30 secondi prima di riprovare.'
        : 'Inserisci il codice Steam Guard oppure approva nell’app Steam.';
    });

    this.client.on('loggedOn', () => {
      if (this.disposed) return;
      this.state.connection = 'online';
      this.state.guardRequired = false;
      this.state.guardWrong = false;
      this.state.guardNotBefore = 0;
      this.pendingGuardCallback = null;
      this.state.steamId64 = this.client.steamID ? this.client.steamID.getSteamID64() : '';
      this.state.message = 'Connesso a Steam';
      this.state.lastError = '';
      this.state.sessionExpiredAt = 0;

      this.store.update((draft) => {
        draft.profile.accountName = this.accountName || draft.profile.accountName;
        draft.profile.steamId64 = this.state.steamId64 || draft.profile.steamId64;
      });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempt = 0;
      const currentPlayingState = this.client.playingState || {};
      this.state.blockedByOtherSession = Boolean(currentPlayingState.blocked);
      this.state.playingElsewhereAppId = this.state.blockedByOtherSession
        ? Number(currentPlayingState.appid || 0)
        : 0;

      this.#syncRegistry();
      this.#applyAppearance();
      this.refreshPublicProfile().catch(() => {});
      if (this.state.desiredBoosting) this.#scheduleBoostResume(1800);
    });

    this.client.on('accountInfo', (...args) => {
      if (this.disposed) return;
      const first = args[0];
      const name = first && typeof first === 'object' ? first.name : first;
      if (typeof name === 'string' && name.trim()) {
        this.store.update((draft) => {
          draft.profile.personaName = name.trim();
        });
        this.#syncRegistry();
      }
    });

    this.client.on('user', (steamId, user) => {
      if (this.disposed) return;
      try {
        const own = this.state.steamId64;
        const id = steamId && typeof steamId.getSteamID64 === 'function' ? steamId.getSteamID64() : String(steamId || '');
        if (!own || id !== own || !user) return;
        const personaName = user.player_name || user.persona_name || user.name || '';
        const avatar = avatarUrlFromHash(user.avatar_hash || user.avatarHash || user.avatar);
        if (!personaName && !avatar) return;
        this.store.update((draft) => {
          if (personaName) draft.profile.personaName = String(personaName).trim();
          if (avatar) draft.profile.avatar = avatar;
        });
        this.#syncRegistry();
      } catch (_error) {}
    });

    this.client.on('disconnected', (eresult, message) => {
      if (this.disposed) return;
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      this.#pauseTracking(Date.now());
      this.state.connection = 'offline';
      this.state.boosting = false;
      this.state.message = message || `Steam disconnesso (${eresult || 'n/d'})`;
    });

    this.client.on('error', (error) => {
      if (this.disposed) return;
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      this.#pauseTracking(Date.now());

      const message = error && error.message ? error.message : String(error);
      if (this.#isPlayingElsewhereError(error)) {
        this.state.connection = 'offline';
        this.state.blockedByOtherSession = true;
        this.state.boosting = false;
        this.state.lastError = '';
        this.state.message = 'Steam è in uso su un altro dispositivo. PiBoost si ricollegherà automaticamente.';
        this.#scheduleSteamReconnect();
        return;
      }

      // Token scaduto o revocato (password cambiata, "disconnetti tutti i
      // dispositivi" da Steam, token troppo vecchio): Steam non accettera' piu'
      // questo accesso, serve un nuovo login. Il boost desiderato resta
      // memorizzato e riparte dopo il nuovo accesso.
      if (this.#isSessionExpiredError(error)) {
        this.state.connection = 'session_expired';
        this.state.sessionExpiredAt = this.state.sessionExpiredAt || Date.now();
        this.state.lastError = message;
        this.state.message = 'Sessione Steam scaduta: esci e accedi di nuovo (QR o password) per riprendere il boost.';
        this.state.boosting = false;
        return;
      }

      this.state.connection = 'error';
      this.state.lastError = message;
      this.state.message = message;
      this.state.boosting = false;
    });

    this.client.on('playingState', (blockedOrState, playingApp) => {
      if (this.disposed) return;

      const objectState = blockedOrState && typeof blockedOrState === 'object' ? blockedOrState : null;
      const blocked = objectState ? Boolean(objectState.blocked) : Boolean(blockedOrState);
      const appid = objectState
        ? Number(objectState.playingApp || objectState.appid || playingApp || 0)
        : Number(playingApp || 0);
      const wasBlocked = this.state.blockedByOtherSession;

      this.state.blockedByOtherSession = blocked;
      this.state.playingElsewhereAppId = blocked ? appid : 0;

      if (blocked) {
        clearTimeout(this.resumeTimer);
        this.resumeTimer = null;
        this.#pauseTracking(Date.now());
        this.state.boosting = false;
        this.state.message = appid
          ? `Stai giocando davvero (AppID ${appid}). Boost in pausa.`
          : 'Stai giocando davvero su un altro dispositivo. Boost in pausa.';
        return;
      }

      if (wasBlocked && this.state.desiredBoosting && this.store.get().settings.autoRestart) {
        this.state.message = 'Gioco chiuso. Ripresa automatica del boost...';
        this.#scheduleBoostResume(2200);
      }
    });

    this.client.on('friendRelationship', (steamId, relationship) => {
      if (this.disposed) return;
      const settings = this.store.get().settings;
      if (
        settings.autoFriend &&
        SteamUser.EFriendRelationship &&
        relationship === SteamUser.EFriendRelationship.RequestRecipient
      ) {
        this.client.addFriend(steamId, () => {});
      }
    });

    this.client.on('friendMessage', (steamId, message) => {
      if (this.disposed) return;
      const settings = this.store.get().settings;
      if (!settings.awayMessageEnabled || !settings.awayMessage) return;
      const id = steamId.toString();
      const last = this.lastAwayReply.get(id) || 0;
      if (Date.now() - last < 5 * 60 * 1000) return;
      if (!message || String(message).startsWith('[Auto]')) return;
      this.lastAwayReply.set(id, Date.now());
      try {
        this.client.chatMessage(steamId, settings.awayMessage);
      } catch (_error) {}
    });
  }

  #isPlayingElsewhereError(error) {
    const result = Number(error && error.eresult);
    const elsewhereResults = [
      SteamUser.EResult && SteamUser.EResult.LoggedInElsewhere,
      SteamUser.EResult && SteamUser.EResult.AlreadyLoggedInElsewhere,
      SteamUser.EResult && SteamUser.EResult.LogonSessionReplaced
    ].filter((value) => Number.isFinite(Number(value))).map(Number);
    const message = error && error.message ? String(error.message) : String(error || '');
    return elsewhereResults.includes(result) || /LoggedInElsewhere|AlreadyLoggedInElsewhere|LogonSessionReplaced/i.test(message);
  }

  #isSessionExpiredError(error) {
    const E = SteamUser.EResult || {};
    const expired = [E.InvalidPassword, E.AccessDenied, E.Expired, E.Revoked, E.InvalidSignature]
      .filter((value) => Number.isFinite(Number(value))).map(Number);
    const result = Number(error && error.eresult);
    const message = error && error.message ? String(error.message) : String(error || '');
    return expired.includes(result) || /InvalidPassword|AccessDenied|Expired|Revoked|InvalidSignature/i.test(message);
  }

  needsAttention() {
    return this.state.connection === 'session_expired' || this.state.connection === 'guard_required';
  }

  #scheduleSteamReconnect() {
    if (this.disposed || !this.vault.get(this.tokenKey)) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(30_000, 5_000 + (this.reconnectAttempt * 5_000));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.state.connection === 'online' || this.state.connection === 'connecting') return;
      this.reconnectAttempt += 1;
      this.connectWithSavedToken().then((started) => {
        if (!started && this.state.connection !== 'online' && this.state.connection !== 'connecting') {
          this.#scheduleSteamReconnect();
        }
      }).catch(() => this.#scheduleSteamReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  #scheduleBoostResume(delay = 1800, attempt = 0) {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;

    // Durante l'evento playingState, steam-user può aggiornare la proprietà
    // client.playingState solo dopo aver chiamato i listener. Usiamo quindi
    // esclusivamente lo stato interno, già aggiornato dal listener, per non
    // scartare per errore la ripresa quando il gioco reale è stato chiuso.
    if (
      this.disposed ||
      !this.state.desiredBoosting ||
      this.state.connection !== 'online' ||
      this.state.blockedByOtherSession
    ) return;

    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (
        this.disposed ||
        !this.state.desiredBoosting ||
        this.state.connection !== 'online' ||
        this.state.blockedByOtherSession
      ) return;

      try {
        this.#applyGames();
        this.state.lastError = '';
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        this.state.lastError = message;

        // Steam può impiegare qualche secondo a liberare la sessione di gioco.
        // Riprova senza richiedere logout, ma soltanto finché l'utente desidera
        // ancora il boost e non sta giocando altrove.
        if (
          attempt < 4 &&
          !this.disposed &&
          this.state.desiredBoosting &&
          this.state.connection === 'online' &&
          !this.state.blockedByOtherSession
        ) {
          this.state.message = 'Ripresa del boost in corso... nuovo tentativo automatico.';
          this.#scheduleBoostResume(2500, attempt + 1);
          return;
        }

        this.state.message = message;
      }
    }, Math.max(250, Number(delay) || 1800));
    this.resumeTimer.unref();
  }

  #syncRegistry() {
    const profile = this.store.get().profile;
    this.registry.upsert(this.accountId, {
      accountName: profile.accountName || this.accountName,
      steamId64: profile.steamId64 || this.state.steamId64,
      personaName: profile.personaName || '',
      avatar: profile.avatar || ''
    });
  }

  async refreshPublicProfile() {
    const steamId64 = this.state.steamId64 || this.store.get().profile.steamId64;
    if (!steamId64) return false;
    try {
      const response = await fetch(`https://steamcommunity.com/profiles/${encodeURIComponent(steamId64)}?xml=1`, {
        signal: AbortSignal.timeout(7000),
        headers: { 'User-Agent': 'PiBoost/4.2.0' }
      });
      if (!response.ok) return false;
      const xml = await response.text();
      const personaName = xmlValue(xml, 'steamID');
      const avatar = xmlValue(xml, 'avatarFull');
      if (!personaName && !avatar) return false;
      this.store.update((draft) => {
        if (personaName) draft.profile.personaName = personaName;
        if (avatar) draft.profile.avatar = avatar;
      });
      this.#syncRegistry();
      return true;
    } catch (_error) {
      return false;
    }
  }

  async connectWithSavedToken() {
    const token = this.vault.get(this.tokenKey);
    if (!token || this.state.connection === 'online' || this.state.connection === 'connecting') return false;
    this.state.connection = 'connecting';
    this.state.message = 'Connessione a Steam con token salvato...';
    try {
      this.client.logOn({
        refreshToken: token,
        machineName: 'PiBoost Raspberry Pi',
        logonID: this.logonID
      });
      return true;
    } catch (error) {
      this.state.connection = 'error';
      this.state.message = error.message;
      this.state.lastError = error.message;
      return false;
    }
  }

  updateSavedAuthentication(accountName, refreshToken, steamId64 = '') {
    if (!accountName || !refreshToken) throw new Error('Sessione Steam non valida.');
    this.accountName = String(accountName).trim();
    this.vault.set(this.tokenKey, String(refreshToken));
    this.store.update((draft) => {
      draft.profile.accountName = this.accountName;
      if (steamId64) draft.profile.steamId64 = String(steamId64);
    });
    if (steamId64) this.state.steamId64 = String(steamId64);
    this.#syncRegistry();
  }

  loginWithRefreshToken(accountName, refreshToken, steamId64 = '') {
    if (!accountName || !refreshToken) throw new Error('Sessione Steam non valida.');
    this.stopBoost('new_login');
    this.accountName = String(accountName).trim();
    this.vault.set(this.tokenKey, String(refreshToken));
    this.store.update((draft) => {
      draft.profile.accountName = this.accountName;
      if (steamId64) draft.profile.steamId64 = String(steamId64);
    });
    this.#syncRegistry();

    this.state.connection = 'connecting';
    this.state.message = 'Connessione al client Steam...';
    this.state.lastError = '';
    this.state.guardRequired = false;
    this.state.guardWrong = false;
    this.state.guardNotBefore = 0;
    this.state.desiredBoosting = false;
    this.state.boosting = false;
    this.state.boostMode = 'none';
    this.state.activeFavoriteAppId = 0;
    this.pendingGuardCallback = null;

    this.client.logOn({
      refreshToken: String(refreshToken),
      machineName: 'PiBoost Raspberry Pi',
      logonID: this.logonID
    });
  }

  loginWithPassword(accountName, password) {
    if (!accountName || !password) throw new Error('Nome account e password Steam sono obbligatori.');
    this.accountName = String(accountName).trim();
    this.store.update((draft) => { draft.profile.accountName = this.accountName; });
    this.#syncRegistry();

    this.state.connection = 'connecting';
    this.state.message = 'Accesso a Steam in corso...';
    this.state.lastError = '';
    this.state.guardRequired = false;
    this.state.guardWrong = false;
    this.state.guardNotBefore = 0;
    this.pendingGuardCallback = null;

    this.client.logOn({
      accountName: this.accountName,
      password: String(password),
      machineName: 'PiBoost Raspberry Pi',
      logonID: this.logonID
    });
  }

  submitGuard(code) {
    if (!this.pendingGuardCallback) throw new Error('Steam Guard non è stato richiesto.');
    if (this.state.guardNotBefore && Date.now() < this.state.guardNotBefore) {
      const seconds = Math.ceil((this.state.guardNotBefore - Date.now()) / 1000);
      throw new Error(`Attendi ${seconds} secondi prima di inviare un nuovo codice Steam Guard.`);
    }
    const callback = this.pendingGuardCallback;
    this.pendingGuardCallback = null;
    this.state.guardRequired = false;
    this.state.connection = 'connecting';
    this.state.message = 'Verifica Steam Guard...';
    callback(String(code || '').trim());
  }

  disconnect({ removeToken = false, message = '' } = {}) {
    this.stopBoost('disconnect');
    try { this.client.logOff(); } catch (_error) {}
    if (removeToken) this.vault.remove(this.tokenKey);
    this.state.connection = 'offline';
    this.state.message = message || (removeToken ? 'Logout completato' : 'Steam disconnesso');
    this.state.lastError = '';
    this.state.guardRequired = false;
    this.pendingGuardCallback = null;
  }

  logoutFully() {
    this.disconnect({ removeToken: true, message: 'Logout completato' });
  }

  shutdownForReplacement() {
    if (this.disposed) return;
    this.stopBoost('new_login');
    this.disposed = true;
    try { this.client.logOff(); } catch (_error) {}
    try {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
    } catch (_error) {}
    clearTimeout(this.resumeTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.autoStopTimer);
    clearInterval(this.rotationTimer);
    this.pendingGuardCallback = null;
  }

  recordChange(type, details = {}) {
    this.store.recordChange(type, details);
  }

  getAdminSnapshot() {
    const stored = this.store.get();
    return {
      state: this.getPublicState(),
      history: this.getHistory(),
      changeLog: Array.isArray(stored.changeLog) ? stored.changeLog.slice(0, 250) : [],
      boostMemory: stored.boostMemory || {},
      metadata: stored.metadata || {}
    };
  }

  #rememberRuntimeBoost({ running, mode, favoriteAppId = 0, reason = '' }) {
    const stored = this.store.get();
    const games = mode === 'favorite'
      ? stored.favorites.filter((game) => Number(game.appid) === Number(favoriteAppId))
      : stored.games.slice(0, 32);
    const cleanGames = games.map((game) => this.#cleanGame(game)).filter(Boolean);
    this.store.update((draft) => {
      draft.boostMemory = {
        wasRunning: Boolean(running),
        mode: running ? (mode === 'favorite' ? 'favorite' : 'games') : (draft.boostMemory && draft.boostMemory.mode) || 'none',
        favoriteAppId: mode === 'favorite' ? Number(favoriteAppId || 0) : 0,
        gameAppIds: cleanGames.map((game) => game.appid),
        games: cleanGames,
        startedAt: running ? (draft.boostMemory && draft.boostMemory.startedAt) || new Date().toISOString() : (draft.boostMemory && draft.boostMemory.startedAt) || null,
        stoppedAt: running ? null : new Date().toISOString(),
        lastReason: String(reason || ''),
        updatedAt: new Date().toISOString()
      };
    });
  }

  updateSettings() {
    if (this.state.connection === 'online') this.#applyAppearance();
    if (this.state.desiredBoosting) this.#applyGames();
  }


  setAutoStartBoostOnBoot(enabled) {
    const value = Boolean(enabled);
    this.store.update((draft) => {
      draft.settings.autoStartBoostOnBoot = value;
      if (!draft.bootBoost || typeof draft.bootBoost !== 'object') {
        draft.bootBoost = { mode: 'games', favoriteAppId: 0, updatedAt: null, games: [] };
      }
      if (value) {
        const mode = this.state.desiredBoosting && this.state.boostMode === 'favorite' ? 'favorite' : 'games';
        const favoriteAppId = mode === 'favorite' ? Number(this.state.activeFavoriteAppId || 0) : 0;
        const sourceGames = mode === 'favorite'
          ? draft.favorites.filter((game) => Number(game.appid) === favoriteAppId)
          : draft.games.slice(0, 32);
        draft.bootBoost.mode = mode;
        draft.bootBoost.favoriteAppId = favoriteAppId;
        draft.bootBoost.games = sourceGames.map((game) => this.#cleanGame(game)).filter(Boolean);
        draft.bootBoost.updatedAt = new Date().toISOString();
      }
    });
    return this.store.get().settings.autoStartBoostOnBoot;
  }

  #rememberBootBoostPlan(mode, favoriteAppId = 0) {
    const normalizedMode = mode === 'favorite' ? 'favorite' : 'games';
    this.store.update((draft) => {
      const sourceGames = normalizedMode === 'favorite'
        ? draft.favorites.filter((game) => Number(game.appid) === Number(favoriteAppId || 0))
        : draft.games.slice(0, 32);
      draft.bootBoost = {
        mode: normalizedMode,
        favoriteAppId: normalizedMode === 'favorite' ? Number(favoriteAppId || 0) : 0,
        updatedAt: new Date().toISOString(),
        games: sourceGames.map((game) => this.#cleanGame(game)).filter(Boolean)
      };
    });
  }

  #restoreBootBoostIntent() {
    const stored = this.store.get();
    if (!stored.settings.autoStartBoostOnBoot || !this.vault.has(this.tokenKey)) return;

    const savedPlan = stored.bootBoost && typeof stored.bootBoost === 'object'
      ? stored.bootBoost
      : { mode: 'games', favoriteAppId: 0 };
    let mode = savedPlan.mode === 'favorite' ? 'favorite' : 'games';
    let favoriteAppId = Number(savedPlan.favoriteAppId || 0);

    if (mode === 'favorite') {
      const favoriteExists = stored.favorites.some((game) => Number(game.appid) === favoriteAppId);
      if (!favoriteExists) {
        mode = 'games';
        favoriteAppId = 0;
      }
    }

    if (mode === 'games' && !stored.games.length) {
      const recovered = [
        ...((savedPlan && savedPlan.games) || []),
        ...((stored.boostMemory && stored.boostMemory.games) || [])
      ].map((game) => this.#cleanGame(game)).filter(Boolean).slice(0, 32);
      if (recovered.length) {
        this.store.update((draft) => { draft.games = recovered; });
      } else {
        this.state.message = 'Avvio automatico attivo, ma non ci sono giochi multipli salvati.';
        return;
      }
    }

    this.state.boostMode = mode;
    this.state.activeFavoriteAppId = favoriteAppId;
    this.state.desiredBoosting = true;
    this.state.currentGameIndex = 0;
    this.state.message = 'Avvio automatico del boost in attesa della connessione Steam...';
  }

  #applyAppearance() {
    const settings = this.store.get().settings;
    try {
      this.client.setPersona(PERSONA[settings.persona] ?? SteamUser.EPersonaState.Online);
      const uiMode = UI_MODE[settings.uiMode];
      if (uiMode !== undefined && uiMode !== null) this.client.setUIMode(uiMode);
    } catch (error) {
      this.state.lastError = error.message;
    }
  }

  #recoverInterruptedSession() {
    const snapshot = this.store.get().stats.activeSession;
    if (!snapshot || !snapshot.startedAt) return;
    const checkpointMs = Number(snapshot.lastCheckpointAt) || Date.parse(snapshot.startedAt) || Date.now();
    const recovered = this.#sessionFromSnapshot(snapshot, checkpointMs, 'service_interrupted', false);
    this.store.update((draft) => {
      if (recovered.seconds > 0) recordSession(draft.stats, recovered);
      draft.stats.activeSession = null;
    });
  }

  #cleanGame(game) {
    const appid = Number(game && game.appid);
    if (!Number.isInteger(appid) || appid <= 0) return null;
    return {
      appid,
      name: String((game && game.name) || `App ${appid}`),
      image: String((game && game.image) || '')
    };
  }

  #recoverRememberedGames() {
    const stored = this.store.get();
    if (Array.isArray(stored.games) && stored.games.length) return;

    const known = new Map();
    const remember = (items) => {
      for (const raw of Array.isArray(items) ? items : []) {
        const game = this.#cleanGame(raw);
        if (game) known.set(game.appid, game);
      }
    };

    remember(stored.favorites);
    remember(stored.bootBoost && stored.bootBoost.games);
    remember(stored.boostMemory && stored.boostMemory.games);
    remember(stored.stats && stored.stats.activeSession && stored.stats.activeSession.games);
    for (const session of (stored.stats && Array.isArray(stored.stats.sessions) ? stored.stats.sessions : []).slice(0, 30)) {
      remember(session && session.games);
      remember(session && session.segments);
    }

    const wantedIds = [];
    const addId = (value) => {
      const appid = Number(value);
      if (Number.isInteger(appid) && appid > 0 && !wantedIds.includes(appid)) wantedIds.push(appid);
    };
    for (const value of (stored.boostMemory && stored.boostMemory.gameAppIds) || []) addId(value);
    for (const game of (stored.bootBoost && stored.bootBoost.games) || []) addId(game && game.appid);
    for (const game of (stored.boostMemory && stored.boostMemory.games) || []) addId(game && game.appid);
    if (!wantedIds.length && stored.stats && stored.stats.activeSession) {
      for (const game of stored.stats.activeSession.games || []) addId(game && game.appid);
    }

    const recovered = wantedIds.slice(0, 32).map((appid) => known.get(appid) || {
      appid,
      name: `App ${appid}`,
      image: ''
    });
    if (!recovered.length) return;

    this.store.update((draft) => {
      draft.games = recovered;
      if (!draft.bootBoost || typeof draft.bootBoost !== 'object') draft.bootBoost = {};
      draft.bootBoost.games = recovered.map((game) => ({ ...game }));
      draft.bootBoost.updatedAt = draft.bootBoost.updatedAt || new Date().toISOString();
    });
    this.recordChange('games_recovered', { count: recovered.length, appids: recovered.map((game) => game.appid) });
  }

  #mergeSessionGames(games) {
    const merged = new Map(this.sessionGames.map((game) => [Number(game.appid), game]));
    for (const raw of games) {
      const game = this.#cleanGame(raw);
      if (game) merged.set(game.appid, game);
    }
    this.sessionGames = [...merged.values()];
  }

  #beginSessionIfNeeded(games) {
    if (this.sessionStart) {
      this.#mergeSessionGames(games);
      return;
    }
    const now = Date.now();
    this.sessionId = require('crypto').randomUUID();
    this.sessionStart = now;
    this.sessionMode = this.state.boostMode;
    this.sessionGames = [];
    this.#mergeSessionGames(games);
    this.sessionTotalBeforeSeconds = Number(this.store.get().stats.totalSeconds) || 0;
    this.sessionIntervals = [];
    this.sessionActiveStartedAt = null;
    this.sessionSegments = [];
    this.activeSegmentStartedAt = null;
    this.activeSegmentGames = [];
    this.state.startedAt = now;
    this.#startCheckpointTimer();
  }

  #sameGameSet(a, b) {
    const aa = (a || []).map((game) => Number(game.appid)).sort((x, y) => x - y);
    const bb = (b || []).map((game) => Number(game.appid)).sort((x, y) => x - y);
    return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
  }

  #closeActiveSegments(now = Date.now()) {
    if (!this.activeSegmentStartedAt || !this.activeSegmentGames.length) return;
    const end = Math.max(now, this.activeSegmentStartedAt);
    const seconds = Math.max(0, (end - this.activeSegmentStartedAt) / 1000);
    if (seconds > 0) {
      for (const game of this.activeSegmentGames) {
        this.sessionSegments.push({
          ...game,
          startedAt: new Date(this.activeSegmentStartedAt).toISOString(),
          endedAt: new Date(end).toISOString(),
          seconds
        });
      }
    }
    this.activeSegmentStartedAt = null;
    this.activeSegmentGames = [];
  }

  #setTrackedGames(games, now = Date.now()) {
    const clean = (games || []).map((game) => this.#cleanGame(game)).filter(Boolean);
    this.#mergeSessionGames(clean);
    if (this.#sameGameSet(clean, this.activeSegmentGames) && this.sessionActiveStartedAt) return;
    this.#closeActiveSegments(now);
    if (!this.sessionActiveStartedAt) this.sessionActiveStartedAt = now;
    this.activeSegmentStartedAt = now;
    this.activeSegmentGames = clean;
    this.#persistActiveSnapshot(now);
  }

  #pauseTracking(now = Date.now()) {
    if (!this.sessionStart) return;
    this.#closeActiveSegments(now);
    if (this.sessionActiveStartedAt) {
      const start = this.sessionActiveStartedAt;
      const end = Math.max(now, start);
      const seconds = Math.max(0, (end - start) / 1000);
      if (seconds > 0) {
        this.sessionIntervals.push({
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(end).toISOString(),
          seconds
        });
      }
      this.sessionActiveStartedAt = null;
    }
    this.#persistActiveSnapshot(now);
  }

  #snapshot(now = Date.now()) {
    if (!this.sessionStart) return null;
    return {
      id: this.sessionId,
      startedAt: new Date(this.sessionStart).toISOString(),
      mode: this.sessionMode,
      games: this.sessionGames.map((game) => ({ ...game })),
      totalBeforeSeconds: this.sessionTotalBeforeSeconds,
      intervals: this.sessionIntervals.map((item) => ({ ...item })),
      segments: this.sessionSegments.map((item) => ({ ...item })),
      activeIntervalStartedAt: this.sessionActiveStartedAt ? new Date(this.sessionActiveStartedAt).toISOString() : null,
      activeSegmentStartedAt: this.activeSegmentStartedAt ? new Date(this.activeSegmentStartedAt).toISOString() : null,
      activeSegmentGames: this.activeSegmentGames.map((game) => ({ ...game })),
      lastCheckpointAt: now
    };
  }

  #sessionFromSnapshot(snapshot, endMs = Date.now(), reason = 'running', running = true) {
    const raw = {
      id: snapshot.id,
      startedAt: snapshot.startedAt,
      endedAt: new Date(endMs).toISOString(),
      elapsedSeconds: Math.max(0, (endMs - Date.parse(snapshot.startedAt)) / 1000),
      reason,
      mode: snapshot.mode,
      games: snapshot.games || [],
      totalBeforeSeconds: Number(snapshot.totalBeforeSeconds) || 0,
      intervals: [...(snapshot.intervals || [])],
      segments: [...(snapshot.segments || [])],
      running
    };

    const activeIntervalStart = Date.parse(snapshot.activeIntervalStartedAt || '');
    if (Number.isFinite(activeIntervalStart) && endMs > activeIntervalStart) {
      raw.intervals.push({
        startedAt: new Date(activeIntervalStart).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        seconds: (endMs - activeIntervalStart) / 1000
      });
    }

    const activeSegmentStart = Date.parse(snapshot.activeSegmentStartedAt || '');
    if (Number.isFinite(activeSegmentStart) && endMs > activeSegmentStart) {
      for (const game of snapshot.activeSegmentGames || []) {
        raw.segments.push({
          ...game,
          startedAt: new Date(activeSegmentStart).toISOString(),
          endedAt: new Date(endMs).toISOString(),
          seconds: (endMs - activeSegmentStart) / 1000
        });
      }
    }
    return normalizeSession(raw, running);
  }

  #buildActiveSession(now = Date.now()) {
    const snapshot = this.#snapshot(now);
    return snapshot ? this.#sessionFromSnapshot(snapshot, now, 'running', true) : null;
  }

  #persistActiveSnapshot(now = Date.now()) {
    const snapshot = this.#snapshot(now);
    if (!snapshot) return;
    this.store.update((draft) => { draft.stats.activeSession = snapshot; });
  }

  #startCheckpointTimer() {
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = setInterval(() => {
      if (this.sessionStart) this.#persistActiveSnapshot(Date.now());
    }, 30_000);
    this.checkpointTimer.unref();
  }

  #clearSessionMemory() {
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    this.sessionId = '';
    this.sessionStart = null;
    this.sessionGames = [];
    this.sessionMode = 'none';
    this.sessionTotalBeforeSeconds = 0;
    this.sessionIntervals = [];
    this.sessionActiveStartedAt = null;
    this.sessionSegments = [];
    this.activeSegmentStartedAt = null;
    this.activeSegmentGames = [];
  }

  startBoost() {
    if (this.state.connection !== 'online') throw new Error('Prima collega il tuo account Steam.');
    if (!this.store.get().games.length) throw new Error('Seleziona almeno un gioco nella sezione Giochi.');
    if (this.state.desiredBoosting) this.stopBoost('switch_to_games');
    this.state.boostMode = 'games';
    this.state.activeFavoriteAppId = 0;
    this.state.desiredBoosting = true;
    this.state.currentGameIndex = 0;
    this.#applyGames();
    this.#rememberBootBoostPlan('games');
    this.#rememberRuntimeBoost({ running: true, mode: 'games' });
    this.recordChange('boost_started', { mode: 'games', games: this.store.get().games.map((game) => game.appid) });
  }

  startFavoriteBoost(appid) {
    if (this.state.connection !== 'online') throw new Error('Prima collega il tuo account Steam.');
    const id = Number(appid);
    const favorite = this.store.get().favorites.find((game) => Number(game.appid) === id);
    if (!favorite) throw new Error('Il gioco non è più presente nei preferiti.');

    if (
      this.state.desiredBoosting &&
      this.state.boostMode === 'favorite' &&
      Number(this.state.activeFavoriteAppId) === id &&
      this.state.boosting
    ) return;

    if (this.state.desiredBoosting) this.stopBoost('switch_favorite');
    this.state.boostMode = 'favorite';
    this.state.activeFavoriteAppId = id;
    this.state.desiredBoosting = true;
    this.state.currentGameIndex = 0;
    this.#applyGames();
    this.#rememberBootBoostPlan('favorite', id);
    this.#rememberRuntimeBoost({ running: true, mode: 'favorite', favoriteAppId: id });
    this.recordChange('boost_started', { mode: 'favorite', favoriteAppId: id });
  }

  #buildGamePayload(game) {
    const settings = this.store.get().settings;
    if (settings.customTitleEnabled && settings.customTitle) {
      return { game_id: Number(game.appid), game_extra_info: settings.customTitle };
    }
    return Number(game.appid);
  }

  #activeGamesFromState(stored = this.store.get()) {
    if (this.state.boostMode === 'favorite') {
      const favorite = stored.favorites.find((game) => Number(game.appid) === Number(this.state.activeFavoriteAppId));
      return favorite ? [favorite] : [];
    }
    if (this.state.boostMode === 'games') return stored.games;
    return [];
  }

  #applyGames() {
    if (!this.state.desiredBoosting || this.state.connection !== 'online') return;
    if (this.state.blockedByOtherSession) {
      this.#pauseTracking(Date.now());
      this.state.boosting = false;
      this.state.message = 'Stai giocando davvero. Boost in pausa e pronto a ripartire.';
      return;
    }
    const stored = this.store.get();
    const games = this.#activeGamesFromState(stored);
    if (!games.length) {
      this.stopBoost('empty_selection');
      return;
    }

    clearTimeout(this.autoStopTimer);
    clearInterval(this.rotationTimer);
    this.autoStopTimer = null;
    this.rotationTimer = null;

    try {
      const rotate = this.state.boostMode === 'games' && stored.settings.cardFarmer;
      this.#beginSessionIfNeeded(games);
      if (rotate) {
        const index = this.state.currentGameIndex % games.length;
        const current = games[index];
        this.client.gamesPlayed([this.#buildGamePayload(current)]);
        this.#setTrackedGames([current]);
        this.rotationTimer = setInterval(() => {
          if (!this.state.desiredBoosting || this.state.connection !== 'online' || this.state.boostMode !== 'games') return;
          this.state.currentGameIndex = (this.state.currentGameIndex + 1) % games.length;
          const next = games[this.state.currentGameIndex];
          this.client.gamesPlayed([this.#buildGamePayload(next)]);
          this.#setTrackedGames([next]);
        }, Math.max(5, Number(stored.settings.cardCycleMinutes) || 120) * 60 * 1000);
        this.rotationTimer.unref();
      } else {
        this.client.gamesPlayed(games.slice(0, 32).map((game) => this.#buildGamePayload(game)));
        this.#setTrackedGames(games.slice(0, 32));
      }

      this.state.startedAt = this.sessionStart;
      this.state.boosting = true;
      this.state.message = this.state.boostMode === 'favorite'
        ? `Preferito attivo: ${games[0].name}`
        : (rotate ? 'Boost multiplo in rotazione' : 'Boost multiplo attivo');

      if (stored.settings.autoStopEnabled) {
        const hours = Math.max(0.05, Number(stored.settings.autoStopHours) || 1);
        this.autoStopTimer = setTimeout(() => this.stopBoost('auto_stop'), hours * 60 * 60 * 1000);
        this.autoStopTimer.unref();
      }
    } catch (error) {
      this.#pauseTracking(Date.now());
      this.state.boosting = false;
      this.state.lastError = error.message;
      this.state.message = error.message;
      throw error;
    }
  }

  stopBoost(reason = 'manual') {
    const previousMode = this.state.boostMode;
    const previousFavoriteAppId = Number(this.state.activeFavoriteAppId || 0);
    const wasRunning = Boolean(this.state.boosting || this.state.desiredBoosting || this.sessionStart);
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    clearTimeout(this.autoStopTimer);
    clearInterval(this.rotationTimer);
    this.autoStopTimer = null;
    this.rotationTimer = null;
    this.state.desiredBoosting = false;
    if (this.state.connection === 'online') {
      try { this.client.gamesPlayed([]); } catch (_error) {}
    }

    if (this.sessionStart) {
      const end = Date.now();
      this.#pauseTracking(end);
      const finalSession = this.#sessionFromSnapshot(this.#snapshot(end), end, reason, false);
      this.store.update((draft) => {
        if (finalSession.seconds > 0) recordSession(draft.stats, finalSession);
        draft.stats.activeSession = null;
      });
    }

    this.#clearSessionMemory();
    this.state.startedAt = null;
    this.state.boosting = false;
    this.state.boostMode = 'none';
    this.state.activeFavoriteAppId = 0;
    this.state.message = 'Boost fermato';
    if (wasRunning) {
      this.#rememberRuntimeBoost({ running: false, mode: previousMode, favoriteAppId: previousFavoriteAppId, reason });
      this.recordChange('boost_stopped', { reason, mode: previousMode, favoriteAppId: previousFavoriteAppId });
    }
  }

  getHistory() {
    const stored = this.store.get();
    return historySnapshot(stored.stats, this.#buildActiveSession(Date.now()));
  }

  shutdownGracefully(reason = 'service_stop') {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopBoost(reason);
    try { this.client.logOff(); } catch (_error) {}
    this.state.connection = 'offline';
    this.state.message = 'Servizio PiBoost arrestato';
  }

  getPublicState() {
    const stored = this.store.get();
    const activeSession = this.#buildActiveSession(Date.now());
    const activeSeconds = activeSession ? activeSession.seconds : 0;
    const activeGames = this.#activeGamesFromState(stored).map((game) => ({ ...game }));
    return {
      accountId: this.accountId,
      ...this.state,
      hasRefreshToken: this.vault.has(this.tokenKey),
      activeSeconds,
      totalSeconds: stored.stats.totalSeconds + activeSeconds,
      profile: stored.profile,
      games: stored.games,
      favorites: stored.favorites,
      activeGames,
      settings: stored.settings,
      boostMemory: stored.boostMemory || {},
      lastModifiedAt: stored.metadata && stored.metadata.updatedAt,
      recentChanges: Array.isArray(stored.changeLog) ? stored.changeLog.slice(0, 10) : [],
      recentSessions: stored.stats.sessions.slice(0, 10),
      historySummary: {
        sessions: stored.stats.sessions.length + (activeSession ? 1 : 0),
        uniqueGames: Object.keys(stored.stats.gameTotals || {}).length
      }
    };
  }

}

module.exports = { SteamAccount };
