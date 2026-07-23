#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Esegui con sudo: sudo ./INSTALLA.sh"
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${PIBOOST_INSTALL_DIR:-/opt/piboost}"
RUN_USER="${PIBOOST_USER:-${SUDO_USER:-ubuntu}}"
if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "Utente di servizio non valido: $RUN_USER"
  echo "Puoi specificarlo con: sudo PIBOOST_USER=nomeutente ./INSTALLA.sh"
  exit 1
fi
RUN_GROUP="$(id -gn "$RUN_USER")"

need_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "Comando mancante: $1"; exit 1; }
}
need_command node
need_command npm
need_command systemctl

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR < 20 )); then
  echo "Serve Node.js 20 o superiore. Versione attuale: $(node -v)"
  exit 1
fi

OWNER_STEAM_ID64="${OWNER_STEAM_ID64:-}"
while [[ ! "$OWNER_STEAM_ID64" =~ ^[0-9]{17}$ ]]; do
  read -r -p "SteamID64 owner (17 cifre): " OWNER_STEAM_ID64
  [[ "$OWNER_STEAM_ID64" =~ ^[0-9]{17}$ ]] || echo "SteamID64 non valido."
done

PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-}"
if [[ -z "$PUBLIC_ORIGIN" ]]; then
  read -r -p "Dominio HTTPS pubblico senza percorso (es. https://boost.example.com, vuoto per solo locale): " PUBLIC_ORIGIN
fi
PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"

TAILSCALE_ORIGIN="${TAILSCALE_ORIGIN:-}"
if [[ -z "$TAILSCALE_ORIGIN" ]]; then
  read -r -p "URL Tailscale Funnel opzionale senza percorso (Invio per saltare): " TAILSCALE_ORIGIN
fi
TAILSCALE_ORIGIN="${TAILSCALE_ORIGIN%/}"

if [[ -n "$PUBLIC_ORIGIN" ]]; then
  ORIGIN_INFO="$(node -e 'try{const u=new URL(process.argv[1]);if(u.protocol!=="https:")throw new Error();process.stdout.write(`${u.origin}|${u.hostname}`)}catch{process.exit(2)}' "$PUBLIC_ORIGIN")" || {
    echo "Dominio non valido: usa un URL HTTPS come https://boost.example.com"
    exit 1
  }
  OWNER_PRIMARY_ORIGIN="${ORIGIN_INFO%%|*}"
  OWNER_RP_ID="${ORIGIN_INFO##*|}"
else
  OWNER_PRIMARY_ORIGIN="http://localhost:3000"
  OWNER_RP_ID="localhost"
fi

OWNER_ALLOWED_ORIGINS="$OWNER_PRIMARY_ORIGIN"
if [[ -n "$TAILSCALE_ORIGIN" ]]; then
  node -e 'const u=new URL(process.argv[1]);if(u.protocol!=="https:")process.exit(2)' "$TAILSCALE_ORIGIN" || {
    echo "URL Tailscale non valido: deve iniziare con https://"
    exit 1
  }
  OWNER_ALLOWED_ORIGINS="$OWNER_ALLOWED_ORIGINS,$TAILSCALE_ORIGIN"
fi

MASTER_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")"

systemctl stop piboost 2>/dev/null || true
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"
cd "$INSTALL_DIR"

cat > .env <<ENV
PORT=3000
BIND_HOST=0.0.0.0
BASE_PATH=/steamboost
MASTER_KEY=$MASTER_KEY
DATA_DIR=$INSTALL_DIR/data
SESSION_DAYS=90
MAX_ACCOUNTS=20
OWNER_STEAM_ID64=$OWNER_STEAM_ID64
OWNER_IDLE_MINUTES=30
OWNER_SESSION_HOURS=8
OWNER_ALLOWED_ORIGINS=$OWNER_ALLOWED_ORIGINS
OWNER_RP_ID=$OWNER_RP_ID
OWNER_RP_NAME=PiBoost Owner Admin
OWNER_PASSKEY_ORIGINS=$OWNER_PRIMARY_ORIGIN
OWNER_PASSKEY_CHALLENGE_MINUTES=5
FRAME_ANCESTORS="'self'"
ENV

if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund --progress=false
else
  npm install --omit=dev --registry=https://registry.npmjs.org --no-audit --no-fund --progress=false
fi
npm run check
mkdir -p data
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

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "Installazione PiBoost 4.1.0 completata."
echo "Dashboard locale: http://${LOCAL_IP:-IP_DEL_RASPBERRY}:3000/steamboost/"
if [[ -n "$PUBLIC_ORIGIN" ]]; then
  echo "Dashboard pubblica: $PUBLIC_ORIGIN/steamboost/"
  echo "Admin owner: $PUBLIC_ORIGIN/steamboost/admin"
else
  echo "Per usare passkey e pannello owner da remoto configura un dominio HTTPS nel file $INSTALL_DIR/.env."
fi
echo "Configurazione: $INSTALL_DIR/.env"
echo "Dati persistenti: $INSTALL_DIR/data"
