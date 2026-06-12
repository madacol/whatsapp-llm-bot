#!/usr/bin/env python3
import argparse
import json
import os
import sys
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
        print(response.get("text", "").strip() or json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
