'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

class PersistentSessionStore {
  constructor(dataDir, days = 90) {
    this.file = path.join(dataDir, 'browser-sessions.json');
    this.lifetimeMs = Math.max(1, Number(days) || 90) * 24 * 60 * 60 * 1000;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.sessions = this.#load();
    this.prune();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  #save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.sessions, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  issue(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions[hashToken(token)] = {
      accountId,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + this.lifetimeMs
    };
    this.#save();
    return token;
  }

  resolve(token) {
    if (!token) return null;
    const key = hashToken(token);
    const entry = this.sessions[key];
    if (!entry) return null;
    if (!entry.expiresAt || entry.expiresAt < Date.now()) {
      delete this.sessions[key];
      this.#save();
      return null;
    }
    return entry.accountId || null;
  }

  revoke(token) {
    if (!token) return;
    delete this.sessions[hashToken(token)];
    this.#save();
  }

  revokeAccount(accountId) {
    let changed = false;
    for (const [key, entry] of Object.entries(this.sessions)) {
      if (entry.accountId === accountId) {
        delete this.sessions[key];
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of Object.entries(this.sessions)) {
      if (!entry || !entry.expiresAt || entry.expiresAt < now) {
        delete this.sessions[key];
        changed = true;
      }
    }
    if (changed) this.#save();
  }
}

module.exports = { PersistentSessionStore };
