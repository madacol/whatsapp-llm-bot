# Remove Manual Recording Controls From Web Audio Client

## Status

Todo.

## Subject

Simplify the web audio client by removing the manual capture controls that were only useful for testing, especially the start-recording path.

## Evidence

The user said the frontend should remove the part of capturing audio, specifically the "Start Recording" flow. They still want the wake-word "Start Listening" flow and settings that are actually needed.

## Scope

- Remove the manual recording panel and controls, including start recording, stop/send, and discard actions if they are still present.
- Remove manual-capture-only client state, copy, and dead tests when safe.
- Keep the wake-word `Start Listening` flow.
- Keep relevant settings such as transport/chat/sender identity, wake phrase, threshold, max listen seconds, and silence settings unless later narrowed.
- Preserve the backend audio-turn flow used after wake-word capture.

## Non-Goals

- Do not remove wake-word listening, captured wake audio upload, assistant response playback, or diagnostics unless the implementation provides an intentional replacement.
- Do not redesign the whole client.

## Acceptance Criteria

- The visible web client no longer exposes manual start-recording controls.
- `Start Listening` still works for the wake-word flow.
- Focused web client verification passes.
- If deployed, the live page is refreshed with cache-busting as needed.
