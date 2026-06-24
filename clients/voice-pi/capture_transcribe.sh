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
  --pre-roll 0.16 \
  --stop-silence 1.5 \
  --post-roll 0.3 \
  --leading-pad 1 \
  --max-utterance 120 \
  --transcribe
