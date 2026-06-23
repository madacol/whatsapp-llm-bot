# Inspect Self-Reaction Regression

Status: Done

## Context

User report: inspectable messages are being inspected by default; likely the bot's own inspect marker reaction is not filtered.

## Notes

- Inspectable outbound handles add a `👁` reaction marker.
- The handle subscription already ignores reactions when `metadata.fromMe === true` or when the sender id matches the socket self id.
- Dedicated `messages.reaction` normalization preserves `fromMe`.
- Reaction-message upserts currently do not preserve `message.key.fromMe`, so a self-authored marker echo can arrive without `fromMe` and with a sender id that does not match the socket self id, especially in 1:1 chats.

## Acceptance

- Self-authored reaction-message upserts must preserve `fromMe: true`.
- Existing inspect handle filtering should then ignore the marker echo and leave the visible message uninspected until a real user reacts.

## Follow-up Check

- User noted a possible recent regression where `Thought` messages were not inspectable, then said they might be wrong.
- Existing hook coverage still proves completed reasoning updates the visible placeholder to `Thought` and attaches a `reasoning` inspect state with summary `*Thought*`.
- The ACP-to-WhatsApp vertical slice reached and passed the assertions that standalone `Thinking` messages get a `👁` marker and user reaction reveals `*Thought*` inspect text. The broader file-level command later hit the known slow ACP mock smoke-test hang, so that command is not counted as final verification.

## Outcome

- Preserved `message.key.fromMe` when normalizing reaction-message upserts.
- Updated reaction-message upsert tests so the normalized contract includes `fromMe` for both self and non-self upserts, matching the dedicated reaction event path.

## Verification

- Red: `pnpm test tests/create-whatsapp-transport.test.js --test-name-pattern "preserves fromMe on reaction-message upserts|extracts reaction-message upserts"` failed because `fromMe: true` was missing.
- Green: `pnpm test tests/create-whatsapp-transport.test.js --test-name-pattern "preserves fromMe on reaction-message upserts|extracts reaction-message upserts|classifies reaction-message upserts"`.
- Green: `pnpm test tests/sendBlocks.test.js --test-name-pattern "ignores inspect marker echoes flagged as fromMe|edits the original message to full plain-text inspect output after user"`.
- Green Thought inspectability check: `pnpm test tests/build-agent-io-hooks.test.js --test-name-pattern "sends one thinking placeholder and makes it inspectable|does not mark reasoning as Thought before inspect data exists|starts a new thinking message"`.
- `pnpm type-check`.
- `git diff --check`.
