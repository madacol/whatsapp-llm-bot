#!/usr/bin/env python3
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech"
CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech"
DEFAULT_PROVIDER = "openai"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts"
DEFAULT_OPENROUTER_MODEL = "openai/gpt-audio-mini"
DEFAULT_VOICE = "marin"
DEFAULT_FORMAT = "pcm"
DEFAULT_PCM_RATE = 24000


def env(name, default):
    value = os.environ.get(name)
    return value if value else default


def default_output_path(response_format):
    out_dir = Path(env("TTS_OUTPUT_DIR", "/tmp/voice-assistant-tts"))
    out_dir.mkdir(parents=True, exist_ok=True)
    extension = "pcm" if response_format == "pcm16" else response_format
    return out_dir / f"tts-{time.strftime('%Y%m%d-%H%M%S')}.{extension}"


def api_key(provider):
    if provider == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set")
        return key

    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("LLM_API_KEY")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    return key


def request_headers(provider):
    headers = {
        "Authorization": f"Bearer {api_key(provider)}",
        "Content-Type": "application/json",
    }
    if provider == "openrouter":
        headers.update({
            "HTTP-Referer": env("OPENROUTER_HTTP_REFERER", "http://localhost/voice-assistant"),
            "X-Title": env("OPENROUTER_APP_TITLE", "voice-assistant"),
        })
    return headers


def speech_response_format(response_format):
    return "pcm" if response_format == "pcm16" else response_format


def synthesize_via_chat(text, output_path, model, voice, response_format, timeout, base_url):
    payload = {
        "model": model,
        "modalities": ["text", "audio"],
        "audio": {
            "voice": voice,
            "format": response_format,
        },
        "stream": True,
        "messages": [
            {
                "role": "system",
                "content": "You are a text-to-speech renderer. Speak exactly the user-provided text and add no extra words.",
            },
            {"role": "user", "content": text},
        ],
    }
    req = urllib.request.Request(
        base_url or env("OPENROUTER_CHAT_URL", CHAT_URL),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=request_headers("openrouter"),
    )
    audio_chunks = []
    transcript_parts = []
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get("content-type", "")
            for raw in response:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    break
                event = json.loads(data)
                choices = event.get("choices") if isinstance(event, dict) else None
                if not choices:
                    continue
                delta = choices[0].get("delta") if isinstance(choices[0], dict) else None
                audio = delta.get("audio") if isinstance(delta, dict) else None
                if not isinstance(audio, dict):
                    continue
                if isinstance(audio.get("transcript"), str):
                    transcript_parts.append(audio["transcript"])
                if isinstance(audio.get("data"), str):
                    audio_chunks.append(base64.b64decode(audio["data"]))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter audio chat failed with HTTP {exc.code}: {body}") from exc

    audio_bytes = b"".join(audio_chunks)
    if not audio_bytes:
        raise RuntimeError("OpenRouter audio chat returned empty audio")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(audio_bytes)
    return {
        "path": str(output_path),
        "bytes": len(audio_bytes),
        "content_type": content_type,
        "format": response_format,
        "model": model,
        "voice": voice,
        "transcript": "".join(transcript_parts).strip(),
        "route": "chat",
        "provider": "openrouter",
    }


def synthesize_via_openrouter_speech(text, output_path, model, voice, response_format, speed, timeout, base_url):
    speech_format = speech_response_format(response_format)
    payload = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": speech_format,
        "speed": speed,
    }
    req = urllib.request.Request(
        (base_url or env("OPENROUTER_SPEECH_URL", SPEECH_URL)).rstrip("/"),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=request_headers("openrouter"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            audio = response.read()
            content_type = response.headers.get("content-type", "")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter speech failed with HTTP {exc.code}: {body}") from exc

    if not audio:
        raise RuntimeError("OpenRouter speech returned empty audio")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(audio)
    return {
        "path": str(output_path),
        "bytes": len(audio),
        "content_type": content_type,
        "format": response_format,
        "model": model,
        "voice": voice,
        "route": "speech",
        "provider": "openrouter",
    }


def synthesize_via_openai_speech(text, output_path, model, voice, response_format, speed, timeout, base_url, instructions):
    speech_format = speech_response_format(response_format)
    payload = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": speech_format,
        "speed": speed,
    }
    if instructions:
        payload["instructions"] = instructions

    req = urllib.request.Request(
        (base_url or env("OPENAI_SPEECH_URL", OPENAI_SPEECH_URL)).rstrip("/"),
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=request_headers("openai"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            audio = response.read()
            content_type = response.headers.get("content-type", "")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI speech failed with HTTP {exc.code}: {body}") from exc

    if not audio:
        raise RuntimeError("OpenAI speech returned empty audio")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(audio)
    return {
        "path": str(output_path),
        "bytes": len(audio),
        "content_type": content_type,
        "format": response_format,
        "model": model,
        "voice": voice,
        "route": "speech",
        "provider": "openai",
    }


def synthesize_speech(
    text,
    *,
    output_path=None,
    model=None,
    voice=None,
    response_format=None,
    speed=None,
    timeout=120,
    base_url=None,
    route=None,
    provider=None,
    instructions=None,
):
    text = text.strip()
    if not text:
        raise ValueError("text is empty")

    provider = provider or env("TTS_PROVIDER", DEFAULT_PROVIDER)
    if provider not in ("openai", "openrouter"):
        raise ValueError(f"unsupported TTS_PROVIDER: {provider}")

    response_format = response_format or env("TTS_RESPONSE_FORMAT", DEFAULT_FORMAT)
    model_default = DEFAULT_OPENAI_MODEL if provider == "openai" else DEFAULT_OPENROUTER_MODEL
    model = model or env("TTS_MODEL", model_default)
    voice = voice or env("TTS_VOICE", DEFAULT_VOICE)
    speed = float(speed if speed is not None else env("TTS_SPEED", "1"))
    instructions = instructions if instructions is not None else os.environ.get("TTS_INSTRUCTIONS", "")
    output_path = Path(output_path) if output_path else default_output_path(response_format)
    route = route or env("TTS_ROUTE", "speech" if provider == "openai" else "chat")
    if provider == "openai" and route == "speech":
        return synthesize_via_openai_speech(
            text, output_path, model, voice, response_format, speed, timeout, base_url, instructions
        )
    if provider == "openrouter" and route == "chat":
        return synthesize_via_chat(text, output_path, model, voice, response_format, timeout, base_url)
    if provider == "openrouter" and route == "speech":
        return synthesize_via_openrouter_speech(text, output_path, model, voice, response_format, speed, timeout, base_url)
    raise ValueError(f"unsupported TTS route/provider combination: {provider}/{route}")


def play_audio(path, response_format, pcm_rate=None):
    path = Path(path)
    response_format = response_format.lower()
    if response_format in ("pcm", "pcm16"):
        rate = int(pcm_rate or env("TTS_PCM_RATE", str(DEFAULT_PCM_RATE)))
        device = env("TTS_PLAYBACK_DEVICE", "default")
        subprocess.run(["aplay", "-q", "-D", device, "-f", "S16_LE", "-r", str(rate), "-c", "1", str(path)], check=True)
        return
    players = [
        ["mpg123", "-q", str(path)],
        ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)],
        ["mpv", "--really-quiet", str(path)],
    ]
    for cmd in players:
        try:
            subprocess.run(cmd, check=True)
            return
        except FileNotFoundError:
            continue
    raise RuntimeError(f"no playback command found for {response_format}; saved audio at {path}")


def main():
    parser = argparse.ArgumentParser(description="Synthesize text to speech through OpenRouter.")
    parser.add_argument("text", nargs="*", help="text to speak; reads stdin if omitted")
    parser.add_argument("--output", default=None, help="output audio path")
    parser.add_argument("--provider", default=None, choices=["openai", "openrouter"], help="defaults to TTS_PROVIDER or openai")
    parser.add_argument("--model", default=None, help="defaults to TTS_MODEL or the provider default")
    parser.add_argument("--voice", default=None, help=f"defaults to TTS_VOICE or {DEFAULT_VOICE}")
    parser.add_argument("--format", default=None, choices=["mp3", "opus", "aac", "flac", "wav", "pcm", "pcm16"], help="defaults to TTS_RESPONSE_FORMAT or pcm")
    parser.add_argument("--speed", type=float, default=None)
    parser.add_argument("--instructions", default=None, help="optional speech style instructions")
    parser.add_argument("--timeout", type=float, default=float(env("TTS_TIMEOUT", "120")))
    parser.add_argument("--play", action="store_true", help="play after saving")
    parser.add_argument("--json", action="store_true", help="print metadata JSON")
    parser.add_argument("--route", default=None, choices=["chat", "speech"], help="defaults to TTS_ROUTE or chat")
    parser.add_argument("--base-url", default=None, help="override endpoint, used by tests")
    args = parser.parse_args()

    text = " ".join(args.text).strip() if args.text else sys.stdin.read().strip()
    result = synthesize_speech(
        text,
        output_path=args.output,
        model=args.model,
        voice=args.voice,
        response_format=args.format,
        speed=args.speed,
        timeout=args.timeout,
        base_url=args.base_url,
        route=args.route,
        provider=args.provider,
        instructions=args.instructions,
    )
    if args.play:
        play_audio(result["path"], result["format"])
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result["path"])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
