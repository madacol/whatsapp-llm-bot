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

prompt="${*:-Show me a demo of all the tools you have. Use the real tool interface where appropriate so I can inspect every server-sent event shape your UI receives.}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
fixture_dir="fixtures/turn-events-${stamp}"
mkdir -p "$fixture_dir"

base_url="${API_TRANSPORT_BASE_URL:-http://127.0.0.1:3200}"
base_url="${base_url%/}"
transport_id="${API_TRANSPORT_ID:-voice}"
chat_id="${API_TRANSPORT_CHAT_ID:-api:client-1}"
events_url="${base_url}/api/transports/${transport_id}/events/stream?chatId=${chat_id}&after=0"
poll_url="${base_url}/api/transports/${transport_id}/events?chatId=${chat_id}&after=0"
request_timeout="${API_TRANSPORT_TIMEOUT:-300}"
events_pid=""

cleanup() {
  if [ -n "$events_pid" ] && kill -0 "$events_pid" >/dev/null 2>&1; then
    kill "$events_pid" >/dev/null 2>&1 || true
    wait "$events_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

cursor="0"
cursor_file="$fixture_dir/existing-events.json"
if curl -sS \
  -H "Authorization: Bearer ${API_TRANSPORT_TOKEN}" \
  "$poll_url" >"$cursor_file"; then
  parsed_cursor="$(python - "$cursor_file" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)

if isinstance(payload, list):
    events = payload
elif isinstance(payload, dict):
    events = payload.get("events") or payload.get("items") or payload.get("data") or []
else:
    events = []

ids = []
for event in events:
    if not isinstance(event, dict):
        continue
    raw_id = event.get("eventId")
    try:
        ids.append(int(raw_id))
    except (TypeError, ValueError):
        pass

print(max(ids) if ids else 0)
PY
)"
  if [ -n "$parsed_cursor" ]; then
    cursor="$parsed_cursor"
  fi
else
  echo "warning: failed to poll existing events; falling back to after=0" >&2
fi

events_url="${base_url}/api/transports/${transport_id}/events/stream?chatId=${chat_id}&after=${cursor}"

printf '%s\n' "$prompt" >"$fixture_dir/prompt.txt"
{
  printf 'created_at=%s\n' "$stamp"
  printf 'base_url=%s\n' "$base_url"
  printf 'transport_id=%s\n' "$transport_id"
  printf 'chat_id=%s\n' "$chat_id"
  printf 'request_timeout=%s\n' "$request_timeout"
  printf 'after=%s\n' "$cursor"
  printf 'poll_url=%s\n' "$poll_url"
  printf 'events_url=%s\n' "$events_url"
} >"$fixture_dir/metadata.txt"

echo "FIXTURE_DIR $fixture_dir"
echo "EVENTS_START $events_url"
curl -N -sS \
  -H "Authorization: Bearer ${API_TRANSPORT_TOKEN}" \
  "$events_url" >"$fixture_dir/events.sse" 2>"$fixture_dir/events.stderr" &
events_pid="$!"

sleep 1

echo "REQUEST_START"
if ./ask_api_transport.sh --timeout "$request_timeout" --json "$prompt" >"$fixture_dir/response.json" 2>"$fixture_dir/response.stderr"; then
  echo "REQUEST_DONE"
else
  status="$?"
  echo "REQUEST_FAILED status=$status" >&2
  exit "$status"
fi

sleep 2
cleanup
trap - EXIT INT TERM

echo "EVENTS_LINES $(wc -l <"$fixture_dir/events.sse")"
echo "RESPONSE_BYTES $(wc -c <"$fixture_dir/response.json")"
echo "FIXTURE_SAVED $fixture_dir"
