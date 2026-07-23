'use strict';

const fs = require('fs');
const path = require('path');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class AccountRegistry {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'accounts.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.data = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        version: 1,
        accounts: parsed && parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {}
      };
    } catch (_error) {
      const initial = { version: 1, accounts: {} };
      this.#save(initial);
      return initial;
    }
  }

  #save(data = this.data) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  list() {
    return Object.values(this.data.accounts).map(clone);
  }

  get(accountId) {
    const value = this.data.accounts[accountId];
    return value ? clone(value) : null;
  }

  upsert(accountId, patch = {}) {
    const now = new Date().toISOString();
    const current = this.data.accounts[accountId] || {
      id: accountId,
      accountName: '',
      steamId64: '',
      personaName: '',
      avatar: '',
      createdAt: now,
      updatedAt: now
    };
    const next = {
      ...current,
      ...patch,
      id: accountId,
      updatedAt: now
    };
    this.data.accounts[accountId] = next;
    this.#save();
    return clone(next);
  }

  remove(accountId) {
    delete this.data.accounts[accountId];
    this.#save();
  }
}

module.exports = { AccountRegistry };
