#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import api_transport_client


TOKEN = "smoke-token"


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
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "turnId": "turn-smoke",
            "requestId": body["requestId"],
            "status": "completed",
            "text": "Smoke response",
        }).encode("utf-8"))

    def log_message(self, _format, *_args):
        return


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{server.server_port}"
        response = api_transport_client.send_text_turn(
            "turn on the desk light",
            base_url=base_url,
            token=TOKEN,
            transport_id="voice",
            chat_id="api:client-1",
            sender_id="user-1",
            sender_name="User",
            request_id="smoke-request",
        )
        assert response["text"] == "Smoke response", response
        assert len(Handler.calls) == 1, Handler.calls
        call = Handler.calls[0]
        assert call["path"] == "/api/transports/voice/turns?wait=true", call
        assert call["auth"] == "Bearer smoke-token", call
        assert call["body"]["requestId"] == "smoke-request", call
        assert call["body"]["chatId"] == "api:client-1", call
        assert call["body"]["content"] == [{"type": "text", "text": "turn on the desk light"}], call
        assert call["body"]["facts"] == {
            "addressedToBot": True,
            "isGroup": False,
            "repliedToBot": False,
        }, call

        env = {
            **os.environ,
            "API_TRANSPORT_BASE_URL": base_url,
            "API_TRANSPORT_TOKEN": TOKEN,
            "API_TRANSPORT_ID": "voice",
            "API_TRANSPORT_CHAT_ID": "api:client-1",
            "API_TRANSPORT_SENDER_ID": "user-1",
            "API_TRANSPORT_SENDER_NAME": "User",
        }
        cli = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("api_transport_client.py")),
                "--request-id",
                "smoke-cli-request",
                "what time is it",
            ],
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )
        assert cli.stdout.strip() == "Smoke response", cli
        assert Handler.calls[1]["path"] == "/api/transports/voice/turns?wait=true", Handler.calls[1]
        assert Handler.calls[1]["body"]["requestId"] == "smoke-cli-request", Handler.calls[1]
        assert Handler.calls[1]["body"]["content"] == [{"type": "text", "text": "what time is it"}], Handler.calls[1]
    finally:
        server.shutdown()
        server.server_close()
    print("api_transport_client smoke test passed")


if __name__ == "__main__":
    main()
