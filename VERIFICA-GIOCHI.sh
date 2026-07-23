#!/usr/bin/env bash
set -euo pipefail
DATA_DIR="/opt/piboost/data/accounts"
if [[ ! -d "$DATA_DIR" ]]; then
  echo "Nessun archivio account trovato in $DATA_DIR"
  exit 1
fi
node - "$DATA_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
let found = 0;
for (const entry of dirs) {
  const file = path.join(root, entry.name, 'state.json');
  if (!fs.existsSync(file)) continue;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const games = Array.isArray(state.games) ? state.games : [];
  const memory = state.boostMemory || {};
  console.log(`\nAccount: ${state.profile?.personaName || state.profile?.accountName || entry.name}`);
  console.log(`SteamID64: ${state.profile?.steamId64 || 'non disponibile'}`);
  console.log(`Giochi salvati: ${games.length}`);
  for (const game of games) console.log(`  - ${game.name || `App ${game.appid}`} (AppID ${game.appid})`);
  console.log(`Ultimo piano boost: ${memory.mode || 'none'} · ${Array.isArray(memory.gameAppIds) ? memory.gameAppIds.join(', ') || 'nessuno' : 'nessuno'}`);
  found++;
}
if (!found) console.log('Nessuno state.json trovato.');
NODE
