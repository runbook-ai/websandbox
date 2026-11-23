#!/usr/bin/env bash
# Start / stop all websandbox sites locally with one command (cross-site task runs, RL integration).
#
#   tasks/tools/sites.sh up     [--tenants N] [--base P] [--stride S] [--only store,forum,...]
#                               [--bind ports|rl] [--port 80] [--workers W|site=W,...] [--data-root DIR]
#                               [--control-token T] [--fresh] [--timeout SEC]
#   (--workers 4,wiki=2,map=1: 4 worker processes per site, 2 for the wiki, 1 for the map)
#   tasks/tools/sites.sh down   [--base P] [--only ...]
#   tasks/tools/sites.sh status [--base P]
#   tasks/tools/sites.sh urls   [--base P] [--tenant I]     # host placeholders + grade.js --sites
#   tasks/tools/sites.sh reset  [--base P] [--tenant I|--all]
#
# Sites (in port order): store (shopping storefront + shopping_admin at /admin), forum, code
# (gitlab), wiki, map, mail. Ports, --bind ports (default): site k listens on BASE + k*STRIDE + i for
# tenant i (default BASE 7700, STRIDE 10, so store 7700.., forum 7710.., code 7720.., wiki 7730..,
# map 7740.., mail 7750..; STRIDE must be >= N). --bind rl: tenant i of site k on 127.10.<i>.<k>:PORT (default
# 80; shopping .2 + shopping_admin .3, forum .4, gitlab .5, wiki .6, map .7, mail .10, the RL hostMap
# scheme), and each site's 127.0.0.1 control listener on BASE + k*STRIDE (--loopback-port).
# Ports < 1024 need privileges (CAP_NET_BIND_SERVICE or net.ipv4.ip_unprivileged_port_start).
# Data: --data-root DIR | $WSB_DATA_ROOT (default <repo>/data), one <site>/ dir each.
# State (pids, logs) in $WSB_SITES_STATE (default ${WSB_TMP:-${TMPDIR:-/tmp}}/wsb-sites/<BASE>/). `up` waits for /__rl/health of every
# site (tenant 0), so the sites are usable when it returns; `down` kills by pid.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ALL=(store forum code wiki map mail)
declare -A IDX=([store]=0 [forum]=1 [code]=2 [wiki]=3 [map]=4 [mail]=5)
# --bind rl address byte k of 127.10.<i>.<k> = the site's siteIndex (kit SITE_INDEX)
declare -A KIDX=([store]=2 [forum]=4 [code]=5 [wiki]=6 [map]=7 [mail]=10)

cmd=${1:-help}; shift || true
tenants=1 base=7700 stride=10 only="" bind=ports port=80 workers=1 token="" fresh="" timeout=300 tenant=0 all=""
data_root=${WSB_DATA_ROOT:-$ROOT/data}
while [ $# -gt 0 ]; do
  case "$1" in
    --tenants) tenants=$2; shift 2 ;;
    --base) base=$2; shift 2 ;;
    --stride) stride=$2; shift 2 ;;
    --only) only=$2; shift 2 ;;
    --bind) bind=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --workers) workers=$2; shift 2 ;;
    --data-root) data_root=$2; shift 2 ;;
    --control-token) token=$2; shift 2 ;;
    --fresh) fresh=--fresh; shift ;;
    --timeout) timeout=$2; shift 2 ;;
    --tenant) tenant=$2; shift 2 ;;
    --all) all=1; shift ;;
    -h|--help) cmd=help; shift ;;
    *) echo "sites.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
if [ -n "$only" ]; then IFS=, read -r -a SITES <<<"$only"
else                                                             # default: every site that has data
  SITES=(); for s in "${ALL[@]}"; do if [ -d "$data_root/$s" ] || [ "$cmd" != up ]; then SITES+=("$s"); else echo "sites.sh: no $data_root/$s, skipping $s" >&2; fi; done
fi
for s in "${SITES[@]}"; do [ -n "${IDX[$s]+x}" ] || { echo "sites.sh: unknown site $s (${ALL[*]})" >&2; exit 2; }; done
STATE=${WSB_SITES_STATE:-${WSB_TMP:-${TMPDIR:-/tmp}}/wsb-sites/$base}

ctl_port() { echo $((base + ${IDX[$1]} * stride)); }           # tenant 0's port (ports) / control listener (rl)
mode() { cat "$STATE/bind" 2>/dev/null || echo "$bind"; }
ctl_url() {                                                      # site, tenant -> control API base (+ X-WSB-Tenant)
  # rl: the tenant's own address -- the 127.0.0.1 control listener lives in worker 0 only, so with
  # --workers W > 1 it serves tenants i % W == 0 alone ("tenant 1 is not served by this process")
  if [ "$(mode)" = rl ]; then tenant_url "$1" "$2"
  else echo "http://127.0.0.1:$(( $(ctl_port "$1") + $2 ))"; fi
}
tenant_url() {                                                   # site, tenant -> browser URL
  local s=$1 i=$2
  if [ "$(mode)" = rl ]; then
    local k=${KIDX[$s]}                                            # 127.10.<i>.<k>: store 2 (admin 3), forum 4, code 5, wiki 6, map 7, mail 10
    local p; p=$(cat "$STATE/port" 2>/dev/null || echo "$port")
    if [ "$p" = 80 ]; then echo "http://127.10.$i.$k"; else echo "http://127.10.$i.$k:$p"; fi
  else echo "http://127.0.0.1:$(( $(ctl_port "$s") + i ))"; fi
}
ctl() { local s=$1 i=$2; shift 2; curl -s -m 10 ${token:+-H "x-wsb-control: $token"} -H "x-wsb-tenant: $i" "$@" "$(ctl_url "$s" "$i")$CTLPATH"; }
health() { CTLPATH=/__rl/health ctl "$1" "${2:-0}" 2>/dev/null; }
alive() { [ -f "$STATE/$1.pid" ] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

case "$cmd" in
  up)
    [ "$bind" = rl ] || [ "$stride" -ge "$tenants" ] || { echo "sites.sh: --stride $stride < --tenants $tenants" >&2; exit 2; }
    mkdir -p "$STATE"; echo "$bind" >"$STATE/bind"; echo "$port" >"$STATE/port"; echo "$tenants" >"$STATE/tenants"
    for s in "${SITES[@]}"; do
      if alive "$s"; then echo "$s: already running (pid $(cat "$STATE/$s.pid"))"; continue; fi
      w=1; IFS=, read -r -a WS <<<"$workers"                     # default first, site=W overrides
      for x in "${WS[@]}"; do case "$x" in *=*) ;; *) w=$x ;; esac; done
      for x in "${WS[@]}"; do case "$x" in "$s="*) w=${x#*=} ;; esac; done
      args=(--tenants "$tenants" --data "$data_root/$s" --workers "$w" --uploads "/dev/shm/wsb-$s-$base")
      if [ "$bind" = rl ]; then args+=(--bind rl --port "$port" --loopback-port "$(ctl_port "$s")")
      else args+=(--bind ports --port "$(ctl_port "$s")"); fi
      [ -n "$token" ] && args+=(--control-token "$token")
      [ -n "$fresh" ] && args+=("$fresh")
      setsid node "$ROOT/sites/$s/server.js" "${args[@]}" >"$STATE/$s.log" 2>&1 </dev/null &
      echo $! >"$STATE/$s.pid"
      echo "$s: pid $! port $(ctl_port "$s") workers $w (log $STATE/$s.log)"
    done
    t0=$(date +%s)
    for s in "${SITES[@]}"; do
      # every tenant (each worker process serves its own share; the store/map load for seconds)
      all_ok() { local i; for ((i = 0; i < tenants; i++)); do health "$1" "$i" | grep -q '"ok":true' || return 1; done; }
      until all_ok "$s"; do
        alive "$s" || { echo "$s: exited; tail of $STATE/$s.log:" >&2; tail -20 "$STATE/$s.log" >&2; exit 1; }
        [ $(( $(date +%s) - t0 )) -lt "$timeout" ] || { echo "$s: not healthy after ${timeout}s" >&2; exit 1; }
        sleep 1
      done
      echo "$s: ok ($(( $(date +%s) - t0 ))s)"
    done ;;
  down)
    for s in "${SITES[@]}"; do
      alive "$s" || { rm -f "$STATE/$s.pid"; continue; }
      pid=$(cat "$STATE/$s.pid")
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -0 "$pid" 2>/dev/null && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
      rm -f "$STATE/$s.pid"; echo "$s: stopped (pid $pid)"
    done ;;
  status)
    for s in "${SITES[@]}"; do
      if alive "$s"; then echo "$s: pid $(cat "$STATE/$s.pid") port $(ctl_port "$s") health $(health "$s" | head -c 160)"
      else echo "$s: down"; fi
    done ;;
  urls)
    st=$(tenant_url store "$tenant"); fo=$(tenant_url forum "$tenant"); co=$(tenant_url code "$tenant")
    wi=$(tenant_url wiki "$tenant"); ma=$(tenant_url map "$tenant"); ml=$(tenant_url mail "$tenant")
    ad=$st; [ "$(mode)" = rl ] && ad=${st/127.10.$tenant.2/127.10.$tenant.3}   # shopping_admin: same process (tasks add /admin)
    echo "__SHOPPING__=$st"; echo "__SHOPPING_ADMIN__=$ad"; echo "__REDDIT__=$fo"
    echo "__GITLAB__=$co"; echo "__WIKIPEDIA__=$wi"; echo "__MAP__=$ma"; echo "__MAIL__=$ml"
    # control API base per task site name (tasks/tools/grade.js --sites), tenant via X-WSB-Tenant
    c() { ctl_url "$1" "$tenant"; }
    echo "--sites shopping=$(c store),shopping_admin=$(c store),forum=$(c forum),gitlab=$(c code),wiki=$(c wiki),map=$(c map),mail=$(c mail) --tenant $tenant" ;;
  reset)
    for s in "${SITES[@]}"; do
      q=""; [ -n "$all" ] && q="?all=1"
      echo "$s: $(CTLPATH="/__rl/reset$q" ctl "$s" "$tenant" -XPOST)"
    done ;;
  *) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; [ "$cmd" = help ] || exit 2 ;;
esac
