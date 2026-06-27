# Android Audio Client

## Subject

Turn the existing HTTP API transport voice client direction into an Android client that sends captured audio to `whatsapp-llm-bot` and receives assistant audio back, rather than doing client-side STT/TTS and exchanging text through the API.

## Current Evidence

- User request on 2026-06-24: "I want to turn that client into an Android app, and instead of sending text back and forth through API layer, I want to send audio back and forth".
- Follow-up clarification on 2026-06-24: replicate the current voice assistant functionality in an Android app, with the change that Android transmits audio directly to the API so the client stays as thin as possible.
- Follow-up clarification on 2026-06-24: also implement word detection, interpreted as wake-word / wake-phrase detection matching the existing Pi voice assistant flow.
- Follow-up clarification on 2026-06-24: openWakeWord was chosen for a Pi Zero constraint and was not reliable enough; prefer a better-quality open-source alternative for Android if available.
- `clients/voice-pi/openwakeword_always_on.py` and `clients/voice-pi/capture_after_wake.py` currently use openWakeWord for `hey_jarvis` detection, then VAD endpointing to capture the user's turn.
- `sherpa-onnx` is the preferred POC wake-word candidate: it is Apache-2.0, supports Android and Kotlin/Java APIs, includes keyword spotting, has an Android keyword spotting app, and supports custom keyword files.
- `clients/voice-pi/README.md` says the Pi client is a frontend for `http-api-transport.js`, and the intended next step is moving STT/TTS into `whatsapp-llm-bot` while clients keep wake/capture/upload/playback.
- `clients/voice-pi/api_transport_client.py` currently posts text payloads and extracts assistant text from event streams.
- `http-api-transport.js` currently accepts only one text content block through `POST /api/transports/:transportId/turns`.
- Shared types already include `AudioContentBlock`, and media-to-text support already knows how to transcribe audio blocks when configured.

## Ambiguity

- Audio exchange mode is not yet confirmed: complete clip upload/download, streaming input/output, or hybrid upload with streamed events.
- Preferred audio formats, max duration, authentication, and LAN/public deployment shape are not yet confirmed.
- Exact wake phrase and threshold tuning are not yet confirmed.

## Proposed Direction

- Keep `http-api-transport.js` as the backend transport seam.
- Add an audio turn contract that accepts `AudioContentBlock` payloads using existing media block shapes.
- Store uploaded audio in `.media/` through `media-store.js` instead of keeping large base64 blobs in long-lived ledgers/events.
- Let existing media-to-text enrichment produce the transcript before the main run.
- Add a response audio surface after assistant text is finalized, so Android receives an audio media block or download URL to play.
- Use the same provider-backed TTS direction already implemented in `clients/voice-pi/tts_openrouter.py`: default OpenAI speech with OpenRouter-compatible alternatives via env configuration, not local OS TTS.
- Build a native Android POC under `clients/android/` that owns wake phrase detection, recording, upload, and playback.
- Use `sherpa-onnx` keyword spotting on Android for wake detection rather than Android cloud speech recognition or openWakeWord.

## Current Status

Blocked. First implementation slice is a complete-clip POC: Android records a full utterance after wake-word detection, uploads the audio to the API, the backend runs the assistant flow and provider-backed TTS, and Android downloads/plays the returned audio.

Android SDK setup/build is blocked until disk space is increased. The target is at least 4 GB free, preferably 6 GB.

There is no recorded evidence that this task is blocked specifically by connecting the Android phone to the Pi. If the backend is running on the Pi, the Android device eventually needs network reachability to the bot API, but the durable blocker recorded here is local Android build/tooling capacity plus later physical-device APK testing.

## Progress

- Added backend raw audio turn API: `POST /api/transports/:transportId/audio-turns?wait=true` accepts `audio/*` request bodies with `x-request-id`, `x-chat-id`, sender headers, stores uploaded audio in `.media/`, and runs the normal turn handler with an `AudioContentBlock`.
- Added authenticated media download API: `GET /api/media/:mediaPath`.
- Added provider-backed HTTP API speech synthesis using the same OpenAI/OpenRouter direction as `clients/voice-pi/tts_openrouter.py`.
- Added a small Android source scaffold under `clients/android/` with manual record/send/playback against the audio-turn API.
- Added an explicit Android wake-word seam. The sherpa-onnx concrete detector still needs the Android KWS native libraries/assets and real-device testing.

## Verification

- `pnpm type-check`
- `pnpm exec node --test tests/http-api-transport.test.js`
- `pnpm test:fast` passed 911 tests.

## Remaining

- Install Android SDK/Gradle tooling on a machine with enough free disk.
- Vendor or fetch sherpa-onnx Android KWS assets/native libraries and replace the current placeholder detector.
- Build/install the APK on a physical Android device and verify microphone permission, audio upload, assistant audio playback, and wake-word behavior with `adb logcat`.

## Acceptance

- Android client can record a spoken user turn, submit it to the backend, and play assistant audio.
- Backend contract is covered by tests from HTTP submit through turn execution and response audio availability.
- Existing text-turn HTTP behavior remains supported unless explicitly removed.
- `pnpm type-check` and the relevant HTTP/media tests pass.
