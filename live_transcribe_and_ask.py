#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path

import api_transport_client
import transcribe_gemini
from transcribe_and_ask import extract_transcript


def main():
    parser = argparse.ArgumentParser(
        description="Transcribe captured audio, send it to the API transport, and print live-test labels."
    )
    parser.add_argument("audio", help="audio file to transcribe")
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"))
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is not set")

    audio = Path(args.audio)
    print(f"TRANSCRIBE_START file={audio}", flush=True)
    file_obj = transcribe_gemini.upload_file(audio, api_key)
    raw_transcript = transcribe_gemini.transcribe(
        file_obj,
        api_key,
        args.model,
        (
            "Transcribe the user's spoken command exactly. Return compact JSON with keys "
            '"transcript", "language", and "notes". Do not include markdown.'
        ),
    )
    transcript = extract_transcript(raw_transcript)
    print(f"TRANSCRIPT text={json.dumps(transcript, ensure_ascii=False)}", flush=True)

    print("SERVER_REQUEST_START", flush=True)
    response = api_transport_client.send_text_turn(transcript)
    response_text = response.get("text", "").strip()
    if response_text:
        print(f"SERVER_RESPONSE text={json.dumps(response_text, ensure_ascii=False)}", flush=True)
    else:
        print(f"SERVER_RESPONSE json={json.dumps(response, ensure_ascii=False)}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
