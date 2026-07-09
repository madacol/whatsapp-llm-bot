# Web Cancel, Clear, And Guardian Warning Suppression

## Task

Suppress Guardian approval-review warning text from assistant-message channels. Add web audio client controls for cancelling the active turn and clearing conversation history through the existing command paths.

## Evidence

- User asked to suppress Guardian warning messages because they should not be sent through assistant messages.
- User asked for a cancel button that cancels the turn like the bot currently does for command execution cancellation.
- User asked for a clear button that does the same thing as `/clear`.
- WhatsApp already has a renderer fallback that prefixes the latest tool/command message for Guardian approval review text, but ACP normalization still emitted that text as assistant output upstream.
- The web client had Start/Stop listening controls but no in-flight turn cancel or conversation clear controls.

## Acceptance Criteria

- Guardian approval-review text is not normalized as assistant output/content delta.
- Existing WhatsApp Guardian thumbs-up/thumbs-down prefix behavior is preserved.
- HTTP/web clients do not receive Guardian review text as assistant messages.
- Web client exposes a Cancel Turn button during an in-flight audio turn.
- Pressing Cancel Turn submits the existing `!c` command through the HTTP API and leaves normal backend cancellation ownership in the conversation command path.
- Web client exposes a Clear History button.
- Pressing Clear History submits the existing `/clear` command through the HTTP API and resets the visible web response placeholder.

## Completion Notes

- ACP Guardian approval-review chunks now normalize as `runtime.warning` events instead of assistant items.
- WhatsApp Guardian prefix handling now also recognizes the normalized runtime warning event, preserving the existing visible prefix behavior without sending warning text.
- The web audio client now tracks the active audio-turn request id, enables Cancel Turn only while a turn is active, and posts `!c` through `/api/transports/:id/turns?wait=true`.
- The web audio client now posts `/clear` through the same text turn endpoint and resets visible assistant text after the server accepts the command.
- Added a web client vertical-style harness covering streamed intermediate assistant messages, audio playback before turn completion, Cancel Turn, and Clear History.

## Verification

- `pnpm test tests/acp-events.test.js`
- `timeout 45s pnpm exec node --test --experimental-test-isolation=none --test-name-pattern Guardian tests/acp-payload-to-whatsapp.test.js`
- `pnpm test tests/web-audio-client-progress.test.js`
- `pnpm test tests/http-api-turn-intake.test.js tests/http-api-turn-flow.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
- `pnpm test tests/web-audio-client-server.test.js` with escalated local bind permission

## Residual Notes

- A full run of `tests/acp-payload-to-whatsapp.test.js` still hits the pre-existing `smoke-tests a real ACP mock process through adapter events into Baileys output` timeout in this environment. The Guardian subset passes when filtered directly through Node with the filter flag before the test file.
