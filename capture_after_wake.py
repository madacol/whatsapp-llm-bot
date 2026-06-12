#!/usr/bin/env python3
import argparse
import collections
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
from openwakeword.vad import VAD


RATE = 16000
FRAME_SAMPLES = 1280
FRAME_SECONDS = FRAME_SAMPLES / RATE
FRAME_BYTES = FRAME_SAMPLES * 2


def run(cmd):
    return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


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


def write_wav(path, frames):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(b"".join(frames))


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


def timestamp():
    return time.strftime("%Y%m%d-%H%M%S")


def main():
    parser = argparse.ArgumentParser(description="Wake-word capture with pre-roll and VAD endpointing.")
    parser.add_argument("--model", default="hey_jarvis", help="openWakeWord model name")
    parser.add_argument("--device", default="plughw:CARD=Device,DEV=0", help="ALSA capture device")
    parser.add_argument("--wake-threshold", type=float, default=0.5, help="wake activation threshold")
    parser.add_argument("--vad-threshold", type=float, default=0.35, help="speech activity threshold")
    parser.add_argument("--pre-roll", type=float, default=5.0, help="seconds to keep before wake")
    parser.add_argument("--stop-silence", type=float, default=3.0, help="seconds of non-speech after speech before stopping")
    parser.add_argument("--post-roll", type=float, default=0.3, help="seconds to keep after endpoint")
    parser.add_argument("--leading-pad", type=float, default=1.0, help="seconds to preserve before first VAD speech")
    parser.add_argument("--no-trim-leading-silence", action="store_true", help="keep full pre-roll even if silent")
    parser.add_argument("--no-speech-timeout", type=float, default=5.0, help="stop if no post-wake speech begins")
    parser.add_argument("--max-utterance", type=float, default=20.0, help="maximum seconds captured after wake")
    parser.add_argument("--capture-dir", default="/tmp/wake-captures", help="directory for captured WAV files")
    parser.add_argument("--duration", type=float, default=0.0, help="seconds to run; 0 means forever")
    parser.add_argument("--scores", action="store_true", help="print wake/VAD scores once per second")
    parser.add_argument("--transcribe", action="store_true", help="send completed capture WAVs to Gemini")
    parser.add_argument("--transcriber", default="", help="path to transcription script; defaults to transcribe_gemini.py")
    args = parser.parse_args()

    run(["amixer", "-c", "0", "sset", "Mic", "16"])

    print("loading models...", flush=True)
    wake_model = Model(wakeword_models=[args.model], inference_framework="onnx")
    vad = VAD(n_threads=1)
    print(
        f"ready: model={args.model} wake_threshold={args.wake_threshold} "
        f"vad_threshold={args.vad_threshold} pre_roll={args.pre_roll}s",
        flush=True,
    )

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

    pre_roll_frames = max(1, int(round(args.pre_roll / FRAME_SECONDS)))
    post_roll_frames = max(0, int(round(args.post_roll / FRAME_SECONDS)))
    stop_silence_frames = max(1, int(round(args.stop_silence / FRAME_SECONDS)))
    no_speech_timeout_frames = max(1, int(round(args.no_speech_timeout / FRAME_SECONDS)))
    max_utterance_frames = max(1, int(round(args.max_utterance / FRAME_SECONDS)))
    leading_pad_frames = max(0, int(round(args.leading_pad / FRAME_SECONDS)))

    ring = collections.deque(maxlen=pre_roll_frames)
    vad_ring = collections.deque(maxlen=pre_roll_frames)
    capture_frames = []
    capture_vad_scores = []
    capturing = False
    speech_seen = False
    silence_frames = 0
    no_speech_frames = 0
    capture_started = 0.0
    last_detection = 0.0
    last_score_print = 0.0
    started = time.monotonic()
    capture_dir = Path(args.capture_dir)

    try:
        while not stop:
            if args.duration and time.monotonic() - started >= args.duration:
                break

            data = read_exact(arecord.stdout, FRAME_BYTES)
            if len(data) != FRAME_BYTES:
                err = arecord.stderr.read().decode("utf-8", errors="replace") if arecord.stderr else ""
                raise RuntimeError(f"arecord ended early: {err.strip()}")

            frame = np.frombuffer(data, dtype=np.int16)
            wake_predictions = wake_model.predict(frame)
            wake_label, wake_score = max(wake_predictions.items(), key=lambda item: float(item[1]))
            wake_score = float(wake_score)
            vad_score = float(vad.predict(frame, frame_size=640))
            now = time.monotonic()

            if args.scores and now - last_score_print >= 1.0:
                print(
                    f"score wake={wake_score:.3f} vad={vad_score:.3f} "
                    f"state={'capture' if capturing else 'listen'}",
                    flush=True,
                )
                last_score_print = now

            ring.append(data)
            vad_ring.append(vad_score)

            if not capturing:
                if wake_score >= args.wake_threshold and now - last_detection >= 2.0:
                    capturing = True
                    speech_seen = vad_score >= args.vad_threshold
                    silence_frames = 0
                    no_speech_frames = 0
                    capture_started = now
                    capture_frames = list(ring)
                    capture_vad_scores = list(vad_ring)
                    last_detection = now
                    print(
                        f"WAKE label={wake_label} wake={wake_score:.3f} vad={vad_score:.3f} "
                        f"pre_roll_frames={len(capture_frames)}",
                        flush=True,
                    )
                continue

            capture_frames.append(data)
            capture_vad_scores.append(vad_score)

            if vad_score >= args.vad_threshold:
                speech_seen = True
                silence_frames = 0
                no_speech_frames = 0
                post_roll_remaining = 0
            else:
                if speech_seen:
                    silence_frames += 1
                else:
                    no_speech_frames += 1

            should_finish = False
            reason = ""

            if speech_seen and silence_frames >= stop_silence_frames + post_roll_frames:
                should_finish = True
                reason = "silence"

            if not speech_seen and no_speech_frames >= no_speech_timeout_frames:
                should_finish = True
                reason = "no_speech"

            if len(capture_frames) - len(ring) >= max_utterance_frames:
                should_finish = True
                reason = "max_utterance"

            if should_finish:
                out = capture_dir / f"wake-capture-{timestamp()}.wav"
                output_frames = capture_frames
                trimmed_frames = 0
                if not args.no_trim_leading_silence:
                    output_frames, trimmed_frames = trim_leading_non_speech(
                        capture_frames,
                        capture_vad_scores,
                        args.vad_threshold,
                        leading_pad_frames,
                    )
                write_wav(out, output_frames)
                duration = len(output_frames) * FRAME_SECONDS
                print(
                    f"CAPTURE_DONE reason={reason} file={out} duration={duration:.2f}s "
                    f"speech_seen={speech_seen} trimmed_start={trimmed_frames * FRAME_SECONDS:.2f}s",
                    flush=True,
                )
                if args.transcribe:
                    script_dir = Path(__file__).resolve().parent
                    transcriber = Path(args.transcriber) if args.transcriber else script_dir / "transcribe_gemini.py"
                    result = subprocess.run(
                        [sys.executable, str(transcriber), str(out)],
                        cwd=str(script_dir),
                        text=True,
                        capture_output=True,
                    )
                    if result.returncode == 0:
                        print(f"TRANSCRIPT file={out}", flush=True)
                        print(result.stdout.strip(), flush=True)
                    else:
                        print(f"TRANSCRIPT_ERROR file={out}", flush=True)
                        print(result.stderr.strip(), flush=True)
                capturing = False
                speech_seen = False
                silence_frames = 0
                no_speech_frames = 0
                capture_frames = []
                capture_vad_scores = []
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
