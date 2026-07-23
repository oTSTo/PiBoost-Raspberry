'use strict';

const fs = require('fs');
const path = require('path');
const { migrateStats } = require('./stats-utils');

const MAX_CHANGE_LOG = 500;
const DEFAULT_STATE = {
  version: 8,
  profile: {
    accountName: '',
    steamId64: '',
    personaName: '',
    avatar: ''
  },
  games: [],
  favorites: [],
  settings: {
    customTitleEnabled: false,
    customTitle: '',
    awayMessageEnabled: false,
    awayMessage: '[Auto] Sto usando PiBoost sul Raspberry Pi',
    persona: 'Online',
    uiMode: 'Normal',
    autoRestart: true,
    autoFriend: false,
    autoStopEnabled: false,
    autoStopHours: 8,
    cardFarmer: false,
    cardCycleMinutes: 120,
    keepBoostOnLogout: false,
    autoStartBoostOnBoot: false
  },
  bootBoost: {
    mode: 'games',
    favoriteAppId: 0,
    updatedAt: null,
    games: []
  },
  boostMemory: {
    wasRunning: false,
    mode: 'none',
    favoriteAppId: 0,
    gameAppIds: [],
    startedAt: null,
    stoppedAt: null,
    lastReason: '',
    updatedAt: null,
    games: []
  },
  metadata: {
    createdAt: null,
    updatedAt: null,
    migratedToV4At: null,
    previousStateVersion: null
  },
  changeLog: [],
  stats: {
    schemaVersion: 2,
    totalSeconds: 0,
    sessions: [],
    gameTotals: {},
    dailyTotals: {},
    activeSession: null
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : clone(defaults);
  if (defaults && typeof defaults === 'object') {
    const out = {};
    const source = value && typeof value === 'object' ? value : {};
    for (const [key, defaultValue] of Object.entries(defaults)) out[key] = mergeDefaults(source[key], defaultValue);
    for (const [key, sourceValue] of Object.entries(source)) {
      if (!(key in out)) out[key] = sourceValue;
    }
    return out;
  }
  return value === undefined ? defaults : value;
}

class JsonStore {
  constructor(dataDir, fileName = 'state.json') {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, fileName);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this.#load();
  }

  #normalize(state) {
    const previousVersion = Number(state && state.version) || 0;
    const normalized = mergeDefaults(state, DEFAULT_STATE);
    const now = new Date().toISOString();
    normalized.version = 8;
    normalized.metadata.createdAt = normalized.metadata.createdAt || now;
    normalized.metadata.updatedAt = now;
    normalized.metadata.migratedToV4At = normalized.metadata.migratedToV4At || now;
    normalized.metadata.previousStateVersion = normalized.metadata.previousStateVersion || previousVersion;
    normalized.changeLog = Array.isArray(normalized.changeLog)
      ? normalized.changeLog.slice(0, MAX_CHANGE_LOG)
      : [];
    normalized.stats = migrateStats(normalized.stats);
    return normalized;
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const merged = this.#normalize(parsed);
      this.#write(merged);
      return merged;
    } catch (_error) {
      const initial = this.#normalize(clone(DEFAULT_STATE));
      this.#write(initial);
      return initial;
    }
  }

  #write(state) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  get() {
    return clone(this.state);
  }

  update(mutator) {
    const draft = clone(this.state);
    mutator(draft);
    this.state = this.#normalize(draft);
    this.#write(this.state);
    return this.get();
  }

  recordChange(type, details = {}) {
    return this.update((draft) => {
      draft.changeLog.unshift({
        at: new Date().toISOString(),
        type: String(type || 'change').slice(0, 80),
        details: details && typeof details === 'object' ? clone(details) : { value: String(details || '') }
      });
      draft.changeLog = draft.changeLog.slice(0, MAX_CHANGE_LOG);
    });
  }
}

module.exports = { JsonStore, DEFAULT_STATE, MAX_CHANGE_LOG };
