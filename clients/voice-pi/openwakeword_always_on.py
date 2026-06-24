#!/usr/bin/env python3
import argparse
import math
import os
import signal
import subprocess
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
FRAME_BYTES = FRAME_SAMPLES * 2
WAKE_CUE_PATH = Path("/tmp/openwakeword-wake-cue.wav")


def run(cmd):
    return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def write_wake_cue(path):
    sample_rate = 44100
    tones = [(660.0, 0.16), (0.0, 0.05), (990.0, 0.16), (0.0, 0.05), (1320.0, 0.24)]
    amplitude = 0.72
    frames = bytearray()

    for frequency, duration in tones:
        samples = int(sample_rate * duration)
        for ndx in range(samples):
            if frequency == 0.0:
                sample = 0
            else:
                fade_samples = max(1, int(sample_rate * 0.01))
                envelope = min(1.0, ndx / fade_samples, (samples - ndx - 1) / fade_samples)
                value = math.sin(2.0 * math.pi * frequency * (ndx / sample_rate))
                sample = int(32767 * amplitude * envelope * value)
            frames.extend(sample.to_bytes(2, byteorder="little", signed=True))

    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(frames))


def play_wake_cue(device, path):
    if not device:
        return

    result = subprocess.run(
        ["aplay", "-q", "-D", device, str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        print(
            f"WAKE_CUE_ERROR device={device} returncode={result.returncode} stderr={result.stderr.strip()}",
            file=sys.stderr,
            flush=True,
        )


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def main():
    parser = argparse.ArgumentParser(description="Always-on openWakeWord detector for ALSA microphones.")
    parser.add_argument("--model", default="hey_jarvis", help="openWakeWord model name, e.g. hey_jarvis or alexa")
    parser.add_argument("--device", default="plughw:CARD=Device,DEV=0", help="ALSA capture device")
    parser.add_argument("--threshold", type=float, default=0.5, help="activation threshold, usually 0.3-0.7")
    parser.add_argument("--debounce", type=float, default=2.0, help="seconds to suppress repeated detections")
    parser.add_argument("--duration", type=float, default=0.0, help="seconds to run; 0 means forever")
    parser.add_argument("--scores", action="store_true", help="print best score once per second")
    parser.add_argument("--no-wake-cue", action="store_true", help="do not play a confirmation sound on wake")
    parser.add_argument(
        "--wake-cue-device",
        default=os.environ.get("WAKE_CUE_DEVICE", "default"),
        help="ALSA playback device for the wake cue; set empty to disable",
    )
    args = parser.parse_args()

    run(["amixer", "-c", "0", "sset", "Mic", "16"])
    if not args.no_wake_cue and args.wake_cue_device:
        write_wake_cue(WAKE_CUE_PATH)

    print("loading openWakeWord model...", flush=True)
    model = Model(wakeword_models=[args.model], inference_framework="onnx")
    wake_cue_status = "off" if args.no_wake_cue or not args.wake_cue_device else args.wake_cue_device
    print(
        f"ready: model={args.model} threshold={args.threshold} device={args.device} wake_cue={wake_cue_status}",
        flush=True,
    )
    print("say the wake phrase near the Pi microphone", flush=True)

    arecord = subprocess.Popen(
        [
            "arecord",
            "-q",
            "-D",
            args.device,
            "-f",
            "S16_LE",
            "-r",
            str(RATE),
            "-c",
            "1",
            "-t",
            "raw",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    stop = False

    def handle_signal(_signum, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    started = time.monotonic()
    last_detection = 0.0
    last_score_print = 0.0
    frames = 0

    try:
        while not stop:
            if args.duration and time.monotonic() - started >= args.duration:
                break

            data = read_exact(arecord.stdout, FRAME_BYTES)
            if len(data) != FRAME_BYTES:
                err = arecord.stderr.read().decode("utf-8", errors="replace") if arecord.stderr else ""
                raise RuntimeError(f"arecord ended early: {err.strip()}")

            frame = np.frombuffer(data, dtype=np.int16)
            frame_started = time.monotonic()
            predictions = model.predict(frame)
            predict_ms = (time.monotonic() - frame_started) * 1000.0
            frames += 1

            label, score = max(predictions.items(), key=lambda item: float(item[1]))
            score = float(score)
            now = time.monotonic()

            if args.scores and now - last_score_print >= 1.0:
                elapsed = now - started
                realtime = (frames * 0.08) / elapsed if elapsed > 0 else 0
                print(
                    f"score label={label} score={score:.3f} predict_ms={predict_ms:.1f} realtime={realtime:.2f}x",
                    flush=True,
                )
                last_score_print = now

            if score >= args.threshold and now - last_detection >= args.debounce:
                print(
                    f"WAKE label={label} score={score:.3f} predict_ms={predict_ms:.1f} elapsed={now - started:.2f}s",
                    flush=True,
                )
                if not args.no_wake_cue:
                    play_wake_cue(args.wake_cue_device, WAKE_CUE_PATH)
                last_detection = now
    finally:
        arecord.terminate()
        try:
            arecord.wait(timeout=2)
        except subprocess.TimeoutExpired:
            arecord.kill()
            arecord.wait(timeout=2)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
