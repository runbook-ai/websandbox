# websandbox public demo: all five lite sites + a Host-routing front router in one container.
# The image is only a bootstrap: code comes from GitHub and data from Hugging Face at every
# start (deploy/bootstrap.sh), so a restart/redeploy refreshes both. Rebuild the image only
# when this file or bootstrap.sh changes (deploy/README.md).
FROM node:20-bookworm

# git (code sync), build tools (better-sqlite3 is rebuilt from source with SQLITE_USE_URI=1,
# zstd-napi), python3 + huggingface_hub (data sync), zstd (map/static.tar.zst). PID 1 = compose `init: true`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates build-essential python3 python3-pip zstd curl \
 && pip3 install --no-cache-dir --break-system-packages 'huggingface_hub>=0.26,<1' \
 && rm -rf /var/lib/apt/lists/*

COPY bootstrap.sh /usr/local/bin/wsb-bootstrap
RUN chmod +x /usr/local/bin/wsb-bootstrap

ENV WSB_REPO=https://github.com/runbook-ai/websandbox.git \
    WSB_REF=main \
    WSB_HF_REPO=junfengzhou/websandbox \
    WSB_HF_REV=main \
    WSB_ROOT=/srv \
    HF_HUB_DISABLE_TELEMETRY=1 \
    NODE_ENV=production

EXPOSE 8080
VOLUME /srv
HEALTHCHECK --interval=60s --timeout=10s --start-period=1800s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/__status >/dev/null || exit 1
CMD ["wsb-bootstrap"]
