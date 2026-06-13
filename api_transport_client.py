#!/usr/bin/env python3
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:3200"


def env(name, default):
    value = os.environ.get(name)
    return value if value else default


def normalize_base_url(value):
    return value.rstrip("/")


def build_turn_payload(text, request_id, chat_id, sender_id, sender_name):
    return {
        "requestId": request_id,
        "chatId": chat_id,
        "senderIds": [sender_id],
        "senderName": sender_name,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "content": [{"type": "text", "text": text}],
        "facts": {
            "addressedToBot": True,
            "isGroup": False,
            "repliedToBot": False,
        },
    }


def content_text(content, *, strip=True):
    if isinstance(content, str):
        return content.strip() if strip else content
    blocks = content if isinstance(content, list) else [content]
    parts = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") not in ("markdown", "text"):
            continue
        value = block.get("text") or block.get("markdown")
        if isinstance(value, str) and value.strip():
            parts.append(value.strip() if strip else value)
    return "\n\n".join(parts)


def content_types(content):
    if isinstance(content, str):
        return ["text"]
    blocks = content if isinstance(content, list) else [content]
    return [
        block.get("type")
        for block in blocks
        if isinstance(block, dict) and isinstance(block.get("type"), str)
    ]


def is_progress_text(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return bool(lines) and all(line in ("Thinking...", "Thought") for line in lines)


def extract_assistant_text_from_events(response):
    events = response.get("events") if isinstance(response, dict) else None
    if not isinstance(events, list):
        return ""

    buffer = AssistantMessageBuffer()
    completed_markdown_parts = []
    completed_parts = []
    fallback_parts = []
    for row in events:
        if not isinstance(row, dict):
            continue
        event = row.get("event")
        if not isinstance(event, dict):
            event = row
        if event.get("kind") != "content" or event.get("source") != "llm":
            continue
        content = event.get("content")
        text = content_text(content)
        if not text or is_progress_text(text):
            continue
        stream = event.get("stream")
        if isinstance(stream, dict) and stream.get("status") == "final":
            completed = buffer.complete_text_from_event(row)
            if completed:
                if "markdown" in content_types(content):
                    completed_markdown_parts.append(completed)
                completed_parts.append(completed)
        elif isinstance(stream, dict):
            buffer.complete_text_from_event(row)
        else:
            fallback_parts.append(text)

    if completed_markdown_parts:
        return completed_markdown_parts[-1]
    if completed_parts:
        return completed_parts[-1]
    if fallback_parts:
        return fallback_parts[-1]
    return ""


def extract_response_text(response):
    if not isinstance(response, dict):
        return ""

    assistant_text = response.get("assistantText")
    if isinstance(assistant_text, str) and assistant_text.strip():
        return assistant_text.strip()

    event_text = extract_assistant_text_from_events(response)
    if event_text:
        return event_text

    for key in ("markdown", "text"):
        value = response.get(key)
        if isinstance(value, str) and value.strip():
            cleaned = "\n".join(
                line for line in value.splitlines()
                if line.strip() and not is_progress_text(line)
            ).strip()
            return cleaned

    content = response.get("content")
    if isinstance(content, list):
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") not in ("markdown", "text"):
                continue
            value = item.get("markdown") if item.get("type") == "markdown" else item.get("text")
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
        if parts:
            return "\n\n".join(parts)

    events = response.get("events")
    if isinstance(events, list):
        parts = []
        for event in events:
            if not isinstance(event, dict):
                continue
            event_type = event.get("type")
            if event_type not in ("markdown", "text", "message"):
                continue
            value = event.get("markdown") or event.get("text")
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
        if parts:
            return "\n\n".join(parts)

    return ""


def post_json(url, payload, token, timeout):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"error": body}
        return exc.code, parsed


def get_json(url, token, timeout):
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"error": body}
        return exc.code, parsed


def fetch_turn_events(base_url, transport_id, chat_id, token, timeout):
    encoded_transport = urllib.parse.quote(transport_id, safe="")
    encoded_chat = urllib.parse.quote(chat_id, safe="")
    url = f"{base_url}/api/transports/{encoded_transport}/events?chatId={encoded_chat}&after=0"
    status, body = get_json(url, token, timeout)
    if status >= 400 or not isinstance(body, dict):
        return []
    events = body.get("events")
    return events if isinstance(events, list) else []


def event_id_value(event):
    if not isinstance(event, dict):
        return None
    try:
        return int(event.get("eventId"))
    except (TypeError, ValueError):
        return None


def latest_event_id(events):
    ids = [event_id_value(event) for event in events if isinstance(event, dict)]
    ids = [event_id for event_id in ids if event_id is not None]
    return max(ids) if ids else 0


def stream_events(base_url, transport_id, chat_id, token, after, timeout, on_open=None):
    encoded_transport = urllib.parse.quote(transport_id, safe="")
    encoded_chat = urllib.parse.quote(chat_id, safe="")
    url = (
        f"{base_url}/api/transports/{encoded_transport}/events/stream"
        f"?chatId={encoded_chat}&after={after}"
    )
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        if on_open:
            on_open()
        event_id = None
        data_lines = []
        for raw in response:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                if data_lines:
                    data = "\n".join(data_lines)
                    try:
                        payload = json.loads(data)
                    except json.JSONDecodeError:
                        payload = {"eventId": event_id, "malformed": data}
                    if event_id is not None and isinstance(payload, dict) and "eventId" not in payload:
                        payload["eventId"] = event_id
                    yield payload
                event_id = None
                data_lines = []
                continue
            if line.startswith("id:"):
                event_id = line.removeprefix("id:").strip()
            elif line.startswith("data:"):
                data_lines.append(line.removeprefix("data:").strip())


def event_body(row):
    if not isinstance(row, dict):
        return {}
    event = row.get("event")
    return event if isinstance(event, dict) else row


def event_content_text(row):
    event = event_body(row)
    if event.get("kind") != "content" or event.get("source") != "llm":
        return ""
    text = content_text(event.get("content"))
    if not text or is_progress_text(text):
        return ""
    stream = event.get("stream")
    if not isinstance(stream, dict) or stream.get("status") != "final":
        return ""
    return text


class AssistantMessageBuffer:
    def __init__(self):
        self.parts_by_stream_id = {}

    def complete_text_from_event(self, row):
        event = event_body(row)
        if event.get("kind") != "content" or event.get("source") != "llm":
            return ""

        text = content_text(event.get("content"), strip=False)
        if text and is_progress_text(text):
            return ""

        stream = event.get("stream")
        if not isinstance(stream, dict):
            return text.strip()

        stream_id = stream.get("id")
        stream_status = stream.get("status")
        if not isinstance(stream_id, str) or not stream_id:
            return text.strip() if stream_status == "final" else ""

        if stream_status != "final":
            if text:
                self.parts_by_stream_id.setdefault(stream_id, []).append(text)
            return ""

        partial_text = "".join(self.parts_by_stream_id.pop(stream_id, []))
        if not partial_text:
            return text.strip()
        if not text:
            return partial_text.strip()

        partial_text = partial_text.strip()
        final_text = text.strip()
        if final_text.startswith(partial_text) or partial_text in final_text:
            return final_text
        return f"{partial_text}{final_text}".strip()


def is_turn_done_event(row):
    event = event_body(row)
    if event.get("kind") != "runtime_event":
        return None
    runtime = event.get("event")
    if not isinstance(runtime, dict):
        return None
    event_type = runtime.get("type")
    if event_type in ("turn.completed", "turn.failed", "turn.cancelled"):
        turn = runtime.get("turn")
        status = turn.get("status") if isinstance(turn, dict) else None
        return status or event_type.removeprefix("turn.")
    return None


def send_text_turn_streaming(
    text,
    *,
    base_url=None,
    token=None,
    transport_id=None,
    chat_id=None,
    sender_id=None,
    sender_name=None,
    request_id=None,
    timeout=300,
    on_event=None,
    on_assistant_text=None,
):
    text = text.strip()
    if not text:
        raise ValueError("text is empty")

    base_url = normalize_base_url(base_url or env("API_TRANSPORT_BASE_URL", DEFAULT_BASE_URL))
    transport_id = transport_id or env("API_TRANSPORT_ID", "voice")
    chat_id = chat_id or env("API_TRANSPORT_CHAT_ID", "api:client-1")
    sender_id = sender_id or env("API_TRANSPORT_SENDER_ID", "user-1")
    sender_name = sender_name or env("API_TRANSPORT_SENDER_NAME", "User")
    token = token if token is not None else os.environ.get("API_TRANSPORT_TOKEN", "")
    request_id = request_id or f"voice-{int(time.time() * 1000)}"

    existing_events = fetch_turn_events(base_url, transport_id, chat_id, token, timeout)
    after = latest_event_id(existing_events)
    if on_event:
        on_event({"kind": "client", "stage": "events_cursor", "after": after})

    encoded_transport = urllib.parse.quote(transport_id, safe="")
    url = f"{base_url}/api/transports/{encoded_transport}/turns"
    payload = build_turn_payload(text, request_id, chat_id, sender_id, sender_name)
    post_result = {"done": False, "status": None, "body": None, "error": None}
    post_done = threading.Event()

    def post_worker():
        try:
            status, body = post_json(url, payload, token, timeout)
            post_result.update({"done": True, "status": status, "body": body})
        except Exception as exc:
            post_result.update({"done": True, "error": exc})
        finally:
            post_done.set()

    def start_post_after_stream_open():
        if on_event:
            on_event({"kind": "client", "stage": "event_stream_open", "after": after})
            on_event({"kind": "client", "stage": "turn_submit_start", "requestId": request_id})
        threading.Thread(target=post_worker, name="api-transport-submit", daemon=True).start()

    target_turn_id = None
    final_status = None
    assistant_parts = []
    seen_final_ids = set()
    message_buffer = AssistantMessageBuffer()
    try:
        for row in stream_events(
            base_url,
            transport_id,
            chat_id,
            token,
            after,
            timeout,
            on_open=start_post_after_stream_open,
        ):
            body = post_result.get("body")
            if target_turn_id is None and isinstance(body, dict) and body.get("turnId"):
                target_turn_id = body["turnId"]
                if on_event:
                    on_event({
                        "kind": "client",
                        "stage": "turn_submitted",
                        "turnId": target_turn_id,
                        "requestId": body.get("requestId") or request_id,
                        "after": after,
                    })

            if not isinstance(row, dict):
                continue
            row_turn_id = row.get("turnId")
            if target_turn_id is None and row_turn_id:
                target_turn_id = row_turn_id
                if on_event:
                    on_event({
                        "kind": "client",
                        "stage": "turn_detected_from_stream",
                        "turnId": target_turn_id,
                        "requestId": request_id,
                        "after": after,
                    })
            if target_turn_id is None or row_turn_id != target_turn_id:
                continue

            if on_event:
                on_event(row)
            text_part = message_buffer.complete_text_from_event(row)
            if text_part:
                marker = (
                    row.get("eventId"),
                    event_body(row).get("stream", {}).get("id")
                    if isinstance(event_body(row).get("stream"), dict)
                    else None,
                )
                if marker not in seen_final_ids:
                    seen_final_ids.add(marker)
                    assistant_parts.append(text_part)
                    if on_assistant_text:
                        on_assistant_text(text_part, row)
            status = is_turn_done_event(row)
            if status:
                final_status = status
                if not isinstance(body, dict):
                    body = {}
                body["status"] = status
                break
    except (TimeoutError, socket.timeout, urllib.error.URLError) as exc:
        raise RuntimeError(
            f"API transport event stream timed out or failed "
            f"after request {request_id}: {exc}"
        ) from exc

    post_done.wait(timeout=2)
    if post_result.get("error"):
        raise post_result["error"]
    status = post_result.get("status")
    body = post_result.get("body")
    if status is not None and status >= 400:
        error = body.get("error") if isinstance(body, dict) else None
        raise RuntimeError(f"API transport request failed with HTTP {status}: {error or body}")
    if not isinstance(body, dict):
        body = {}
    if target_turn_id and not body.get("turnId"):
        body["turnId"] = target_turn_id
    if final_status:
        body["status"] = final_status
    body.setdefault("requestId", request_id)

    if assistant_parts:
        body["assistantText"] = assistant_parts[-1]
        body["assistantTexts"] = assistant_parts
    return body


def send_text_turn(
    text,
    *,
    base_url=None,
    token=None,
    transport_id=None,
    chat_id=None,
    sender_id=None,
    sender_name=None,
    request_id=None,
    wait=True,
    timeout=120,
):
    text = text.strip()
    if not text:
        raise ValueError("text is empty")

    base_url = normalize_base_url(base_url or env("API_TRANSPORT_BASE_URL", DEFAULT_BASE_URL))
    transport_id = transport_id or env("API_TRANSPORT_ID", "voice")
    chat_id = chat_id or env("API_TRANSPORT_CHAT_ID", "api:client-1")
    sender_id = sender_id or env("API_TRANSPORT_SENDER_ID", "user-1")
    sender_name = sender_name or env("API_TRANSPORT_SENDER_NAME", "User")
    token = token if token is not None else os.environ.get("API_TRANSPORT_TOKEN", "")
    request_id = request_id or f"voice-{int(time.time() * 1000)}"

    encoded_transport = urllib.parse.quote(transport_id, safe="")
    query = "?wait=true" if wait else ""
    url = f"{base_url}/api/transports/{encoded_transport}/turns{query}"
    payload = build_turn_payload(text, request_id, chat_id, sender_id, sender_name)
    status, body = post_json(url, payload, token, timeout)

    if status >= 400:
        error = body.get("error") if isinstance(body, dict) else None
        raise RuntimeError(f"API transport request failed with HTTP {status}: {error or body}")

    if wait and isinstance(body, dict) and body.get("turnId"):
        events = fetch_turn_events(base_url, transport_id, chat_id, token, timeout)
        turn_events = [event for event in events if isinstance(event, dict) and event.get("turnId") == body.get("turnId")]
        if turn_events:
            body["events"] = turn_events
            assistant_text = extract_assistant_text_from_events(body)
            if assistant_text:
                body["assistantText"] = assistant_text

    return body


def main():
    parser = argparse.ArgumentParser(description="Send text to the whatsapp-llm-bot API transport.")
    parser.add_argument("text", nargs="*", help="text to send; reads stdin if omitted")
    parser.add_argument("--base-url", default=None, help="defaults to API_TRANSPORT_BASE_URL or http://127.0.0.1:3200")
    parser.add_argument("--token", default=None, help="defaults to API_TRANSPORT_TOKEN")
    parser.add_argument("--transport-id", default=None, help="defaults to API_TRANSPORT_ID or voice")
    parser.add_argument("--chat-id", default=None, help="defaults to API_TRANSPORT_CHAT_ID or api:client-1")
    parser.add_argument("--sender-id", default=None, help="defaults to API_TRANSPORT_SENDER_ID or user-1")
    parser.add_argument("--sender-name", default=None, help="defaults to API_TRANSPORT_SENDER_NAME or User")
    parser.add_argument("--request-id", default=None)
    parser.add_argument("--no-wait", action="store_true", help="submit only; do not wait for assistant text")
    parser.add_argument("--timeout", type=float, default=float(env("API_TRANSPORT_TIMEOUT", "120")))
    parser.add_argument("--json", action="store_true", help="print full JSON response")
    args = parser.parse_args()

    text = " ".join(args.text).strip() if args.text else sys.stdin.read().strip()
    response = send_text_turn(
        text,
        base_url=args.base_url,
        token=args.token,
        transport_id=args.transport_id,
        chat_id=args.chat_id,
        sender_id=args.sender_id,
        sender_name=args.sender_name,
        request_id=args.request_id,
        wait=not args.no_wait,
        timeout=args.timeout,
    )
    if args.json:
        print(json.dumps(response, ensure_ascii=False, indent=2))
    else:
        print(extract_response_text(response) or json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
