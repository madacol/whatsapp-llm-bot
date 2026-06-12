#!/usr/bin/env python3
import argparse
import os
import sys
import time
import wave

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

import numpy as np
from openwakeword.model import Model


RATE = 16000
FRAME_SAMPLES = 1280
FRAME_SECONDS = FRAME_SAMPLES / RATE


def read_wav(path):
    with wave.open(path, "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.getnframes()
        data = wav.readframes(frames)

    if channels != 1 or width != 2 or rate != RATE:
        raise ValueError(
            f"expected mono 16-bit {RATE}Hz WAV, got channels={channels} width={width} rate={rate}"
        )

    samples = np.frombuffer(data, dtype=np.int16)
    return samples


def test_file(model, wav_path, args):
    samples = read_wav(wav_path)
    duration = len(samples) / RATE
    print(f"== {wav_path} ==")
    print(f"duration={duration:.2f}s")
    print(f"threshold={args.threshold}")

    max_score = 0.0
    max_time = 0.0
    detections = []
    last_detection_time = -999.0
    last_score_bucket = -1
    started = time.monotonic()

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

        if args.scores:
            bucket = int(t)
            if bucket != last_score_bucket:
                print(f"score t={t:.2f}s label={label} score={score:.3f}")
                last_score_bucket = bucket

        if score >= args.threshold and t - last_detection_time >= args.debounce:
            print(f"DETECT t={t:.2f}s label={label} score={score:.3f}")
            detections.append((t, label, score))
            last_detection_time = t

    elapsed = time.monotonic() - started
    realtime = duration / elapsed if elapsed > 0 else 0.0
    print(f"max_score={max_score:.3f}")
    print(f"max_score_time={max_time:.2f}s")
    print(f"detections={len(detections)}")
    print(f"processing_realtime={realtime:.2f}x")
    print()
    return len(detections) > 0


def main():
    parser = argparse.ArgumentParser(description="Run openWakeWord against offline WAV samples.")
    parser.add_argument("wav", nargs="+", help="mono 16-bit 16kHz WAV file(s)")
    parser.add_argument("--model", default="hey_jarvis")
    parser.add_argument("--threshold", type=float, default=0.25)
    parser.add_argument("--debounce", type=float, default=1.0)
    parser.add_argument("--scores", action="store_true", help="print score once per second")
    args = parser.parse_args()

    print(f"model={args.model}")
    model = Model(wakeword_models=[args.model], inference_framework="onnx")

    results = [test_file(model, wav, args) for wav in args.wav]
    if not all(results):
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
