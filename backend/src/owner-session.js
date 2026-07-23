'use strict';

const crypto = require('crypto');

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

class OwnerSessionStore {
  constructor({ idleMinutes = 30, absoluteHours = 8, maxPerAccount = 3 } = {}) {
    this.maxPerAccount = Math.max(1, Number(maxPerAccount) || 3);
    this.idleMs = Math.max(5, Number(idleMinutes) || 30) * 60 * 1000;
    this.absoluteMs = Math.max(1, Number(absoluteHours) || 8) * 60 * 60 * 1000;
    this.sessions = new Map();
  }

  issue({ accountId, steamId64 }) {
    const normalizedAccountId = String(accountId || '');
    const existing = [...this.sessions.entries()]
      .filter(([, session]) => session.accountId === normalizedAccountId)
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (existing.length >= this.maxPerAccount) {
      const [oldestKey] = existing.shift();
      this.sessions.delete(oldestKey);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    const session = {
      accountId: normalizedAccountId,
      steamId64: String(steamId64 || ''),
      csrfHash: hash(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.absoluteMs,
      idleExpiresAt: now + this.idleMs
    };
    this.sessions.set(hash(token), session);
    return {
      token,
      csrfToken,
      expiresAt: new Date(Math.min(session.absoluteExpiresAt, session.idleExpiresAt)).toISOString()
    };
  }

  resolve(token, { touch = true } = {}) {
    const key = hash(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    const now = Date.now();
    if (session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) {
      this.sessions.delete(key);
      return null;
    }
    if (touch) {
      session.lastSeenAt = now;
      session.idleExpiresAt = Math.min(session.absoluteExpiresAt, now + this.idleMs);
    }
    return { ...session };
  }

  rotateCsrf(token) {
    const key = hash(token);
    const session = this.sessions.get(key);
    if (!session || !this.resolve(token, { touch: false })) return '';
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    session.csrfHash = hash(csrfToken);
    return csrfToken;
  }

  verifyCsrf(token, csrfToken) {
    const session = this.resolve(token, { touch: false });
    if (!session || !csrfToken) return false;
    const actual = Buffer.from(hash(csrfToken));
    const expected = Buffer.from(session.csrfHash);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  revoke(token) {
    this.sessions.delete(hash(token));
  }

  revokeAccount(accountId) {
    const wanted = String(accountId || '');
    for (const [key, session] of this.sessions.entries()) {
      if (session.accountId === wanted) this.sessions.delete(key);
    }
  }

  prune() {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) this.sessions.delete(key);
    }
  }
}

module.exports = { OwnerSessionStore };
