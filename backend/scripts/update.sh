#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Esegui con sudo: sudo ./AGGIORNA.sh"
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${PIBOOST_INSTALL_DIR:-/opt/piboost}"
BACKUP_DIR="${PIBOOST_BACKUP_DIR:-/opt/piboost-backups}"
RUN_USER="${PIBOOST_USER:-${SUDO_USER:-ubuntu}}"
RUN_GROUP="$(id -gn "$RUN_USER")"

if [[ "$SOURCE_DIR" == "$INSTALL_DIR" ]]; then
  echo "Esegui AGGIORNA.sh dalla nuova cartella clonata/estratta, non da /opt/piboost."
  exit 1
fi
if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "Installazione esistente non trovata: avvio INSTALLA.sh."
  exec "$SOURCE_DIR/scripts/install.sh"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js e npm non sono installati."
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  echo "Serve Node.js 20 o superiore. Versione attuale: $(node -v)"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
SUCCESS=0
cleanup() {
  if [[ "$SUCCESS" -ne 1 && -d "$TMP_DIR/data" && ! -d "$INSTALL_DIR/data" ]]; then
    mkdir -p "$INSTALL_DIR"
    mv "$TMP_DIR/data" "$INSTALL_DIR/data" || true
    chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR/data" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/piboost-pre-4.1.0-$STAMP.tar.gz"
tar -czf "$BACKUP_FILE" -C "$INSTALL_DIR" data .env 2>/dev/null || true
chmod 600 "$BACKUP_FILE" 2>/dev/null || true
echo "Backup creato: $BACKUP_FILE"

systemctl stop piboost 2>/dev/null || true
[[ -d "$INSTALL_DIR/data" ]] && mv "$INSTALL_DIR/data" "$TMP_DIR/data"
[[ -f "$INSTALL_DIR/.env" ]] && cp "$INSTALL_DIR/.env" "$TMP_DIR/old.env"

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"
[[ -d "$TMP_DIR/data" ]] && mv "$TMP_DIR/data" "$INSTALL_DIR/data" || mkdir -p "$INSTALL_DIR/data"
[[ -f "$TMP_DIR/old.env" ]] && cp "$TMP_DIR/old.env" "$INSTALL_DIR/.env" || touch "$INSTALL_DIR/.env"

ensure_missing_env() {
  local key="$1" value="$2" file="$INSTALL_DIR/.env"
  grep -q "^${key}=" "$file" || printf '%s=%s\n' "$key" "$value" >> "$file"
}

MASTER_KEY="$(grep '^MASTER_KEY=' "$INSTALL_DIR/.env" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
[[ -n "$MASTER_KEY" ]] || MASTER_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"
ensure_missing_env PORT 3000
ensure_missing_env BIND_HOST 0.0.0.0
ensure_missing_env BASE_PATH /steamboost
ensure_missing_env MASTER_KEY "$MASTER_KEY"
ensure_missing_env DATA_DIR "$INSTALL_DIR/data"
ensure_missing_env SESSION_DAYS 90
ensure_missing_env MAX_ACCOUNTS 20
ensure_missing_env OWNER_STEAM_ID64 ""
ensure_missing_env OWNER_IDLE_MINUTES 30
ensure_missing_env OWNER_SESSION_HOURS 8
ensure_missing_env OWNER_ALLOWED_ORIGINS "http://localhost:3000"
ensure_missing_env OWNER_RP_ID "localhost"
ensure_missing_env OWNER_RP_NAME "PiBoost Owner Admin"
ensure_missing_env OWNER_PASSKEY_ORIGINS "http://localhost:3000"
ensure_missing_env OWNER_PASSKEY_CHALLENGE_MINUTES 5
ensure_missing_env FRAME_ANCESTORS "\"'self'\""

cd "$INSTALL_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund --progress=false
else
  npm install --omit=dev --registry=https://registry.npmjs.org --no-audit --no-fund --progress=false
fi
npm run check
chown -R "$RUN_USER:$RUN_GROUP" "$INSTALL_DIR"
chmod 600 .env
chmod 700 data

cat > /etc/systemd/system/piboost.service <<SERVICE
[Unit]
Description=PiBoost Raspberry
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
ExecStart=$(command -v node) $INSTALL_DIR/src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now piboost
sleep 5
systemctl --no-pager --full status piboost || true
curl -fsS http://127.0.0.1:3000/api/health || true
echo
SUCCESS=1

echo "Aggiornamento a PiBoost 4.1.0 completato."
echo "Conservati: .env, account, token cifrati, giochi, preferiti, impostazioni, ore, date, storico e passkey."
echo "Backup: $BACKUP_FILE"
