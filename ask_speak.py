#!/usr/bin/env python3
import argparse
import json
import sys

import api_transport_client
import tts_openrouter


def main():
    parser = argparse.ArgumentParser(description="Ask the API transport, synthesize the assistant response, optionally play it.")
    parser.add_argument("text", nargs="*", help="prompt text; reads stdin if omitted")
    parser.add_argument("--request-id", default=None)
    parser.add_argument("--output", default=None, help="output audio path")
    parser.add_argument("--format", default=None, choices=["mp3", "pcm", "pcm16"])
    parser.add_argument("--voice", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--play", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    prompt = " ".join(args.text).strip() if args.text else sys.stdin.read().strip()
    response = api_transport_client.send_text_turn(prompt, request_id=args.request_id)
    assistant_text = response.get("text", "").strip()
    if not assistant_text:
        raise RuntimeError(f"assistant response did not include text: {response}")

    audio = tts_openrouter.synthesize_speech(
        assistant_text,
        output_path=args.output,
        model=args.model,
        voice=args.voice,
        response_format=args.format,
    )
    if args.play:
        tts_openrouter.play_audio(audio["path"], audio["format"])

    if args.json:
        print(json.dumps({
            "prompt": prompt,
            "text": assistant_text,
            "audio": audio,
        }, ensure_ascii=False, indent=2))
    else:
        print(assistant_text)
        print(audio["path"])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
