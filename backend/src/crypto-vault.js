'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CryptoVault {
  constructor(dataDir, keyBase64) {
    this.file = path.join(dataDir, 'secrets.json');
    this.key = Buffer.from(keyBase64 || '', 'base64');
    if (this.key.length !== 32) {
      throw new Error('MASTER_KEY deve essere una chiave Base64 da 32 byte. Esegui install.sh.');
    }
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.data = this.#load();
  }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_error) {
      return {};
    }
  }

  #save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  #encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64')
    };
  }

  #decrypt(payload) {
    if (!payload || payload.v !== 1) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final()
    ]);
    return clear.toString('utf8');
  }

  set(name, value) {
    if (value === null || value === undefined || value === '') {
      delete this.data[name];
    } else {
      this.data[name] = this.#encrypt(value);
    }
    this.#save();
  }

  get(name) {
    try {
      return this.#decrypt(this.data[name]);
    } catch (_error) {
      return null;
    }
  }

  has(name) {
    return Boolean(this.data[name]);
  }

  remove(name) {
    delete this.data[name];
    this.#save();
  }
}

module.exports = { CryptoVault };
