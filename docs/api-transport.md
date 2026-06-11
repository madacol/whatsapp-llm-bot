# HTTP API Transport

The HTTP API transport lets a non-WhatsApp client submit text turns to the normal bot runtime and receive structured outbound events. It is intended for clients such as the Bluetooth voice assistant, where audio capture, transcription, and speech output live outside this repo.

The transport is disabled by default. It starts only when `API_TRANSPORT_TOKEN` is set.

## Configuration

Set these environment variables before starting `index.js`:

```bash
API_TRANSPORT_TOKEN=<shared bearer token>
API_TRANSPORT_HOST=127.0.0.1
API_TRANSPORT_PORT=3200
```

`API_TRANSPORT_HOST` defaults to `127.0.0.1`, and `API_TRANSPORT_PORT` defaults to `3200`. Do not expose this listener without authentication; every API endpoint except `/health` requires:

```http
Authorization: Bearer <shared bearer token>
```

## Submit A Text Turn

```http
POST /api/transports/:transportId/turns
Content-Type: application/json
Authorization: Bearer <token>
```

Body:

```json
{
  "requestId": "text-20260611-001",
  "chatId": "api:client-1",
  "senderIds": ["user-1"],
  "senderName": "User",
  "timestamp": "2026-06-11T00:00:00.000Z",
  "content": [
    { "type": "text", "text": "turn on the desk light" }
  ],
  "facts": {
    "addressedToBot": true,
    "isGroup": false,
    "repliedToBot": false
  }
}
```

Response:

```json
{
  "turnId": "server-generated-id",
  "requestId": "text-20260611-001",
  "status": "accepted"
}
```

`requestId` is idempotent per `transportId`. Retrying the same `requestId` returns the original `turnId` and does not invoke the bot again.

## Blocking Text Response

For the simplest text-to-text client, use:

```http
POST /api/transports/:transportId/turns?wait=true
```

The transport waits for the bot turn handler to finish and returns accumulated assistant text from `source: "llm"` content events:

```json
{
  "turnId": "server-generated-id",
  "requestId": "text-20260611-001",
  "status": "completed",
  "text": "Done."
}
```

## Get Turn Status

```http
GET /api/transports/:transportId/turns/:turnId
Authorization: Bearer <token>
```

Response:

```json
{
  "turnId": "server-generated-id",
  "requestId": "text-20260611-001",
  "chatId": "api:client-1",
  "status": "completed",
  "createdAt": "2026-06-11T00:00:00.000Z",
  "updatedAt": "2026-06-11T00:00:02.000Z"
}
```

Statuses currently reported are `accepted`, `running`, `completed`, `failed`, and `cancelled`.

## Poll Outbound Events

```http
GET /api/transports/:transportId/events?chatId=api%3Aclient-1&after=0
Authorization: Bearer <token>
```

Response:

```json
{
  "events": [
    {
      "eventId": "1",
      "turnId": "server-generated-id",
      "chatId": "api:client-1",
      "kind": "content",
      "event": {
        "kind": "content",
        "source": "llm",
        "content": "Done."
      }
    }
  ],
  "nextEventId": "1"
}
```

Events are raw `OutboundEvent` payloads. They are not rendered as WhatsApp text.

## Stream Outbound Events

```http
GET /api/transports/:transportId/events/stream?chatId=api%3Aclient-1&after=0
Authorization: Bearer <token>
Accept: text/event-stream
```

The stream uses Server-Sent Events. Each message uses the event id as the SSE `id` and the JSON event envelope as `data`.

Reconnect by passing either `after=<lastEventId>` or `Last-Event-ID`.

## MVP Scope

Implemented:

- text-only inbound turns;
- stable conversation identity through `chatId`;
- bearer token authentication;
- `requestId` idempotency;
- blocking text responses through `wait=true`;
- turn status lookup;
- raw outbound event polling and SSE streaming.

Deferred:

- media upload/download;
- prompt round trips for `select`, `selectMany`, and `confirm`;
- message update/collapse semantics beyond replacement events;
- per-client authorization policy beyond the shared bearer token;
- rate limiting.

## Correction

The API transport does not use the earlier first-pass route shape `POST /v1/chats/:chatId/messages`. The implemented and documented route shape follows the voice-assistant transport requirements:

```text
POST /api/transports/:transportId/turns
GET  /api/transports/:transportId/events
GET  /api/transports/:transportId/events/stream
GET  /api/transports/:transportId/turns/:turnId
```
