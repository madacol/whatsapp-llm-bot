#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

exec ./capture_after_wake.sh \
  --model hey_jarvis \
  --wake-threshold 0.5 \
  --vad-threshold 0.35 \
  --pre-roll 5 \
  --stop-silence 3 \
  --post-roll 0.3 \
  --leading-pad 1 \
  --max-utterance 20 \
  --scores \
  --transcribe \
  --transcriber ./live_transcribe_and_ask.py \
  "$@"
