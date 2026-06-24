#!/usr/bin/env bash
set -euo pipefail

KEYPHRASE="${1:-porcupine}"
DURATION="${2:-15}"
THRESHOLD="${3:-1e-20}"
CARD="${CARD:-Device}"
DEVICE="${DEVICE:-plughw:CARD=${CARD},DEV=0}"
OUT_DIR="${OUT_DIR:-/tmp}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LEVEL_WAV="${OUT_DIR}/mic-level-${STAMP}.wav"
WAKE_WAV="${OUT_DIR}/wake-${KEYPHRASE// /_}-${STAMP}.wav"
LOG_FILE="${OUT_DIR}/pocketsphinx-wake-${STAMP}.log"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    return 1
  fi
}

need arecord
need amixer
need pocketsphinx_continuous
need python3

echo "== audio cards =="
cat /proc/asound/cards || true

echo
echo "== capture devices =="
arecord -l || true

echo
echo "== mic gain =="
if amixer -c 0 sget Mic >/dev/null 2>&1; then
  amixer -c 0 sset Mic 16 >/dev/null || true
  amixer -c 0 sget Mic || true
else
  echo "No ALSA mixer control named Mic on card 0."
fi

echo
echo "== microphone level check =="
echo "Recording 4 seconds from ${DEVICE}..."
arecord -D "${DEVICE}" -f S16_LE -r 16000 -c 1 -d 4 "${LEVEL_WAV}" >/dev/null 2>&1

python3 - "${LEVEL_WAV}" <<'PY'
import math
import struct
import sys
import wave

path = sys.argv[1]
with wave.open(path, "rb") as wav:
    channels = wav.getnchannels()
    rate = wav.getframerate()
    frames = wav.getnframes()
    data = wav.readframes(frames)

samples = struct.unpack("<" + "h" * (len(data) // 2), data) if data else []
rms = math.sqrt(sum(s * s for s in samples) / len(samples)) if samples else 0
peak = max((abs(s) for s in samples), default=0)
nonzero = sum(1 for s in samples if s != 0)

print(f"file={path}")
print(f"channels={channels}")
print(f"rate={rate}")
print(f"duration={frames / rate:.2f}s")
print(f"rms={rms:.2f}")
print(f"peak={peak}")
print(f"nonzero_sample_ratio={nonzero / len(samples):.3f}" if samples else "nonzero_sample_ratio=0")
PY

echo
echo "== wake-word test =="
echo "Keyphrase: ${KEYPHRASE}"
echo "Duration: ${DURATION}s"
echo "Threshold: ${THRESHOLD}"
echo "Say the keyphrase near the microphone now."

arecord -D "${DEVICE}" -f S16_LE -r 16000 -c 1 -d "${DURATION}" "${WAKE_WAV}" >/dev/null 2>&1

echo "Recognizing ${WAKE_WAV}..."
DETECTIONS="$(
  pocketsphinx_continuous \
    -infile "${WAKE_WAV}" \
    -samprate 16000 \
    -keyphrase "${KEYPHRASE}" \
    -kws_threshold "${THRESHOLD}" \
    -logfn "${LOG_FILE}" 2>&1 || true
)"

if [ -n "${DETECTIONS}" ]; then
  echo "DETECTED:"
  echo "${DETECTIONS}"
else
  echo "No keyphrase detected."
fi

echo
echo "Artifacts:"
echo "  level_wav=${LEVEL_WAV}"
echo "  wake_wav=${WAKE_WAV}"
echo "  log=${LOG_FILE}"
