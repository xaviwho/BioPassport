#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DELAY_MS="${1:-0}"

detect_container() {
  local cid=""
  cid="$(cd "$SCRIPT_DIR" && docker compose ps -q minio 2>/dev/null | head -n 1 || true)"
  if [[ -n "$cid" ]]; then
    echo "$cid"
    return 0
  fi

  cid="$(docker ps --filter "name=e2e-latency" --filter "name=minio" --format '{{.ID}}' | head -n 1 || true)"
  if [[ -n "$cid" ]]; then
    echo "$cid"
    return 0
  fi

  cid="$(docker ps --filter "ancestor=minio/minio:latest" --format '{{.ID}}' | head -n 1 || true)"
  if [[ -n "$cid" ]]; then
    echo "$cid"
    return 0
  fi

  return 1
}

CONTAINER="${CONTAINER:-$(detect_container || true)}"
if [[ -z "$CONTAINER" ]]; then
  echo "Could not find a running MinIO container" >&2
  exit 1
fi

docker exec "$CONTAINER" sh -lc 'command -v tc >/dev/null 2>&1' >/dev/null || {
  echo "tc is not installed in container $CONTAINER" >&2
  exit 1
}

docker exec "$CONTAINER" tc qdisc del dev eth0 root 2>/dev/null || true
if [[ "$DELAY_MS" != "0" ]]; then
  docker exec "$CONTAINER" tc qdisc add dev eth0 root netem delay "${DELAY_MS}ms"
  echo "Injected ${DELAY_MS}ms delay on eth0 for ${CONTAINER}"
else
  echo "Cleared RTT injection on ${CONTAINER}"
fi
