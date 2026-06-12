#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
. .venv/bin/activate

exec python openwakeword_always_on.py "$@"
