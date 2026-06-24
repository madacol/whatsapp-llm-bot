#!/usr/bin/env python3
import argparse
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path

import api_transport_client
import transcribe_gemini
import tts_openrouter
from transcribe_and_ask import extract_transcript


def log_client_event(started_at, stage, **fields):
    payload = {
        "stage": stage,
        "elapsed_ms": int((time.monotonic() - started_at) * 1000),
        **fields,
    }
    print(f"CLIENT_EVENT {json.dumps(payload, ensure_ascii=False, sort_keys=True)}", flush=True)


def event_summary(row):
    event = api_transport_client.event_body(row)
    summary = {
        "eventId": row.get("eventId") if isinstance(row, dict) else None,
        "kind": row.get("kind") if isinstance(row, dict) else event.get("kind"),
    }
    if event.get("kind") == "runtime_event":
        runtime = event.get("event")
        if isinstance(runtime, dict):
            summary["type"] = runtime.get("type")
            tool = runtime.get("tool")
            if isinstance(tool, dict):
                summary["tool"] = tool.get("name")
    elif event.get("kind") == "content":
        summary["source"] = event.get("source")
        summary["contentTypes"] = api_transport_client.content_types(event.get("content"))
        stream = event.get("stream")
        summary["streamStatus"] = stream.get("status") if isinstance(stream, dict) else None
        text = api_transport_client.content_text(event.get("content"))
        summary["progress"] = api_transport_client.is_progress_text(text) if text else False
    return {key: value for key, value in summary.items() if value is not None}


def make_speaker_worker(args, work_queue, errors):
    def worker():
        while True:
            item = work_queue.get()
            try:
                if item is None:
                    return
                text, row = item
                event_id = row.get("eventId") if isinstance(row, dict) else None
                print(f"TTS_START eventId={event_id}", flush=True)
                audio = tts_openrouter.synthesize_speech(
                    text,
                    model=args.tts_model,
                    voice=args.tts_voice,
                    response_format=args.tts_format,
                    provider=args.tts_provider,
                    instructions=args.tts_instructions,
                )
                print(
                    f"TTS_AUDIO eventId={event_id} path={audio['path']} "
                    f"format={audio['format']} bytes={audio['bytes']}",
                    flush=True,
                )
                print(f"TTS_PLAY_START eventId={event_id}", flush=True)
                tts_openrouter.play_audio(audio["path"], audio["format"])
                print(f"TTS_PLAY_DONE eventId={event_id}", flush=True)
            except Exception as exc:
                errors.append(exc)
                print(f"TTS_ERROR error={json.dumps(str(exc), ensure_ascii=False)}", file=sys.stderr, flush=True)
            finally:
                work_queue.task_done()

    return worker


def main():
    started_at = time.monotonic()
    parser = argparse.ArgumentParser(
        description="Transcribe captured audio, send it to the API transport, and print live-test labels."
    )
    parser.add_argument("audio", help="audio file to transcribe")
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"))
    parser.add_argument("--no-speak", action="store_true", help="do not synthesize/play the assistant response")
    parser.add_argument("--tts-provider", default=None, choices=["openai", "openrouter"])
    parser.add_argument("--tts-format", default=None, choices=["mp3", "opus", "aac", "flac", "wav", "pcm", "pcm16"])
    parser.add_argument("--tts-voice", default=None)
    parser.add_argument("--tts-model", default=None)
    parser.add_argument("--tts-instructions", default=None)
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is not set")

    audio = Path(args.audio)
    log_client_event(started_at, "transcribe_start", file=str(audio), model=args.model)
    print(f"TRANSCRIBE_START file={audio}", flush=True)
    file_obj = transcribe_gemini.upload_file(audio, api_key)
    raw_transcript = transcribe_gemini.transcribe(
        file_obj,
        api_key,
        args.model,
        transcribe_gemini.DEFAULT_TRANSCRIPTION_PROMPT,
    )
    transcript = extract_transcript(raw_transcript)
    print(f"TRANSCRIPT text={json.dumps(transcript, ensure_ascii=False)}", flush=True)
    log_client_event(started_at, "transcribe_done", chars=len(transcript))

    speak_queue = None
    speaker_thread = None
    speaker_errors = []
    if not args.no_speak:
        speak_queue = queue.Queue()
        speaker_thread = threading.Thread(
            target=make_speaker_worker(args, speak_queue, speaker_errors),
            name="voice-assistant-tts",
            daemon=True,
        )
        speaker_thread.start()

    def on_event(row):
        if isinstance(row, dict) and row.get("kind") == "client":
            log_client_event(started_at, row.get("stage", "server_client_event"), **{
                key: value for key, value in row.items()
                if key not in ("kind", "stage")
            })
            return
        log_client_event(started_at, "server_event", **event_summary(row))

    def on_assistant_text(text, row):
        event_id = row.get("eventId") if isinstance(row, dict) else None
        print(
            f"SERVER_ASSISTANT eventId={event_id} text={json.dumps(text, ensure_ascii=False)}",
            flush=True,
        )
        if speak_queue is not None:
            speak_queue.put((text, row))

    log_client_event(started_at, "server_request_start")
    print("SERVER_REQUEST_START", flush=True)
    response = api_transport_client.send_text_turn_streaming(
        transcript,
        timeout=float(os.environ.get("API_TRANSPORT_TIMEOUT", "300")),
        on_event=on_event,
        on_assistant_text=on_assistant_text,
    )
    response_text = api_transport_client.extract_response_text(response)
    if response_text:
        print(f"SERVER_RESPONSE text={json.dumps(response_text, ensure_ascii=False)}", flush=True)
    else:
        print(f"SERVER_RESPONSE json={json.dumps(response, ensure_ascii=False)}", flush=True)

    if speak_queue is not None:
        speak_queue.put(None)
        speak_queue.join()
    if speaker_thread is not None:
        speaker_thread.join(timeout=1)
    if speaker_errors:
        raise RuntimeError(f"TTS failed: {speaker_errors[0]}")
    log_client_event(started_at, "done", status=response.get("status") if isinstance(response, dict) else None)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
