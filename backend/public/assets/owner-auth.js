'use strict';

const pagePath = window.location.pathname.replace(/\/owner-auth\/?$/, '');
const basePath = pagePath || '/steamboost';
const apiBase = `${basePath}/api`;
const token = localStorage.getItem('piboostToken') || '';
const state = { configured: false, busy: false, status: null, redirectUrl: '' };
const $ = (id) => document.getElementById(id);

function setNotice(message, type = '') {
  const box = $('ownerAuthNotice');
  box.textContent = message;
  box.className = `notice${type ? ` ${type}` : ''}`;
}

function setBusy(busy) {
  state.busy = busy;
  $('passkeyBtn').disabled = busy || !state.status;
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    },
    credentials: 'same-origin'
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    localStorage.removeItem('piboostToken');
    window.location.replace(`${basePath}/`);
    throw new Error('Sessione Steam scaduta.');
  }
  if (response.status === 403) {
    window.location.replace(`${basePath}/`);
    throw new Error('Account non autorizzato.');
  }
  if (!response.ok) throw new Error(body.error || `Errore HTTP ${response.status}`);
  return body;
}

function fromBase64url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64url(value) {
  const bytes = new Uint8Array(value || new ArrayBuffer(0));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function registrationOptions(options) {
  return {
    ...options,
    challenge: fromBase64url(options.challenge),
    user: { ...options.user, id: fromBase64url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: fromBase64url(item.id) }))
  };
}

function authenticationOptions(options) {
  return {
    ...options,
    challenge: fromBase64url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: fromBase64url(item.id) }))
  };
}

function commonCredential(credential) {
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {}
  };
}

function registrationCredential(credential) {
  const transports = credential.response.getTransports ? credential.response.getTransports() : [];
  return {
    ...commonCredential(credential),
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      attestationObject: toBase64url(credential.response.attestationObject),
      transports,
      publicKeyAlgorithm: credential.response.getPublicKeyAlgorithm ? credential.response.getPublicKeyAlgorithm() : undefined,
      publicKey: credential.response.getPublicKey && credential.response.getPublicKey() ? toBase64url(credential.response.getPublicKey()) : undefined,
      authenticatorData: credential.response.getAuthenticatorData ? toBase64url(credential.response.getAuthenticatorData()) : undefined
    }
  };
}

function authenticationCredential(credential) {
  return {
    ...commonCredential(credential),
    response: {
      clientDataJSON: toBase64url(credential.response.clientDataJSON),
      authenticatorData: toBase64url(credential.response.authenticatorData),
      signature: toBase64url(credential.response.signature),
      userHandle: credential.response.userHandle ? toBase64url(credential.response.userHandle) : undefined
    }
  };
}

function friendlyError(error) {
  if (!error) return 'Operazione non riuscita.';
  if (error.name === 'NotAllowedError') return 'Operazione annullata o scaduta. Premi il pulsante e riprova.';
  if (error.name === 'InvalidStateError') return 'Questa passkey è già registrata sul dispositivo.';
  if (error.name === 'SecurityError') return 'La passkey richiede HTTPS e uno dei domini autorizzati nella configurazione owner.';
  return error.message || 'Operazione non riuscita.';
}

async function registerPasskey() {
  const options = await api('/owner/passkey/register/options', { method: 'POST', body: '{}' });
  const credential = await navigator.credentials.create({ publicKey: registrationOptions(options) });
  if (!credential) throw new Error('Nessuna passkey creata.');
  return api('/owner/passkey/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response: registrationCredential(credential), label: 'Passkey owner principale' })
  });
}

async function authenticatePasskey() {
  const options = await api('/owner/passkey/auth/options', { method: 'POST', body: '{}' });
  const credential = await navigator.credentials.get({ publicKey: authenticationOptions(options) });
  if (!credential) throw new Error('Nessuna passkey selezionata.');
  return api('/owner/passkey/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ response: authenticationCredential(credential) })
  });
}

async function continueOwner() {
  if (state.redirectUrl) { window.location.assign(state.redirectUrl); return; }
  if (state.busy) return;
  setBusy(true);
  setNotice(state.configured ? 'Conferma la passkey sul dispositivo…' : 'Registra la prima passkey owner sul dispositivo…');
  try {
    const result = state.configured ? await authenticatePasskey() : await registerPasskey();
    setNotice('Identità owner verificata. Apertura del pannello…', 'ok');
    window.location.replace(result.adminUrl || `${basePath}/admin`);
  } catch (error) {
    setNotice(friendlyError(error), 'error');
    setBusy(false);
  }
}

async function bootstrap() {
  if (!token) {
    window.location.replace(`${basePath}/`);
    return;
  }
  if (!window.PublicKeyCredential || !navigator.credentials) {
    $('steamCheck').textContent = 'Owner';
    $('passkeyCheck').textContent = 'Non supportata';
    setNotice('Questo browser non supporta le passkey. Usa Chrome, Edge, Brave o Safari aggiornato.', 'error');
    return;
  }
  try {
    const status = await api('/owner/passkey/status');
    if (status.sessionActive) {
      setNotice('Sessione owner già valida. Apertura del pannello…', 'ok');
      window.location.replace(status.adminUrl || `${basePath}/admin`);
      return;
    }
    state.status = status;
    const allowedOrigins = Array.isArray(status.origins) ? status.origins : [];
    if (allowedOrigins.length && !allowedOrigins.includes(window.location.origin)) {
      state.redirectUrl = `${allowedOrigins[0]}${basePath}/owner-auth`;
      $('steamCheck').textContent = 'Owner verificato';
      $('passkeyCheck').textContent = 'Dominio errato';
      const targetHost = new URL(allowedOrigins[0]).host;
      $('passkeyBtn').textContent = `Apri ${targetHost}`;
      $('passkeyBtn').disabled = false;
      setNotice(`Per sicurezza la passkey admin funziona solamente da ${allowedOrigins[0]}. I dati del boost restano gli stessi.`, 'error');
      return;
    }
    state.configured = Boolean(status.configured);
    $('steamCheck').textContent = 'Owner verificato';
    $('passkeyCheck').textContent = state.configured ? `${status.count} registrata` : 'Da configurare';
    $('passkeyBtn').textContent = state.configured ? 'Conferma con la passkey' : 'Registra la passkey owner';
    $('ownerAuthDescription').textContent = state.configured
      ? 'Usa la passkey registrata per aprire la console amministrativa.'
      : 'Prima configurazione: registra una passkey protetta dal dispositivo. Da questo momento sarà richiesta per ogni accesso admin.';
    setNotice(state.configured ? 'Account owner riconosciuto. Conferma la passkey per continuare.' : 'Account owner riconosciuto. Registra ora la prima passkey.', 'ok');
    setBusy(false);
  } catch (error) {
    setNotice(friendlyError(error), 'error');
  }
}

$('passkeyBtn').addEventListener('click', continueOwner);
bootstrap();
