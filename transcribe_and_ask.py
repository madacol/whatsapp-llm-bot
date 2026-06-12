#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path

import api_transport_client
import transcribe_gemini


def extract_transcript(raw_text):
    raw_text = raw_text.strip()
    if not raw_text:
        raise ValueError("transcriber returned empty text")
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return raw_text
    transcript = parsed.get("transcript")
    if isinstance(transcript, str) and transcript.strip():
        return transcript.strip()
    raise ValueError(f"transcriber JSON did not include transcript: {parsed}")


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio, send transcript to API transport, print assistant text.")
    parser.add_argument("audio", help="audio file to transcribe")
    parser.add_argument("--model", default=os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"))
    parser.add_argument("--json", action="store_true", help="print transcript and API response as JSON")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("GEMINI_API_KEY is not set")

    audio = Path(args.audio)
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
    response = api_transport_client.send_text_turn(transcript)

    if args.json:
        print(json.dumps({
            "transcript": transcript,
            "response": response,
        }, ensure_ascii=False, indent=2))
    else:
        print(response.get("text", "").strip() or json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
