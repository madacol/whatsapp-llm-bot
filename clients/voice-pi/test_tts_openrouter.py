#!/usr/bin/env python3
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import tts_openrouter


TOKEN = "speech-token"
AUDIO = b"fake-audio-bytes"


class Handler(BaseHTTPRequestHandler):
    calls = []

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        Handler.calls.append({
            "path": self.path,
            "auth": self.headers.get("authorization"),
            "body": body,
        })
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            self.send_response(401)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
            return
        if self.path == "/audio/speech":
            self.send_response(200)
            self.send_header("content-type", "audio/pcm")
            self.end_headers()
            self.wfile.write(AUDIO)
            return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunk = {
            "choices": [
                {
                    "delta": {
                        "audio": {
                            "transcript": "smoke ok",
                            "data": "ZmFrZS1hdWRpby1ieXRlcw==",
                        }
                    }
                }
            ]
        }
        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, _format, *_args):
        return


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ.pop("OPENAI_API_KEY", None)
            os.environ["OPENROUTER_API_KEY"] = TOKEN
            out = Path(tmp) / "speech.mp3"
            result = tts_openrouter.synthesize_speech(
                "smoke ok",
                output_path=out,
                model="openai/gpt-audio-mini",
                voice="alloy",
                response_format="pcm16",
                base_url=f"http://127.0.0.1:{server.server_port}/chat/completions",
                provider="openrouter",
            )
            assert out.read_bytes() == AUDIO, result
            assert result["bytes"] == len(AUDIO), result
            assert result["content_type"] == "text/event-stream", result
            assert result["transcript"] == "smoke ok", result
            assert len(Handler.calls) == 1, Handler.calls
            call = Handler.calls[0]
            assert call["path"] == "/chat/completions", call
            assert call["auth"] == "Bearer speech-token", call
            assert call["body"]["model"] == "openai/gpt-audio-mini", call
            assert call["body"]["modalities"] == ["text", "audio"], call
            assert call["body"]["audio"] == {"voice": "alloy", "format": "pcm16"}, call
            assert call["body"]["stream"] is True, call
            assert call["body"]["messages"] == [
                {
                    "role": "system",
                    "content": "You are a text-to-speech renderer. Speak exactly the user-provided text and add no extra words.",
                },
                {"role": "user", "content": "smoke ok"},
            ], call

            Handler.calls.clear()
            os.environ["OPENAI_API_KEY"] = TOKEN
            out = Path(tmp) / "openai-speech.pcm"
            result = tts_openrouter.synthesize_speech(
                "smoke ok",
                output_path=out,
                model="gpt-4o-mini-tts",
                voice="marin",
                response_format="pcm",
                base_url=f"http://127.0.0.1:{server.server_port}/audio/speech",
                provider="openai",
                instructions="Speak clearly.",
            )
            assert out.read_bytes() == AUDIO, result
            assert result["provider"] == "openai", result
            assert result["route"] == "speech", result
            assert len(Handler.calls) == 1, Handler.calls
            call = Handler.calls[0]
            assert call["path"] == "/audio/speech", call
            assert call["auth"] == "Bearer speech-token", call
            assert call["body"] == {
                "model": "gpt-4o-mini-tts",
                "input": "smoke ok",
                "voice": "marin",
                "response_format": "pcm",
                "speed": 1.0,
                "instructions": "Speak clearly.",
            }, call
    finally:
        server.shutdown()
        server.server_close()
    print("tts_openrouter smoke test passed")


if __name__ == "__main__":
    main()
