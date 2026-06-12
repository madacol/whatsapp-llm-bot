#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-wake}"
KEYPHRASE="${2:-porcupine}"
CHUNK_SECONDS="${3:-1}"
RUN_SECONDS="${4:-30}"
THRESHOLD="${5:-1e-20}"
CARD="${CARD:-Device}"
DEVICE="${DEVICE:-plughw:CARD=${CARD},DEV=0}"
OUT_DIR="${OUT_DIR:-/tmp/piie-realtime-test}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    return 1
  fi
}

if [ "${MODE}" != "wake" ] && [ "${MODE}" != "stt" ]; then
  echo "usage: $0 [wake|stt] [keyphrase] [chunk_seconds] [run_seconds] [threshold]" >&2
  exit 2
fi

need arecord
need amixer
need date
need pocketsphinx_continuous

mkdir -p "${OUT_DIR}"

if amixer -c 0 sget Mic >/dev/null 2>&1; then
  amixer -c 0 sset Mic 16 >/dev/null || true
fi

echo "mode=${MODE}"
echo "device=${DEVICE}"
echo "chunk_seconds=${CHUNK_SECONDS}"
echo "run_seconds=${RUN_SECONDS}"
if [ "${MODE}" = "wake" ]; then
  echo "keyphrase=${KEYPHRASE}"
  echo "threshold=${THRESHOLD}"
fi
echo "Say speech near the Pi microphone now."
echo

start_epoch="$(date +%s)"
i=0

while :; do
  now_epoch="$(date +%s)"
  elapsed=$((now_epoch - start_epoch))
  if [ "${elapsed}" -ge "${RUN_SECONDS}" ]; then
    break
  fi

  i=$((i + 1))
  chunk="${OUT_DIR}/chunk-${i}.wav"
  log="${OUT_DIR}/chunk-${i}.log"
  record_started_ms="$(date +%s%3N)"

  arecord -q -D "${DEVICE}" -f S16_LE -r 16000 -c 1 -d "${CHUNK_SECONDS}" "${chunk}"

  decode_started_ms="$(date +%s%3N)"
  if [ "${MODE}" = "wake" ]; then
    output="$(
      pocketsphinx_continuous \
        -infile "${chunk}" \
        -samprate 16000 \
        -keyphrase "${KEYPHRASE}" \
        -kws_threshold "${THRESHOLD}" \
        -logfn "${log}" 2>&1 || true
    )"
  else
    output="$(
      pocketsphinx_continuous \
        -infile "${chunk}" \
        -samprate 16000 \
        -logfn "${log}" 2>&1 || true
    )"
  fi
  decode_finished_ms="$(date +%s%3N)"

  record_ms=$((decode_started_ms - record_started_ms))
  decode_ms=$((decode_finished_ms - decode_started_ms))
  total_ms=$((decode_finished_ms - record_started_ms))
  stamp="$(date +%H:%M:%S)"

  if [ -n "${output}" ]; then
    while IFS= read -r line; do
      [ -z "${line}" ] && continue
      printf '[%s] chunk=%03d record_ms=%d decode_ms=%d total_ms=%d detected=%s\n' \
        "${stamp}" "${i}" "${record_ms}" "${decode_ms}" "${total_ms}" "${line}"
    done <<< "${output}"
  else
    printf '[%s] chunk=%03d record_ms=%d decode_ms=%d total_ms=%d detected=\n' \
      "${stamp}" "${i}" "${record_ms}" "${decode_ms}" "${total_ms}"
  fi
done

echo
echo "Done. Chunk WAVs and logs are in ${OUT_DIR}."
