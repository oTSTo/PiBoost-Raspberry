'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function encodeBytes(value) {
  return Buffer.from(value || []).toString('base64url');
}

function decodeBytes(value) {
  return new Uint8Array(Buffer.from(String(value || ''), 'base64url'));
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class PasskeyStore {
  constructor(dataDir, {
    ownerSteamId64,
    rpID = 'localhost',
    rpName = 'PiBoost Owner Admin',
    origins = ['http://localhost:3000'],
    challengeMinutes = 5
  } = {}) {
    this.file = path.join(dataDir, 'owner-passkeys.json');
    this.ownerSteamId64 = String(ownerSteamId64 || '');
    this.rpID = String(rpID || 'localhost');
    this.rpName = String(rpName || 'PiBoost Owner Admin');
    this.origins = [...new Set((origins || []).map((item) => String(item).replace(/\/$/, '')).filter(Boolean))];
    this.challengeMs = Math.max(1, Number(challengeMinutes) || 5) * 60_000;
    this.registrationChallenges = new Map();
    this.authenticationChallenges = new Map();
    this.data = this.load();
    this.modulePromise = null;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const sameOwner = !parsed.ownerSteamId64 || String(parsed.ownerSteamId64) === this.ownerSteamId64;
      return {
        version: 1,
        ownerSteamId64: this.ownerSteamId64,
        credentials: sameOwner && Array.isArray(parsed.credentials) ? parsed.credentials.filter((item) => item && item.id && item.publicKey) : [],
        updatedAt: parsed.updatedAt || new Date().toISOString()
      };
    } catch (_error) {
      return { version: 1, ownerSteamId64: this.ownerSteamId64, credentials: [], updatedAt: new Date().toISOString() };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.data.ownerSteamId64 = this.ownerSteamId64;
    this.data.updatedAt = new Date().toISOString();
    atomicWrite(this.file, this.data);
  }

  async webauthn() {
    if (!this.modulePromise) this.modulePromise = import('@simplewebauthn/server');
    return this.modulePromise;
  }

  configured() {
    return this.data.credentials.length > 0;
  }

  publicStatus() {
    return {
      configured: this.configured(),
      count: this.data.credentials.length,
      rpID: this.rpID,
      rpName: this.rpName,
      origins: [...this.origins],
      credentials: this.data.credentials.map((item) => ({
        id: item.id,
        label: item.label || 'Passkey owner',
        createdAt: item.createdAt || null,
        lastUsedAt: item.lastUsedAt || null,
        deviceType: item.deviceType || null,
        backedUp: Boolean(item.backedUp),
        transports: Array.isArray(item.transports) ? item.transports : []
      }))
    };
  }

  challengeKey(accountId) {
    return String(accountId || this.ownerSteamId64 || 'owner');
  }

  setChallenge(map, accountId, challenge) {
    map.set(this.challengeKey(accountId), { challenge, expiresAt: Date.now() + this.challengeMs });
  }

  takeChallenge(map, accountId) {
    const key = this.challengeKey(accountId);
    const item = map.get(key);
    map.delete(key);
    if (!item || item.expiresAt <= Date.now()) return '';
    return item.challenge;
  }

  prune() {
    const now = Date.now();
    for (const map of [this.registrationChallenges, this.authenticationChallenges]) {
      for (const [key, item] of map.entries()) if (!item || item.expiresAt <= now) map.delete(key);
    }
  }

  async registrationOptions({ accountId, personaName }) {
    if (this.configured()) throw new Error('Una passkey owner è già configurata. Aggiungine altre dal pannello amministrativo.');
    const { generateRegistrationOptions } = await this.webauthn();
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: new Uint8Array(Buffer.from(this.ownerSteamId64, 'utf8')),
      userName: this.ownerSteamId64,
      userDisplayName: String(personaName || 'PiBoost Owner'),
      attestationType: 'none',
      excludeCredentials: this.data.credentials.map((credential) => ({ id: credential.id, transports: credential.transports || [] })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required'
      },
      supportedAlgorithmIDs: [-7, -257],
      timeout: 60_000
    });
    this.setChallenge(this.registrationChallenges, accountId, options.challenge);
    return options;
  }

  async verifyRegistration({ accountId, response, label = 'Passkey owner' }) {
    if (this.configured()) throw new Error('La passkey owner iniziale è già configurata.');
    const challenge = this.takeChallenge(this.registrationChallenges, accountId);
    if (!challenge) throw new Error('La richiesta di registrazione è scaduta. Riprova.');
    const { verifyRegistrationResponse } = await this.webauthn();
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origins,
      expectedRPID: this.rpID,
      requireUserVerification: true
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error('Registrazione della passkey non verificata.');
    const info = verification.registrationInfo;
    const credential = info.credential;
    if (!credential || !credential.id || !credential.publicKey) throw new Error('La passkey non contiene i dati necessari.');
    this.data.credentials.push({
      id: credential.id,
      publicKey: encodeBytes(credential.publicKey),
      counter: Number(credential.counter || 0),
      transports: Array.isArray(credential.transports) ? credential.transports : (Array.isArray(response.response && response.response.transports) ? response.response.transports : []),
      label: String(label || 'Passkey owner').slice(0, 80),
      deviceType: info.credentialDeviceType || null,
      backedUp: Boolean(info.credentialBackedUp),
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    });
    this.save();
    return this.publicStatus();
  }

  async authenticationOptions({ accountId }) {
    if (!this.configured()) throw new Error('Nessuna passkey owner configurata.');
    const { generateAuthenticationOptions } = await this.webauthn();
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: this.data.credentials.map((credential) => ({ id: credential.id, transports: credential.transports || [] })),
      userVerification: 'required',
      timeout: 60_000
    });
    this.setChallenge(this.authenticationChallenges, accountId, options.challenge);
    return options;
  }

  async verifyAuthentication({ accountId, response }) {
    const challenge = this.takeChallenge(this.authenticationChallenges, accountId);
    if (!challenge) throw new Error('La richiesta di autenticazione è scaduta. Riprova.');
    const credential = this.data.credentials.find((item) => item.id === String(response && response.id || ''));
    if (!credential) throw new Error('Passkey non riconosciuta.');
    const { verifyAuthenticationResponse } = await this.webauthn();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origins,
      expectedRPID: this.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: decodeBytes(credential.publicKey),
        counter: Number(credential.counter || 0),
        transports: credential.transports || []
      }
    });
    if (!verification.verified || !verification.authenticationInfo) throw new Error('Autenticazione con passkey non verificata.');
    credential.counter = Number(verification.authenticationInfo.newCounter || credential.counter || 0);
    credential.lastUsedAt = new Date().toISOString();
    this.save();
    return this.publicStatus();
  }

  resetAll() {
    this.data.credentials = [];
    this.registrationChallenges.clear();
    this.authenticationChallenges.clear();
    this.save();
  }
}

module.exports = { PasskeyStore };
