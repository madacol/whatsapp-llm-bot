# WhatsApp Poll-Backed Select Primitive Regression

## Subject

Investigate and fix the shared WhatsApp poll-backed select primitive when poll votes appear in the WhatsApp UI but do not settle the pending selection.

## Evidence

- `!s show` sends the expected multi-select poll. Selecting "Show pinned tool status" increments the WhatsApp vote count, but no settings response is sent and the pending hourglass remains.
- `!setup` shows the same symptom. It uses the shared single-select primitive for setup steps, so the failure is not specific to the `show` setting or to multi-select state handling.
- The current installed Baileys `7.0.0-rc13` has its `pollUpdateMessage` to `messages.update` conversion commented out in `node_modules/@whiskeysockets/baileys/lib/Utils/process-message.js`.
- The previous fix commit `b13b1e3` added handling for synthetic `messages.update` poll updates, but the user reproduced the failure after restart. That path is probably not the live rc13 path.
- The screenshot chat is an announcement group (`only admins can send...`). Baileys poll creation has a special `toAnnouncementGroup` option that our select primitive does not set.
- The user reports `!setup` worked less than a week ago, making June 20 ingress/journal changes and later transport changes plausible regression boundaries in addition to the June 5 Baileys upgrade.

## Constraints

- Prove the live failing shape red before production edits when practical.
- Prefer tests at the WhatsApp transport boundary over tests that directly inject internal `{ pollMsgId, selectedOptions }` events.
- Preserve poll-backed select behavior for confirmations, single-select setup, and multi-select settings.
- Do not rely on Baileys README behavior when installed source contradicts it.

## Next Actions

- Identify the actual vote event shape for current Baileys rc13: raw `messages.upsert` with `pollUpdateMessage`, `messages.update`, or no bot-side event.
- Add regression coverage that sends a poll through the transport, then feeds the current Baileys-style vote event into the transport and expects the pending select to settle.
- Check announcement-group poll sending and add `toAnnouncementGroup: true` if needed.
- Fix the primitive at the boundary that fails, then run focused tests and `pnpm type-check`.

## Acceptance Criteria

- `!setup` poll selections settle and complete setup.
- `!s show` poll selections settle and send the settings update.
- Focused tests fail before the fix and pass after it.
- The final explanation names the regression boundary with evidence and explains why previous tests missed it.

## Completion Notes

- The live ingress journal proved the bot received the vote as a raw `messages.upsert` with `pollUpdateMessage`.
- The failing row carried a voter LID in `participant`, a phone-number JID in `participantAlt`, and a poll creation key with the bot's LID participant.
- Verification against the captured encrypted vote showed decryption only succeeds with bot LID + voter LID. The previous runtime fell back to the socket phone JID when `sock.user.lid` was absent, causing `Unsupported state or unable to authenticate data`.
- Updated the raw poll vote resolver to treat a LID in either the vote key or poll creation key as LID-addressed, and to derive the self creator JID from the poll creation key participant when the socket does not expose `user.lid`.
- Added a focused select-runtime regression from the captured encrypted vote and a transport-level regression for raw LID `messages.upsert` poll votes.

## Verification

- Red: `pnpm test tests/select-runtime.test.js --test-name-pattern 'decrypts raw LID poll votes'` failed with `Unsupported state or unable to authenticate data`.
- Green: `pnpm test tests/select-runtime.test.js --test-name-pattern 'decrypts raw LID poll votes'`.
- Green: `pnpm test tests/whatsapp-transport.test.js --test-name-pattern 'raw LID poll votes'`.
- Green: `pnpm test tests/select-runtime.test.js tests/create-whatsapp-transport.test.js tests/whatsapp-transport.test.js`.
- Green: `pnpm type-check`.
- Green: escalated `pnpm test --fast`, 915 tests passed.
