'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_AUDIT_EVENTS = 1000;
const DEFAULTS = {
  version: 2,
  maintenance: {
    enabled: false,
    message: 'PiBoost è temporaneamente in manutenzione.',
    updatedAt: '',
    stopActiveBoosts: false
  },
  audit: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class AdminStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'admin-settings.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const state = {
        version: 2,
        maintenance: {
          ...DEFAULTS.maintenance,
          ...(raw && raw.maintenance && typeof raw.maintenance === 'object' ? raw.maintenance : {})
        },
        audit: Array.isArray(raw && raw.audit) ? raw.audit.slice(0, MAX_AUDIT_EVENTS) : []
      };
      this.#save(state);
      return state;
    } catch (_error) {
      const state = clone(DEFAULTS);
      this.#save(state);
      return state;
    }
  }

  #save(state = this.state) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  get() {
    return clone(this.state);
  }

  maintenance() {
    return clone(this.state.maintenance);
  }

  setMaintenance(input = {}) {
    this.state.maintenance = {
      enabled: Boolean(input.enabled),
      message: String(input.message || DEFAULTS.maintenance.message).trim().slice(0, 240) || DEFAULTS.maintenance.message,
      updatedAt: new Date().toISOString(),
      stopActiveBoosts: Boolean(input.stopActiveBoosts)
    };
    this.#save();
    return this.maintenance();
  }

  log(action, details = {}, context = {}) {
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      action: String(action || 'unknown').slice(0, 80),
      details: details && typeof details === 'object' ? clone(details) : { value: String(details || '') },
      ownerSteamId64: String(context.ownerSteamId64 || '').slice(0, 32),
      ip: String(context.ip || '').slice(0, 120),
      userAgent: String(context.userAgent || '').slice(0, 240)
    };
    this.state.audit.unshift(entry);
    this.state.audit = this.state.audit.slice(0, MAX_AUDIT_EVENTS);
    this.#save();
    return clone(entry);
  }

  audit(limit = 200) {
    return clone(this.state.audit.slice(0, Math.max(1, Math.min(1000, Number(limit) || 200))));
  }
}

module.exports = { AdminStore, MAX_AUDIT_EVENTS };
