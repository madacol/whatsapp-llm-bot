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
    post_started = threading.Event()
    post_release = threading.Event()
    stream_connected = threading.Event()

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
        if body.get("requestId") == "stream-request":
            Handler.post_started.set()
            if not Handler.post_release.wait(timeout=5):
                self.send_response(504)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "stream callback did not release POST"}).encode("utf-8"))
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

    def do_GET(self):
        if self.headers.get("authorization") != f"Bearer {TOKEN}":
            self.send_response(401)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Unauthorized"}).encode("utf-8"))
            return

        if self.path.startswith("/api/transports/voice/events?"):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"events": [{"eventId": "9"}]}).encode("utf-8"))
            return

        if self.path.startswith("/api/transports/voice/events/stream?"):
            Handler.stream_connected.set()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            self.wfile.flush()
            if not Handler.post_started.wait(timeout=5):
                self.wfile.write(
                    b'id: 99\n'
                    b'data: {"eventId":"99","turnId":"turn-smoke","chatId":"api:client-1","kind":"error","event":{"kind":"error","error":"POST did not start"}}\n\n'
                )
                self.wfile.flush()
                return
            events = [
                {
                    "eventId": "10",
                    "turnId": "turn-smoke",
                    "chatId": "api:client-1",
                    "kind": "content",
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "text", "text": "Thinking..."}],
                    },
                },
                {
                    "eventId": "11",
                    "turnId": "turn-smoke",
                    "chatId": "api:client-1",
                    "kind": "content",
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "Final "}],
                        "stream": {"id": "assistant-1", "status": "partial"},
                    },
                },
                {
                    "eventId": "12",
                    "turnId": "turn-smoke",
                    "chatId": "api:client-1",
                    "kind": "content",
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "answer "}],
                        "stream": {"id": "assistant-1", "status": "partial"},
                    },
                },
                {
                    "eventId": "13",
                    "turnId": "turn-smoke",
                    "chatId": "api:client-1",
                    "kind": "content",
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "Final answer from stream."}],
                        "stream": {"id": "assistant-1", "status": "final"},
                    },
                },
                {
                    "eventId": "14",
                    "turnId": "turn-smoke",
                    "chatId": "api:client-1",
                    "kind": "runtime_event",
                    "event": {
                        "kind": "runtime_event",
                        "event": {
                            "type": "turn.completed",
                            "turn": {"id": "api:client-1:test", "status": "completed"},
                        },
                    },
                },
            ]
            for event in events:
                self.wfile.write(f"id: {event['eventId']}\n".encode("utf-8"))
                self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                self.wfile.flush()
            return

        self.send_response(404)
        self.end_headers()

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

        streamed_events = []
        streamed_text = []
        response = api_transport_client.send_text_turn_streaming(
            "stream this response",
            base_url=base_url,
            token=TOKEN,
            transport_id="voice",
            chat_id="api:client-1",
            sender_id="user-1",
            sender_name="User",
            request_id="stream-request",
            timeout=5,
            on_event=streamed_events.append,
            on_assistant_text=lambda text, row: (
                streamed_text.append((text, row["eventId"])),
                Handler.post_release.set(),
            ),
        )
        assert response["status"] == "completed", response
        assert response["assistantText"] == "Final answer from stream.", response
        assert streamed_text == [("Final answer from stream.", "13")], streamed_text
        assert any(event.get("stage") == "events_cursor" for event in streamed_events), streamed_events
        assert any(event.get("stage") == "event_stream_open" for event in streamed_events), streamed_events
        assert any(event.get("stage") == "turn_submit_start" for event in streamed_events), streamed_events
        assert any(event.get("stage") == "turn_detected_from_stream" for event in streamed_events), streamed_events
        assert Handler.calls[2]["path"] == "/api/transports/voice/turns", Handler.calls[2]
        assert Handler.stream_connected.is_set(), "SSE stream should connect before POST can finish"

        chunked = {
            "events": [
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "Hel"}],
                        "stream": {"id": "assistant-chunk", "status": "partial"},
                    },
                },
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "lo "}],
                        "stream": {"id": "assistant-chunk", "status": "partial"},
                    },
                },
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "Hello world"}],
                        "stream": {"id": "assistant-chunk", "status": "final"},
                    },
                },
            ],
        }
        assert api_transport_client.extract_response_text(chunked) == "Hello world"

        polluted = {
            "text": "Thinking...\nThinking...\nAdded to the list.",
            "events": [
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "text", "text": "Thinking..."}],
                    },
                },
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "I am checking the list."}],
                        "stream": {"id": "assistant-1", "status": "final"},
                    },
                },
                {
                    "event": {
                        "kind": "content",
                        "source": "tool-result",
                        "content": "internal tool output",
                    },
                },
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "Added to the `supermercado` list:\n\n`bananas` x1"}],
                        "stream": {"id": "assistant-2", "status": "final"},
                    },
                },
                {
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "text", "text": "Non-markdown final status"}],
                        "stream": {"id": "assistant-3", "status": "final"},
                    },
                },
            ],
        }
        assert api_transport_client.extract_response_text(polluted) == "Added to the `supermercado` list:\n\n`bananas` x1"
        assert api_transport_client.extract_response_text({"text": "Thinking...\nThought"}) == ""

        fixture_dir = Path(__file__).with_name("fixtures") / "turn-events-20260612T183601Z"
        if fixture_dir.exists():
            fixture_response = json.loads((fixture_dir / "response.json").read_text())
            fixture_events = json.loads((fixture_dir / "existing-events.json").read_text())["events"]
            fixture_turn_id = fixture_response["turnId"]
            fixture_text = api_transport_client.extract_response_text({
                "text": fixture_response["text"],
                "events": [
                    event for event in fixture_events
                    if event.get("turnId") == fixture_turn_id
                ],
            })
            assert "Demo completed." in fixture_text, fixture_text
            assert "I’ll run a fresh safe demo pass." in fixture_text, fixture_text
            assert "Thinking..." not in fixture_text, fixture_text
            text_blocks = []
            for event_row in fixture_events:
                event = event_row.get("event", {})
                content = event.get("content")
                blocks = content if isinstance(content, list) else [content]
                text_blocks.extend(
                    block.get("text")
                    for block in blocks
                    if isinstance(block, dict) and block.get("type") == "text"
                )
            assert text_blocks, "fixture should include text blocks"
            assert set(text_blocks) == {"Thinking..."}, set(text_blocks)
    finally:
        server.shutdown()
        server.server_close()
    print("api_transport_client smoke test passed")


if __name__ == "__main__":
    main()
