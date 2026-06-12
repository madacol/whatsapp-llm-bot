#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required to stream server events" >&2
  exit 1
fi

if [ -z "${API_TRANSPORT_TOKEN:-}" ]; then
  echo "error: API_TRANSPORT_TOKEN is not set" >&2
  exit 1
fi

base_url="${API_TRANSPORT_BASE_URL:-http://127.0.0.1:3200}"
base_url="${base_url%/}"
transport_id="${API_TRANSPORT_ID:-voice}"
chat_id="${API_TRANSPORT_CHAT_ID:-api:client-1}"
events_url="${base_url}/api/transports/${transport_id}/events/stream?chatId=${chat_id}&after=0"
events_pid=""

cleanup() {
  if [ -n "$events_pid" ] && kill -0 "$events_pid" >/dev/null 2>&1; then
    kill "$events_pid" >/dev/null 2>&1 || true
    wait "$events_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

echo "SERVER_EVENTS_START url=${events_url}"
curl -N -sS \
  -H "Authorization: Bearer ${API_TRANSPORT_TOKEN}" \
  "$events_url" 2>&1 |
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      printf 'SERVER_EVENT %s\n' "$line"
    fi
  done &
events_pid="$!"

./live_console_test.sh "$@"
