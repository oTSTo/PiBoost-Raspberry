#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo "Esegui: sudo ./CONFIGURA-OWNER.sh 7656119..."
  exit 1
fi
STEAM_ID="${1:-}"
if [[ ! "$STEAM_ID" =~ ^[0-9]{17}$ ]]; then
  echo "SteamID64 non valido. Deve contenere esattamente 17 cifre."
  exit 1
fi
ENV_FILE="/opt/piboost/.env"
PASSKEY_FILE="/opt/piboost/data/owner-passkeys.json"
BACKUP_DIR="/opt/piboost-backups"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "PiBoost non installato in /opt/piboost."
  exit 1
fi
OLD_ID="$(grep '^OWNER_STEAM_ID64=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
if grep -q '^OWNER_STEAM_ID64=' "$ENV_FILE"; then
  sed -i "s/^OWNER_STEAM_ID64=.*/OWNER_STEAM_ID64=$STEAM_ID/" "$ENV_FILE"
else
  printf '\nOWNER_STEAM_ID64=%s\n' "$STEAM_ID" >> "$ENV_FILE"
fi
if [[ "$OLD_ID" != "$STEAM_ID" && -f "$PASSKEY_FILE" ]]; then
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp "$PASSKEY_FILE" "$BACKUP_DIR/owner-passkeys-before-owner-change-$STAMP.json"
  chmod 600 "$BACKUP_DIR/owner-passkeys-before-owner-change-$STAMP.json"
  rm -f "$PASSKEY_FILE"
  echo "Passkey del vecchio owner azzerate."
fi
chmod 600 "$ENV_FILE"
systemctl restart piboost
sleep 4
curl -fsS http://127.0.0.1:3000/api/health
echo
echo "Owner impostato e PiBoost riavviato. Registra la passkey dal sito se richiesto."
