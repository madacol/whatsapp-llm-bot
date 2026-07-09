# Web Assistant Progress Vertical Test

## Task

Add regression coverage proving the web audio client renders intermediate assistant messages while an HTTP audio turn is still active, and plays each assistant audio block emitted for those messages.

## Evidence

- User challenged that backend event availability does not prove the frontend actually shows intermediate messages.
- User requested a vertical test from a mocked server response with multiple assistant messages through the frontend, including audio playback for each message because each assistant message should pass through TTS.
- Recent commits added backend per-message audio emission and frontend SSE consumption, but existing tests only proved backend event fanout and static server/proxy behavior.

## Completion

Added `tests/web-audio-client-progress.test.js`.

The test evaluates the real `clients/web/app.js` in a browser-like DOM harness, stubs only browser/server boundaries, and opens the app's `EventSource` path before the audio POST resolves.

- After emitting the first `assistant_output` text event and matching audio event, it asserts the first message is visible in `#assistant-text`, the first media URL was fetched, and `audio.play()` was called before the second assistant event is emitted.
- After emitting the second text/audio pair, it asserts the second message is appended, the second media URL was fetched, and `audio.play()` was called again.
- The POST remains unsettled during both checks, so the frontend cannot be passing by waiting for the final audio-turn response.
- The event stream is closed after final completion.

## Verification

- `pnpm test tests/web-audio-client-progress.test.js`
- `pnpm type-check:tests`
- `pnpm test tests/http-api-transport.test.js tests/http-api-turn-flow.test.js` with local listener permission
- `pnpm test tests/web-audio-client-server.test.js` with local listener permission

Attempted a combined focused run of HTTP, web static-server, and progress tests. HTTP and the new progress test passed in that combined run, but the static-server segment failed/hung there. The static-server file passed when isolated, so the combined-run issue was not treated as evidence against this regression.
