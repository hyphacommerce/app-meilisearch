#!/usr/bin/env bash
# End to end against a real Hypha and a real Meilisearch, on a fresh database:
#
#   HYPHA_BIN=../hypha/target/debug/hypha-host-axum bash scripts/e2e.sh
#
# Starts Meilisearch (Docker), a Hypha host on a new database of Hypha's compose
# Postgres (`docker compose up -d` in ../hypha), seeds it with ../hypha/scripts/seed.mjs,
# starts this app (Node host), then runs scripts/e2e.ts: OAuth install approved as the
# owner, settings through a session token, the full index, Hypha's search setting, and
# /storefront/search answered by the app, then a product update reaching the index by
# webhook. Everything it starts is stopped, and the database dropped, on exit.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
hypha="${HYPHA_DIR:-$here/../hypha}"
bin="${HYPHA_BIN:-$hypha/target/debug/hypha-host-axum}"
meili_tag="${MEILI_TAG:-v1.54.3}"
db="hypha_app_meili_e2e_$$"
work="$(mktemp -d)"
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
hypha_port="${HYPHA_PORT:-$(free_port)}"
app_port="${APP_PORT:-$(free_port)}"
meili_port="${MEILI_PORT:-$(free_port)}"
meili_key="e2e-master-key-$(openssl rand -hex 8)"
container="hypha-app-meili-e2e-$$"
psql() { docker compose -f "$hypha/compose.yaml" exec -T postgres psql -U hypha -v ON_ERROR_STOP=1 "$@"; }

pids=()
cleanup() {
  status=$?
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  docker stop "$container" >/dev/null 2>&1 || true
  psql -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ]; then
    echo "--- hypha log (tail)"; tail -n 40 "$work/hypha.log" 2>/dev/null || true
    echo "--- app log (tail)"; tail -n 40 "$work/app.log" 2>/dev/null || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for() { # url, what
  for _ in $(seq 1 90); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "$2 didn't start" >&2; return 1
}

echo "== Meilisearch $meili_tag on :$meili_port"
docker run -d --rm --name "$container" -p "127.0.0.1:$meili_port:7700" \
  -e MEILI_MASTER_KEY="$meili_key" -e MEILI_NO_ANALYTICS=true \
  "getmeili/meilisearch:$meili_tag" >/dev/null
wait_for "http://127.0.0.1:$meili_port/health" Meilisearch

echo "== Hypha ($bin) on :$hypha_port, database $db"
psql -q -c "CREATE DATABASE $db" >/dev/null
DATABASE_URL="postgres://hypha:hypha@localhost:5432/$db" \
HYPHA_SECRET_KEY="$(openssl rand -hex 32)" \
HYPHA_OWNER_EMAIL=owner@example.com HYPHA_OWNER_PASSWORD=e2e-owner-password \
HYPHA_BIND="127.0.0.1:$hypha_port" HYPHA_ADMIN_URL=http://admin.e2e.test \
HYPHA_ALLOW_PRIVATE_CALLBACKS=true RUST_LOG="${RUST_LOG:-warn}" \
  "$bin" >"$work/hypha.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:$hypha_port/health" Hypha

echo "== Seeding the demo store"
HYPHA_URL="http://127.0.0.1:$hypha_port" HYPHA_SEED_EMAIL=owner@example.com \
HYPHA_SEED_PASSWORD=e2e-owner-password STOREFRONT_URL="http://127.0.0.1:9" \
  node "$hypha/scripts/seed.mjs" >"$work/seed.log" 2>&1 || { cat "$work/seed.log"; exit 1; }
storefront_key="$(sed -n 's/^  STOREFRONT_KEY=//p' "$work/seed.log")"
[ -n "$storefront_key" ] || { echo "the seed printed no STOREFRONT_KEY" >&2; exit 1; }

echo "== The app on :$app_port"
APP_URL="http://localhost:$app_port" PORT="$app_port" HOST="::" \
APP_ENCRYPTION_KEY="$(openssl rand -hex 32)" DATABASE_PATH="$work/app.sqlite" \
RUN_INTERVAL_MS=500 \
  node --disable-warning=ExperimentalWarning "$here/src/hosts/node.ts" >"$work/app.log" 2>&1 &
pids+=("$!")
wait_for "http://127.0.0.1:$app_port/health" "the app"

HYPHA_URL="http://127.0.0.1:$hypha_port" APP_URL="http://localhost:$app_port" \
MEILI_URL="http://127.0.0.1:$meili_port" MEILI_KEY="$meili_key" \
STOREFRONT_KEY="$storefront_key" OWNER_EMAIL=owner@example.com OWNER_PASSWORD=e2e-owner-password \
  node "$here/scripts/e2e.ts"
