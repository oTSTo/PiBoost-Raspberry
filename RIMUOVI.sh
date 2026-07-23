#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x /opt/piboost/scripts/uninstall.sh ]]; then
  exec /opt/piboost/scripts/uninstall.sh
fi
exec "$HERE/backend/scripts/uninstall.sh"
