#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo "Esegui con sudo: sudo ./scripts/uninstall.sh"
  exit 1
fi
systemctl disable --now piboost 2>/dev/null || true
rm -f /etc/systemd/system/piboost.service
systemctl daemon-reload
rm -rf /opt/piboost
echo "PiBoost rimosso."
