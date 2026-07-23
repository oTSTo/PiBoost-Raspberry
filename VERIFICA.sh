#!/usr/bin/env bash
set -euo pipefail
echo "===== SERVIZIO ====="
systemctl --no-pager --full status piboost || true
echo
echo "===== HEALTH ====="
curl -fsS http://127.0.0.1:3000/api/health || true
echo
echo "===== OWNER ====="
if [[ -f /opt/piboost/.env ]]; then
  OWNER="$(grep '^OWNER_STEAM_ID64=' /opt/piboost/.env | cut -d= -f2- || true)"
  RP_ID="$(grep '^OWNER_RP_ID=' /opt/piboost/.env | cut -d= -f2- || true)"
  if [[ "$OWNER" =~ ^[0-9]{16,20}$ ]]; then
    echo "OWNER_STEAM_ID64 configurato: ${OWNER:0:6}********${OWNER: -4}"
  else
    echo "OWNER_STEAM_ID64 mancante o non valido."
  fi
  echo "OWNER_RP_ID: ${RP_ID:-non configurato}"
else
  echo "/opt/piboost/.env non trovato."
fi
echo
echo "===== PASSKEY ====="
if [[ -f /opt/piboost/data/owner-passkeys.json ]]; then
  node - <<'NODE'
const fs = require('fs');
try {
  const data = JSON.parse(fs.readFileSync('/opt/piboost/data/owner-passkeys.json', 'utf8'));
  console.log(`Passkey registrate: ${Array.isArray(data.credentials) ? data.credentials.length : 0}`);
} catch (error) {
  console.log(`File passkey non leggibile: ${error.message}`);
}
NODE
else
  echo "Nessuna passkey owner registrata. Verrà richiesta al primo accesso admin."
fi
echo
echo "===== BACKUP ====="
ls -1t /opt/piboost-backups/piboost-*.tar.gz 2>/dev/null | head -n 3 || echo "Nessun backup trovato."
