#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Esegui: sudo ./CONFIGURA-DOMINIO.sh https://boost.example.com [https://nome.tailnet.ts.net]"
  exit 1
fi

PUBLIC_ORIGIN="${1:-}"
TAILSCALE_ORIGIN="${2:-}"
ENV_FILE="/opt/piboost/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "PiBoost non installato: manca $ENV_FILE"
  exit 1
fi

INFO="$(node -e 'try{const u=new URL(process.argv[1]);if(u.protocol!=="https:")throw new Error();process.stdout.write(`${u.origin}|${u.hostname}`)}catch{process.exit(2)}' "$PUBLIC_ORIGIN")" || {
  echo "URL non valido. Esempio: https://boost.example.com"
  exit 1
}
ORIGIN="${INFO%%|*}"
RP_ID="${INFO##*|}"
ALLOWED="$ORIGIN"
if [[ -n "$TAILSCALE_ORIGIN" ]]; then
  TAILSCALE_ORIGIN="${TAILSCALE_ORIGIN%/}"
  node -e 'const u=new URL(process.argv[1]);if(u.protocol!=="https:")process.exit(2)' "$TAILSCALE_ORIGIN" || {
    echo "URL Tailscale non valido."
    exit 1
  }
  ALLOWED="$ALLOWED,$TAILSCALE_ORIGIN"
fi

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

cp "$ENV_FILE" "$ENV_FILE.backup-$(date +%Y%m%d-%H%M%S)"
set_env OWNER_ALLOWED_ORIGINS "$ALLOWED"
set_env OWNER_RP_ID "$RP_ID"
set_env OWNER_PASSKEY_ORIGINS "$ORIGIN"
set_env FRAME_ANCESTORS "\"'self'\""
chmod 600 "$ENV_FILE"

# Una passkey WebAuthn è legata al dominio: azzerala se il dominio cambia.
if [[ -f /opt/piboost/data/owner-passkeys.json ]]; then
  mkdir -p /opt/piboost-backups
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp /opt/piboost/data/owner-passkeys.json "/opt/piboost-backups/owner-passkeys-before-domain-change-$STAMP.json"
  chmod 600 "/opt/piboost-backups/owner-passkeys-before-domain-change-$STAMP.json"
  rm -f /opt/piboost/data/owner-passkeys.json
  echo "Passkey precedenti salvate e azzerate perché il dominio è cambiato."
fi

systemctl restart piboost
sleep 4
curl -fsS http://127.0.0.1:3000/api/health
echo
echo "Dominio owner configurato: $ORIGIN"
echo "Apri: $ORIGIN/steamboost/"
