# Simplify Pinned Transcription Presentation Model

## Status

Complete.

## Context

The pinned transcription implementation represented transcription status in two ways:

- normal compact/full transcription used a plain `app_message` with `presentationIntent: "transcription"`;
- pinned transcription used a dedicated `transcription_status` outbound event.

The user challenged this as an unnecessary transcription-specific special case. The desired model is to treat transcription like other categorized text output whose final transport presentation is decided by `outputVisibility`.

## Acceptance Criteria

- Remove the dedicated `transcription_status` outbound event.
- Remove `presentationIntent: "transcription"` in favor of a general category/status presentation marker on app messages.
- Keep current behavior for `transcription: hidden`, `indicatorInspectable`, `fullDetails`, and `pinnedIndicator`.
- Keep pinned middle assistant behavior unchanged.
- Update tests and archived task notes to reflect the simplified model.

## Completion Notes

- Replaced the dedicated transcription event with categorized app messages using `presentationCategory: "transcription"` and `presentationStatus`.
- Kept compact/full transcription on the existing reply handle and made pinned completion/failure send normal categorized app-message updates through the existing pinned-status renderer.
- Removed transcription-specific outbound rendering, queue-store validation, and inbound reply-option branches.
- Updated the previous pinned transcription task notes to describe the cleaned-up model.

## Verification

- `pnpm test tests/audio-transcription-output-visibility.test.js`
- `pnpm test tests/sendBlocks.test.js --test-name-pattern "transcription|middle assistant|pinned status|hidden"`
- `pnpm test tests/vertical/whatsapp-adapter-e2e.test.js --test-name-pattern "audio transcription|visibility"` with local-server permission for the mock LLM server.
- `pnpm test tests/whatsapp-outbound-durability.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
- `git diff --check`
