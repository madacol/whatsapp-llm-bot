# Remove Inspect Output Truncation

## Subject

Stop truncating user-revealed inspect text in WhatsApp, including audio transcription inspect output.

## Evidence

- User clarified that inspected content should not be truncated by the bot because WhatsApp already handles long-message display.
- User specifically called out audio transcriptions and "basically anything that is inspected".
- Current code truncates inspect reveal text in `whatsapp/outbound/send-content.js` at 3,000 characters.
- Audio transcription status messages attach the full transcription as inspect text in `conversation/create-conversation-runner.js`, so long transcripts are affected by the same inspect reveal formatter.
- Existing test coverage currently asserts the old behavior in `tests/sendBlocks.test.js` with "truncates long plain-text inspect output after user eye reactions".

## Goal

When a user reveals inspect data, send/edit the full inspect text instead of inserting a bot-owned truncation marker.

## Non-Goals

- Do not change truncation/preview behavior for rendered code or diff image batches.
- Do not change pinned status line shortening.
- Do not change memory, title-generation, capture-policy, or provider-terminal byte caps.

## Acceptance Criteria

- Long plain-text inspect output is revealed in full after a user inspect reaction.
- Later inspect updates also persist the full text.
- Long audio transcription inspect output relies on the same full inspect reveal path.
- The old truncation test is run green before removal, then fails for the expected reason after production edits, and is updated to assert the new behavior.
- `pnpm type-check` and the relevant sendBlocks inspect tests pass.

## Completion Notes

- Removed the 3,000-character cap from WhatsApp inspect reveal formatting in `whatsapp/outbound/send-content.js`.
- Updated the long inspect regression in `tests/sendBlocks.test.js` to assert that inspect text over 10,000 characters is sent in full and remains full after later inspect updates.
- This covers long audio transcription reveal behavior because audio transcriptions are attached as text inspect payloads and use the same inspect reveal formatter.

## Verification

- Existing behavior green before removal: `pnpm test tests/sendBlocks.test.js --test-name-pattern "truncates long plain-text inspect output after"`.
- Red after production edit with old test: same command failed because `_… truncated (` was no longer present.
- Green after test update: `pnpm test tests/sendBlocks.test.js --test-name-pattern "reveals long plain-text inspect output in full|edits the original message to full plain-text inspect output after user"`.
- Green: `pnpm type-check`.

## Status

Done.
