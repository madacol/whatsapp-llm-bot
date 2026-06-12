#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-wake}"
KEYPHRASE="${2:-porcupine}"
WINDOW_SECONDS="${3:-2}"
OVERLAP_SECONDS="${4:-0.5}"
RUN_SECONDS="${5:-30}"
THRESHOLD="${6:-1e-20}"
CARD="${CARD:-Device}"
DEVICE="${DEVICE:-plughw:CARD=${CARD},DEV=0}"
OUT_DIR="${OUT_DIR:-/tmp/piie-overlap-test}"
RATE=16000
CHANNELS=1
SAMPLE_BYTES=2

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    return 1
  fi
}

if [ "${MODE}" != "wake" ] && [ "${MODE}" != "stt" ]; then
  echo "usage: $0 [wake|stt] [keyphrase] [window_seconds] [overlap_seconds] [run_seconds] [threshold]" >&2
  exit 2
fi

need arecord
need amixer
need date
need pocketsphinx_continuous
need python3
need stat

read -r STRIDE_SECONDS WINDOW_BYTES STRIDE_BYTES RUN_WINDOWS <<EOF
$(python3 - "${WINDOW_SECONDS}" "${OVERLAP_SECONDS}" "${RUN_SECONDS}" "${RATE}" "${CHANNELS}" "${SAMPLE_BYTES}" <<'PY'
import math
import sys

window = float(sys.argv[1])
overlap = float(sys.argv[2])
run = float(sys.argv[3])
rate = int(sys.argv[4])
channels = int(sys.argv[5])
sample_bytes = int(sys.argv[6])
stride = window - overlap
if window <= 0:
    raise SystemExit("window_seconds must be > 0")
if overlap < 0:
    raise SystemExit("overlap_seconds must be >= 0")
if stride <= 0:
    raise SystemExit("overlap_seconds must be smaller than window_seconds")
bytes_per_second = rate * channels * sample_bytes
window_bytes = int(round(window * bytes_per_second))
stride_bytes = int(round(stride * bytes_per_second))
run_windows = max(0, int(math.floor((run - window) / stride)) + 1)
print(stride, window_bytes, stride_bytes, run_windows)
PY
)
EOF

if [ "${RUN_WINDOWS}" -le 0 ]; then
  echo "run_seconds must be at least window_seconds" >&2
  exit 2
fi

mkdir -p "${OUT_DIR}"

if amixer -c 0 sget Mic >/dev/null 2>&1; then
  amixer -c 0 sset Mic 16 >/dev/null || true
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
RAW_FILE="${OUT_DIR}/capture-${STAMP}.pcm"

rec_pid=""
cleanup() {
  if [ -n "${rec_pid}" ] && kill -0 "${rec_pid}" >/dev/null 2>&1; then
    kill "${rec_pid}" >/dev/null 2>&1 || true
    wait "${rec_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "mode=${MODE}"
echo "device=${DEVICE}"
echo "window_seconds=${WINDOW_SECONDS}"
echo "overlap_seconds=${OVERLAP_SECONDS}"
echo "stride_seconds=${STRIDE_SECONDS}"
echo "run_seconds=${RUN_SECONDS}"
echo "windows=${RUN_WINDOWS}"
if [ "${MODE}" = "wake" ]; then
  echo "keyphrase=${KEYPHRASE}"
  echo "threshold=${THRESHOLD}"
fi
echo "Say speech near the Pi microphone now."
echo

capture_started_ms="$(date +%s%3N)"
arecord -q -D "${DEVICE}" -f S16_LE -r "${RATE}" -c "${CHANNELS}" -t raw "${RAW_FILE}" &
rec_pid="$!"

for ((i = 0; i < RUN_WINDOWS; i++)); do
  start_byte=$((i * STRIDE_BYTES))
  end_byte=$((start_byte + WINDOW_BYTES))

  while :; do
    size="$(stat -c %s "${RAW_FILE}" 2>/dev/null || echo 0)"
    if [ "${size}" -ge "${end_byte}" ]; then
      break
    fi
    sleep 0.05
  done

  chunk="${OUT_DIR}/window-$((i + 1))-${STAMP}.wav"
  log="${OUT_DIR}/window-$((i + 1))-${STAMP}.log"
  window_end_ms="$(python3 - "${capture_started_ms}" "${WINDOW_SECONDS}" "${STRIDE_SECONDS}" "${i}" <<'PY'
import sys
capture_started_ms = int(sys.argv[1])
window = float(sys.argv[2])
stride = float(sys.argv[3])
i = int(sys.argv[4])
print(int(round(capture_started_ms + (i * stride + window) * 1000)))
PY
)"

  python3 - "${RAW_FILE}" "${chunk}" "${start_byte}" "${WINDOW_BYTES}" "${RATE}" "${CHANNELS}" <<'PY'
import sys
import wave

raw_path, wav_path = sys.argv[1], sys.argv[2]
start = int(sys.argv[3])
length = int(sys.argv[4])
rate = int(sys.argv[5])
channels = int(sys.argv[6])

with open(raw_path, "rb") as raw:
    raw.seek(start)
    data = raw.read(length)

with wave.open(wav_path, "wb") as wav:
    wav.setnchannels(channels)
    wav.setsampwidth(2)
    wav.setframerate(rate)
    wav.writeframes(data)
PY

  decode_started_ms="$(date +%s%3N)"
  if [ "${MODE}" = "wake" ]; then
    output="$(
      pocketsphinx_continuous \
        -infile "${chunk}" \
        -samprate "${RATE}" \
        -keyphrase "${KEYPHRASE}" \
        -kws_threshold "${THRESHOLD}" \
        -logfn "${log}" 2>&1 || true
    )"
  else
    output="$(
      pocketsphinx_continuous \
        -infile "${chunk}" \
        -samprate "${RATE}" \
        -logfn "${log}" 2>&1 || true
    )"
  fi
  decode_finished_ms="$(date +%s%3N)"

  decode_ms=$((decode_finished_ms - decode_started_ms))
  after_window_ms=$((decode_finished_ms - window_end_ms))
  stamp="$(date +%H:%M:%S)"

  if [ -n "${output}" ]; then
    while IFS= read -r line; do
      [ -z "${line}" ] && continue
      printf '[%s] window=%03d decode_ms=%d after_window_ms=%d detected=%s\n' \
        "${stamp}" "$((i + 1))" "${decode_ms}" "${after_window_ms}" "${line}"
    done <<< "${output}"
  else
    printf '[%s] window=%03d decode_ms=%d after_window_ms=%d detected=\n' \
      "${stamp}" "$((i + 1))" "${decode_ms}" "${after_window_ms}"
  fi
done

echo
echo "Done. Raw capture, WAV windows, and logs are in ${OUT_DIR}."
