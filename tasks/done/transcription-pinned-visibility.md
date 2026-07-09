# Pinned Transcription And Middle Assistant Visibility

## Status

Complete.

## Context

`chat-output-visibility.js` accepts `transcription: "pinnedIndicator"` and the compact preset uses it. The transcription observer in `conversation/create-conversation-runner.js` previously treated every non-hidden, non-full setting as compact inspectable output, so pinned transcription status was not routed through the WhatsApp pinned-status renderer.

The user also requested a new `middleAssistantMessages` pinned-status option, and wants the `minimal` preset to show middle assistant messages and transcription in pinned status instead of hiding both.

## Acceptance Criteria

- `transcription: "hidden"` continues to produce no transcription status messages while still feeding the transcript into the provider turn.
- `transcription: "indicatorInspectable"` continues to send a compact quoted transcription status with transcript inspect data.
- `transcription: "fullDetails"` continues to expose the transcript in the status message body.
- `transcription: "pinnedIndicator"` creates/updates a pinned WhatsApp status rather than a standalone quoted status message.
- `middleAssistantMessages: "pinned"` exists and sends streamed middle assistant updates to pinned status instead of standalone messages.
- The `minimal` show preset sets `transcription: "pinnedIndicator"` and `middleAssistantMessages: "pinned"`.
- The new behavior is covered at the observer seam, agent-output hook seam, WhatsApp outbound renderer seam, and stream durability seam.

## Verification Plan

- `pnpm test tests/audio-transcription-output-visibility.test.js`
- `pnpm test tests/build-agent-io-hooks.test.js --test-name-pattern "assistant stream|middle assistant"`
- `pnpm test tests/sendBlocks.test.js --test-name-pattern "transcription|middle assistant|pinned status|live visibility|hidden"`
- `pnpm test tests/whatsapp-outbound-durability.test.js`
- `pnpm test tests/vertical/whatsapp-adapter-e2e.test.js --test-name-pattern "audio transcription|visibility"`
- `pnpm type-check`
- `pnpm type-check:tests`
- `git diff --check`

## Completion Notes

- Added `middleAssistantMessages: "pinned"` to the show contract and made the minimal preset use pinned middle assistant messages plus pinned transcription.
- Routed transcription through categorized app messages for every visible mode, so the WhatsApp renderer decides whether the same text output is compact, full-detail, hidden, or pinned.
- Routed pinned transcription and streamed middle assistant output through the WhatsApp pinned-status renderer and suppressed their standalone messages in those modes.
- Kept normal visible middle assistant streams buffered until final, while pinned middle assistant streams now emit cumulative partial updates.

## Cleanup Notes

- Replaced the temporary dedicated pinned transcription event shape with general app-message presentation metadata: `presentationCategory: "transcription"` plus lifecycle `presentationStatus`.

## Verification

- `pnpm test tests/chat-output-visibility.test.js tests/chat-settings.test.js tests/audio-transcription-output-visibility.test.js tests/build-agent-io-hooks.test.js tests/sendBlocks.test.js tests/whatsapp-outbound-durability.test.js`
- `pnpm test tests/vertical/whatsapp-adapter-e2e.test.js --test-name-pattern "audio transcription|visibility"` failed in the sandbox with `listen EPERM` for `127.0.0.1`; reran with local-server permission and it passed.
- `pnpm test --test-name-pattern "buffers streamed LLM chunks" tests/whatsapp-transport.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
- `git diff --check`
