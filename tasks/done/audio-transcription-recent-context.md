# Audio Transcription Recent Context

Status: Done

## Subject

Include recent user and assistant conversation context when asking the media-to-text model to transcribe incoming audio.

## Evidence

User asked whether audio transcription currently receives previous messages, then requested that transcription include the last 20 messages, covering both user and assistant messages.

## Changes

- Added a shared media-input context limit of 20 messages.
- `buildLiveInputText` now accepts context messages and forwards them to the media-to-text transcription request.
- `buildHarnessTurnInput` supplies the last 20 user/assistant messages before the current audio turn.
- Pending/live-input audio conversion also builds recent stored context before transcribing.

## Verification

- `pnpm test tests/live-input-text.test.js tests/build-harness-turn-input.test.js`
- `pnpm test tests/conversation-runner-prompt-formatting.test.js`
