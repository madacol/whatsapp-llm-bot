#!/usr/bin/env python3
import argparse
import os
import sys
import time
import wave
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

import numpy as np
from openwakeword.model import Model


RATE = 16000
FRAME_SAMPLES = 1280


def read_wav(path):
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.getnframes()
        data = wav.readframes(frames)
    if channels != 1 or width != 2 or rate != RATE:
        raise ValueError(f"{path}: expected mono 16-bit {RATE}Hz WAV")
    return np.frombuffer(data, dtype=np.int16)


def score_file(model, path, threshold, debounce):
    samples = read_wav(path)
    detections = []
    max_score = 0.0
    max_time = 0.0
    last_detection_time = -999.0

    for start in range(0, len(samples), FRAME_SAMPLES):
        frame = samples[start:start + FRAME_SAMPLES]
        if len(frame) < FRAME_SAMPLES:
            frame = np.pad(frame, (0, FRAME_SAMPLES - len(frame)))
        t = start / RATE
        prediction = model.predict(frame)
        label, score = max(prediction.items(), key=lambda item: float(item[1]))
        score = float(score)
        if score > max_score:
            max_score = score
            max_time = t
        if score >= threshold and t - last_detection_time >= debounce:
            detections.append((t, label, score))
            last_detection_time = t

    return len(samples) / RATE, max_score, max_time, detections


def main():
    parser = argparse.ArgumentParser(description="False-positive batch test for openWakeWord WAV samples.")
    parser.add_argument("directory", help="directory containing mono 16-bit 16kHz WAV files")
    parser.add_argument("--model", default="hey_jarvis")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--debounce", type=float, default=1.0)
    parser.add_argument("--start-index", type=int, default=1, help="1-based sorted file index to start from")
    parser.add_argument("--limit", type=int, default=0, help="maximum files to check; 0 means all remaining")
    args = parser.parse_args()

    all_files = sorted(Path(args.directory).glob("*.wav"))
    if not all_files:
        raise SystemExit(f"no WAV files found in {args.directory}")
    if args.start_index < 1 or args.start_index > len(all_files):
        raise SystemExit(f"start-index must be between 1 and {len(all_files)}")

    files = all_files[args.start_index - 1:]
    if args.limit:
        files = files[:args.limit]

    print(f"model={args.model}", flush=True)
    print(f"threshold={args.threshold}", flush=True)
    print(f"total_files={len(all_files)}", flush=True)
    print(f"start_index={args.start_index}", flush=True)
    print(f"files_to_check={len(files)}", flush=True)

    model = Model(wakeword_models=[args.model], inference_framework="onnx")

    started = time.monotonic()
    false_positives = []
    total_duration = 0.0
    global_max = (0.0, "", 0.0)

    for ndx, path in enumerate(files, 1):
        duration, max_score, max_time, detections = score_file(model, path, args.threshold, args.debounce)
        total_duration += duration
        if max_score > global_max[0]:
            global_max = (max_score, str(path), max_time)
        if detections:
            false_positives.append((path, detections, max_score, max_time))
            first = detections[0]
            print(
                f"FALSE_POSITIVE file={path.name} first_t={first[0]:.2f}s "
                f"first_score={first[2]:.3f} detections={len(detections)} "
                f"max_score={max_score:.3f} max_t={max_time:.2f}s",
                flush=True,
            )
        elif ndx % 10 == 0:
            print(f"checked={ndx}/{len(files)} absolute_index={args.start_index + ndx - 1}", flush=True)

    elapsed = time.monotonic() - started
    print("== summary ==")
    print(f"files={len(files)}")
    print(f"total_audio_seconds={total_duration:.2f}")
    print(f"false_positive_files={len(false_positives)}")
    print(f"max_score={global_max[0]:.3f}")
    print(f"max_score_file={global_max[1]}")
    print(f"max_score_time={global_max[2]:.2f}s")
    print(f"processing_realtime={total_duration / elapsed:.2f}x" if elapsed else "processing_realtime=0")

    if false_positives:
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
