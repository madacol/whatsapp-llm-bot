# Remove Manual Recording Controls From Web Audio Client

## Status

Done.

## Subject

Simplify the web audio client by removing the manual capture controls that were only useful for testing, especially the start-recording path.

## Evidence

The user said the frontend should remove the part of capturing audio, specifically the "Start Recording" flow. They still want the wake-word "Start Listening" flow and settings that are actually needed.

## Completed Changes

- Removed the manual recording panel and controls from the browser UI.
- Removed manual-only client state, handlers, duration/readout rendering, and control toggles.
- Kept the wake-word `Start Listening` flow, wake settings, assistant playback, diagnostics, and backend audio-turn submission path.
- Updated the web audio README to describe wake capture as the active browser capture path.
- Updated the static-server test to assert that manual recording controls are absent.

## Verification

- `pnpm type-check`
- `pnpm exec node --test tests/web-audio-client-server.test.js`

The focused web-audio test needs local `127.0.0.1` listener access; the default sandbox blocked it with `listen EPERM`, so it was rerun with escalated local-network permission and passed.
