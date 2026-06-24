# Merge voice assistant client

## Subject

Merge the standalone `voice-assistant` repository into `whatsapp-llm-bot` while preserving both Git histories. The Pi code is a frontend/client for the HTTP API transport backend, not a server-side transport by itself.

## Decisions

- Keep the Pi runtime as a separate process running on the Pi.
- Put Pi client code under `clients/voice-pi/`.
- Preserve `voice-assistant` Git history with an unrelated-history merge.
- Keep `http-api-transport.js` generic as the backend API transport.
- Future server work should move STT and TTS into `whatsapp-llm-bot`; Pi should keep wake detection, cue playback, capture, endpointing, upload, and local playback.
- A future Android client should be another frontend/client of the same HTTP API transport.

## Constraints

- Do not overwrite unrelated user changes.
- Do not commit secrets such as `.env`.
- `whatsapp-llm-bot` is currently far ahead of `origin/master`; local merge is okay, but pushing needs explicit awareness.

## Completion

- Fetched `voice-assistant/main`.
- Created an unrelated-history merge state with `voice-assistant/main` as the second parent.
- Imported tracked voice files under `clients/voice-pi/`.
- Added `clients/voice-pi/README.md` documenting the client/frontend role and transitional STT/TTS ownership.

## Verification

- Python syntax check for all imported `clients/voice-pi/*.py` files.
- `python3 test_live_transcribe_and_ask.py`
- `python3 test_api_transport_client.py`
- `python3 test_tts_openrouter.py`
- `pnpm type-check`
