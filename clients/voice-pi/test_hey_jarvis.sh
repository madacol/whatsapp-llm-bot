#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
exec ./openwakeword_always_on.sh --model hey_jarvis --threshold 0.5 --duration "${1:-25}" --scores
