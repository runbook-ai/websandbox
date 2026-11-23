#!/usr/bin/env bash
# Container start (run by the image's bootstrap after the repo checkout):
#   1. npm install where the lockfiles changed (node_modules live in the volume)
#   2. sync the data from Hugging Face (deploy/sync-data.py: changed files only, SHA256SUMS, tars)
#   3. start every site with data on 127.0.0.1 (tasks/tools/sites.sh, 1 tenant, control token)
#   4. exec the front router (deploy/router.js) on :8080 -- landing page + Host routing + hourly reset
set -euo pipefail
ROOT=${WSB_ROOT:-/srv}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DATA=$ROOT/data
STATE=$ROOT/state
BASE=${WSB_BASE_PORT:-7700}
mkdir -p "$DATA" "$STATE"
log() { echo "[start $(date -u +%H:%M:%S)] $*"; }

# ---- control token (never printed): generated once, kept in the volume
TOKEN_FILE=$STATE/control-token
if [ ! -s "$TOKEN_FILE" ]; then
  (umask 077; node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))" >"$TOKEN_FILE")
  log "generated a new control token in $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

# ---- npm install only when package.json / package-lock.json (or the node version) changed
for d in kit sites/forum sites/code sites/wiki sites/map; do
  [ -f "$REPO/$d/package.json" ] || continue
  want=$( (node -v; cat "$REPO/$d/package.json" "$REPO/$d/package-lock.json" 2>/dev/null) | sha256sum | cut -c1-16)
  stamp=$REPO/$d/node_modules/.wsb-deps
  if [ -d "$REPO/$d/node_modules" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then continue; fi
  log "npm ci in $d"
  (cd "$REPO/$d" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  echo "$want" >"$stamp"
done

# ---- data from Hugging Face
python3 "$REPO/deploy/sync-data.py" --data "$DATA" --repo "${WSB_HF_REPO:-junfengzhou/websandbox}" --revision "${WSB_HF_REV:-main}"

# ---- sites (1 tenant, 1 worker each; ports BASE + 10k on 127.0.0.1)
export WSB_SITES_STATE=$STATE/sites
export WSB_MAP_ROUTE_WORKERS=${WSB_MAP_ROUTE_WORKERS:-1} WSB_MAP_GEO_WORKERS=${WSB_MAP_GEO_WORKERS:-2}
export WSB_WIKI_CACHE_MB=${WSB_WIKI_CACHE_MB:-96}
mkdir -p "$WSB_SITES_STATE"; rm -f "$WSB_SITES_STATE"/*.pid      # pids of a previous container are meaningless
rm -rf /dev/shm/wsb-*
log "starting sites"
bash "$REPO/tasks/tools/sites.sh" up --bind ports --base "$BASE" --tenants 1 --workers 1 \
  --data-root "$DATA" --control-token "$(cat "$TOKEN_FILE")" --timeout 1200

log "starting router on :${WSB_PORT:-8080}"
export WSB_CONTROL_TOKEN_FILE=$TOKEN_FILE WSB_BASE_PORT=$BASE WSB_SITES_STATE WSB_DATA_ROOT=$DATA
export WSB_COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
exec node "$REPO/deploy/router.js"
