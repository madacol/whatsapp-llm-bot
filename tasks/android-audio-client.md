# Android Audio Client

## Subject

Turn the existing HTTP API transport voice client direction into an Android client that sends captured audio to `whatsapp-llm-bot` and receives assistant audio back, rather than doing client-side STT/TTS and exchanging text through the API.

## Current Evidence

- User request on 2026-06-24: "I want to turn that client into an Android app, and instead of sending text back and forth through API layer, I want to send audio back and forth".
- `clients/voice-pi/README.md` says the Pi client is a frontend for `http-api-transport.js`, and the intended next step is moving STT/TTS into `whatsapp-llm-bot` while clients keep wake/capture/upload/playback.
- `clients/voice-pi/api_transport_client.py` currently posts text payloads and extracts assistant text from event streams.
- `http-api-transport.js` currently accepts only one text content block through `POST /api/transports/:transportId/turns`.
- Shared types already include `AudioContentBlock`, and media-to-text support already knows how to transcribe audio blocks when configured.

## Ambiguity

- Android implementation target is not yet confirmed: native Kotlin/Gradle app, React Native, or a minimal prototype client.
- Audio exchange mode is not yet confirmed: complete clip upload/download, streaming input/output, or hybrid upload with streamed events.
- Server-side speech output owner is not yet confirmed: generated TTS artifact returned by this repo, existing provider output, or app-local TTS.
- Preferred audio formats, max duration, authentication, and LAN/public deployment shape are not yet confirmed.

## Proposed Direction

- Keep `http-api-transport.js` as the backend transport seam.
- Add an audio turn contract that accepts `AudioContentBlock` payloads using existing media block shapes.
- Store uploaded audio in `.media/` through `media-store.js` instead of keeping large base64 blobs in long-lived ledgers/events.
- Let existing media-to-text enrichment produce the transcript before the main run.
- Add a response audio surface after assistant text is finalized, so Android receives an audio media block or download URL to play.
- Build Android as a client under `clients/android/` after the server contract is pinned.

## Blocker

Choose the first implementation slice and transport mode before behavior-changing edits.

## Acceptance

- Android client can record a spoken user turn, submit it to the backend, and play assistant audio.
- Backend contract is covered by tests from HTTP submit through turn execution and response audio availability.
- Existing text-turn HTTP behavior remains supported unless explicitly removed.
- `pnpm type-check` and the relevant HTTP/media tests pass.
