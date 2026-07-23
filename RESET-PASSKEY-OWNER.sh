#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo "Esegui: sudo ./RESET-PASSKEY-OWNER.sh"
  exit 1
fi
FILE="/opt/piboost/data/owner-passkeys.json"
BACKUP_DIR="/opt/piboost-backups"
mkdir -p "$BACKUP_DIR"
if [[ -f "$FILE" ]]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp "$FILE" "$BACKUP_DIR/owner-passkeys-$STAMP.json"
  chmod 600 "$BACKUP_DIR/owner-passkeys-$STAMP.json"
  rm -f "$FILE"
  echo "Backup della vecchia passkey: $BACKUP_DIR/owner-passkeys-$STAMP.json"
else
  echo "Nessuna passkey owner registrata."
fi
systemctl restart piboost
sleep 4
curl -fsS http://127.0.0.1:3000/api/health || true
echo
ORIGIN="$(grep '^OWNER_PASSKEY_ORIGINS=' /opt/piboost/.env 2>/dev/null | cut -d= -f2- | cut -d, -f1 || true)"
echo "Passkey owner azzerate. Accedi da ${ORIGIN:-dal dominio HTTPS configurato}/steamboost/ e registrane una nuova."
