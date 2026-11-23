# Demo deployment

The public demo is **https://websandbox.pystem.com**: all five sites in one container behind one
port and one host -- landing page at `/`, sites under path prefixes `/shop/` (store; back office
`/shop/admin`), `/forum/`, `/code/`, `/wiki/`, `/map/`, every site reset hourly.

The files in this directory let you run your own copy the same way: `Dockerfile` (a small
bootstrap image), `compose.yaml`, and the start scripts the container runs from the repo.

## Run your own

```bash
git clone https://github.com/runbook-ai/websandbox.git && cd websandbox/deploy
# edit compose.yaml: WSB_DOMAIN (your host name), the ./srv volume path, the published port
docker compose up -d --build     # first start downloads ~21 GB from Hugging Face (see the log)
docker compose logs -f           # bootstrap / data sync / router log
curl -s http://localhost:8080/__status
```

Needs ~30 GB of disk for the volume and ~7 GB of RAM. Put any reverse proxy that terminates TLS
(nginx, Caddy, Traefik, ...) in front of the published port: one proxy host for your domain,
forwarding to the container port with `X-Forwarded-Proto` / `X-Forwarded-For` (or `X-Real-IP`)
set. Uploads are capped at 5 MB by the router, so the proxy's body limit only needs to allow that.

### HTTPS only

`HTTPS_ONLY=1` (the default in `compose.yaml`) is meant for a deployment behind a TLS proxy. The
router then redirects every request the proxy marks `X-Forwarded-Proto: http` -- and any plain
request for `WSB_DOMAIN` that arrives without that header -- to the same `https://` URL (301 for
GET/HEAD, 308 otherwise, so methods and bodies are kept), and sends
`Strict-Transport-Security: max-age=31536000` (`WSB_HSTS` overrides the value; `WSB_HSTS=off` if your proxy already sends HSTS) on HTTPS
responses. Requests without `X-Forwarded-Proto` for any other host -- direct access to the
container port on your network, health checks -- are served as before. Set `HTTPS_ONLY=0` when
you serve the demo over plain HTTP.

## What happens at every container start

The image (`Dockerfile`: node 20, git, build tools, python3 + huggingface_hub, zstd) only holds
`bootstrap.sh`. On start it:

1. fetches `github.com/runbook-ai/websandbox` at `WSB_REF` (default `main`) into `/srv/repo`
   (shallow, no credentials) and runs that checkout's `deploy/start.sh`, which
2. runs `npm ci --omit=dev` in `kit/` and the sites only when their `package*.json` (or the node
   version) changed -- `node_modules` stay in the volume, so a restart takes seconds;
3. syncs the data from the public HF dataset `junfengzhou/websandbox` at `WSB_HF_REV` into
   `/srv/data` (`sync-data.py`: `snapshot_download`, changed files only; every file checked
   against its site's `SHA256SUMS`, hashes cached by size/mtime/inode; `media.tar` /
   `static.tar.zst` re-extracted only when their sha changed); first start downloads ~21 GB;
4. starts the sites with `tasks/tools/sites.sh up --bind ports --base 7700 --tenants 1 --workers 1`
   on 127.0.0.1 (map: 1 route worker, 2 geocoder threads) with a control token generated once
   into `/srv/state/control-token`;
5. execs `router.js` on :8080: routes by path prefix, serves the landing page (`landing.html`) and
   `/__status` (site health, last/next reset; no secrets), refuses any path containing `__rl`
   (the sites trust loopback, and the router's upstream requests come from loopback), drops
   `X-WSB-*` request headers, resets every site each `WSB_RESET_MINUTES` (60, on the hour)
   through the control API, and applies abuse limits: per-IP token buckets (30 req/s, burst
   400; writes 1/s, burst 40; bodies > 256 KB 30/hour), 32 in-flight requests per IP, 5 MB body
   cap. A site unhealthy for ~3 minutes makes the router exit, and the container restarts.

## Path prefixes without changing the sites (`prefix.js`)

The sites run at their root (the RL stack needs them there), so the router rewrites what they
send: `Location` headers (root-relative or absolute to our host, `https` when the proxy says so),
`Set-Cookie` `Path=/` -> `Path=/<site>/` (logins of different sites never collide), HTML
attributes (`href src action formaction poster xlink:href data-*`, `srcset`, `<option value>`),
`url(/...)` in CSS and inline styles, root-relative string literals in the sites' own JS
(`/static/`, `/_kit/`) and inline scripts/handlers (so `location.pathname` comparisons keep
working), absolute `http://<host>/` URLs in any text response (map `style.json` tile/glyph/sprite
URLs, wiki opensearch). A small shim injected first into every HTML `<head>` prefixes URLs that
client JS builds at run time (fetch, XHR, history.pushState/replaceState, window.open, and
`href/src/action` of elements inserted or changed later, e.g. store autocomplete results built
from JSON). The site's own `Referer` is un-prefixed on the way in. A same-origin request that
still escapes its prefix is 307-redirected back under the prefix of its Referer page and logged
(`escaped:` in the log). The wiki owns paths under `/wiki/` (`/wiki/<Article>` ->
`/wiki/wiki/<Article>`), so its Location headers are always prefixed. CSP stays the sites'
same-origin policy.

Volume (`./srv` in `compose.yaml`, mounted at `/srv`): `repo/`, `data/`, `state/` (`control-token`,
`sites/*.log`).

## Refresh / redeploy

A restart refreshes code and data: the container fetches `WSB_REF` from GitHub and the
`WSB_HF_REV` data from Hugging Face at every start (~1 minute when nothing changed).

```bash
docker compose up -d --force-recreate   # restart: latest WSB_REF + HF data
docker compose logs -f                   # bootstrap / sync / router log
tail ./srv/state/sites/*.log             # per-site server logs
curl -s http://localhost:8080/__status   # also: grep escaped: in the log
```

Pin a code or data version: set `WSB_REF` (branch, tag or commit sha) or `WSB_HF_REV` in
`compose.yaml`, then redeploy. The checkout is a shallow fetch of `WSB_REF` followed by a forced
checkout, so it also follows a rewritten (force-pushed) history.

Rebuild the image only when `Dockerfile` or `bootstrap.sh` change:
`docker compose build --pull && docker compose up -d`.

## Memory

1 tenant per site, 1 worker each (`docker stats`); the map's routing graph (~2 GB) dominates.
`mem_limit: 7g` in `compose.yaml`.
