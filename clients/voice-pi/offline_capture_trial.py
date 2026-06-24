#!/usr/bin/env python3
import argparse
import collections
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
from openwakeword.vad import VAD


RATE = 16000
FRAME_SAMPLES = 1280
FRAME_SECONDS = FRAME_SAMPLES / RATE


def read_wav(path):
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        frames = wav.getnframes()
        data = wav.readframes(frames)
    if channels != 1 or width != 2 or rate != RATE:
        raise ValueError(f"expected mono 16-bit {RATE}Hz WAV")
    return np.frombuffer(data, dtype=np.int16)


def write_wav(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(samples.astype(np.int16).tobytes())


def trim_leading_non_speech(frames, vad_scores, vad_threshold, pad_frames):
    if not frames or not vad_scores:
        return frames, 0

    first_speech = None
    for ndx, score in enumerate(vad_scores):
        if score >= vad_threshold:
            first_speech = ndx
            break

    if first_speech is None:
        return frames, 0

    start = max(0, first_speech - pad_frames)
    return frames[start:], start


def main():
    parser = argparse.ArgumentParser(description="Offline trial of wake + VAD capture cutting.")
    parser.add_argument("input_wav")
    parser.add_argument("output_wav")
    parser.add_argument("--model", default="hey_jarvis")
    parser.add_argument("--wake-threshold", type=float, default=0.5)
    parser.add_argument("--vad-threshold", type=float, default=0.35)
    parser.add_argument("--pre-roll", type=float, default=5.0)
    parser.add_argument("--stop-silence", type=float, default=3.0)
    parser.add_argument("--post-roll", type=float, default=0.3)
    parser.add_argument("--leading-pad", type=float, default=1.0)
    parser.add_argument("--no-trim-leading-silence", action="store_true")
    parser.add_argument("--max-utterance", type=float, default=20.0)
    args = parser.parse_args()

    samples = read_wav(args.input_wav)
    wake_model = Model(wakeword_models=[args.model], inference_framework="onnx")
    vad = VAD(n_threads=1)

    pre_roll_frames = max(1, int(round(args.pre_roll / FRAME_SECONDS)))
    stop_silence_frames = max(1, int(round(args.stop_silence / FRAME_SECONDS)))
    post_roll_frames = max(0, int(round(args.post_roll / FRAME_SECONDS)))
    leading_pad_frames = max(0, int(round(args.leading_pad / FRAME_SECONDS)))
    max_utterance_frames = max(1, int(round(args.max_utterance / FRAME_SECONDS)))

    ring = collections.deque(maxlen=pre_roll_frames)
    vad_ring = collections.deque(maxlen=pre_roll_frames)
    capture = []
    capture_vad_scores = []
    capturing = False
    speech_seen = False
    silence_frames = 0
    no_speech_frames = 0
    wake_time = None
    done_reason = None

    for start in range(0, len(samples), FRAME_SAMPLES):
        frame = samples[start:start + FRAME_SAMPLES]
        if len(frame) < FRAME_SAMPLES:
            frame = np.pad(frame, (0, FRAME_SAMPLES - len(frame)))
        t = start / RATE

        wake_predictions = wake_model.predict(frame)
        _, wake_score = max(wake_predictions.items(), key=lambda item: float(item[1]))
        wake_score = float(wake_score)
        vad_score = float(vad.predict(frame, frame_size=640))

        ring.append(frame.copy())
        vad_ring.append(vad_score)

        if not capturing:
            if wake_score >= args.wake_threshold:
                capturing = True
                wake_time = t
                speech_seen = vad_score >= args.vad_threshold
                capture = [f.copy() for f in ring]
                capture_vad_scores = list(vad_ring)
                print(f"WAKE t={t:.2f}s wake_score={wake_score:.3f} vad={vad_score:.3f}")
            continue

        capture.append(frame.copy())
        capture_vad_scores.append(vad_score)

        if vad_score >= args.vad_threshold:
            speech_seen = True
            silence_frames = 0
            no_speech_frames = 0
        else:
            if speech_seen:
                silence_frames += 1
            else:
                no_speech_frames += 1

        post_wake_frames = len(capture) - len(ring)
        if speech_seen and silence_frames >= stop_silence_frames + post_roll_frames:
            done_reason = "silence"
            break
        if not speech_seen and no_speech_frames >= int(round(5.0 / FRAME_SECONDS)):
            done_reason = "no_speech"
            break
        if post_wake_frames >= max_utterance_frames:
            done_reason = "max_utterance"
            break

    if not capture:
        raise SystemExit("no wake detected")

    output_capture = capture
    trimmed_frames = 0
    if not args.no_trim_leading_silence:
        output_capture, trimmed_frames = trim_leading_non_speech(
            capture,
            capture_vad_scores,
            args.vad_threshold,
            leading_pad_frames,
        )

    out_samples = np.concatenate(output_capture)
    write_wav(Path(args.output_wav), out_samples)
    print(f"CAPTURE_DONE reason={done_reason or 'end_of_file'} file={args.output_wav}")
    print(f"input_duration={len(samples) / RATE:.2f}s")
    print(f"output_duration={len(out_samples) / RATE:.2f}s")
    print(f"trimmed_start={trimmed_frames * FRAME_SECONDS:.2f}s")
    if wake_time is not None:
        print(f"wake_time={wake_time:.2f}s")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
