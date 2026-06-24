#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path

import api_transport_client
import transcribe_gemini


def readable_transcription(value):
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, list):
        parts = [readable_transcription(item) for item in value]
        return "\n\n".join(part for part in parts if part)

    if isinstance(value, dict):
        transcript = value.get("transcript") or value.get("transcription") or value.get("text")
        description = value.get("description") or value.get("audio_description")
        notes = value.get("notes")

        if isinstance(transcript, str) and transcript.strip() and not description and not notes:
            return transcript.strip()

        parts = []
        if isinstance(transcript, str) and transcript.strip():
            parts.append(f"Transcription: {transcript.strip()}")
        if isinstance(description, str) and description.strip():
            parts.append(f"Description: {description.strip()}")
        if isinstance(notes, str) and notes.strip():
            parts.append(f"Notes: {notes.strip()}")
        if parts:
            return "\n\n".join(parts)

        return json.dumps(value, ensure_ascii=False)

    return ""


def extract_transcript(raw_text):
    raw_text = raw_text.strip()
    if not raw_text:
        raise ValueError("transcriber returned empty text")
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return raw_text
    transcript = readable_transcription(parsed)
    if transcript:
        return transcript
    raise ValueError(f"transcriber output did not include readable text: {parsed}")


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
        transcribe_gemini.DEFAULT_TRANSCRIPTION_PROMPT,
    )
    transcript = extract_transcript(raw_transcript)
    print(f"TRANSCRIPT {transcript}", flush=True)
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
