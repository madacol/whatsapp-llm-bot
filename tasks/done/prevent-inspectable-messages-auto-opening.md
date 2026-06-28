# Prevent Inspectable Messages From Auto-Opening

Status: Done

## Subject

Fix the regression where inspectable reasoning/thinking and audio transcription messages reveal their full inspect detail automatically once results become available. They should stay in their compact visible form until the user explicitly reacts with the eye emoji.

## Evidence

Audio note: [664e56d02017cd206fe85f1dbb44901e12bb14b653166c5fa728ea0059733b9f.ogg](../.media/664e56d02017cd206fe85f1dbb44901e12bb14b653166c5fa728ea0059733b9f.ogg)

User report, 2026-06-28:

- Thinking/reasoning messages should start as a compact placeholder such as `thinking` or `Thinking...`; when the user reacts with `👁`, the bot edits that message to show full reasoning traces.
- Audio messages are automatically transcribed for model input, but the visible transcription should remain hidden until the user inspects the status with `👁`.
- Current behavior is that these inspectable messages are being inspected automatically as soon as the inspect data becomes available.
- User suspects the bot's own `👁` marker reaction may be routed back as an inspection request. Treat this as a hypothesis until a real payload or diagnostic proves the path.

Related completed work: [tasks/done/inspect-self-reaction-regression.md](done/inspect-self-reaction-regression.md) previously fixed one self-reaction path by preserving `fromMe` on reaction-message upserts. This report implies either that path regressed, another reaction shape is not covered, sender self-matching is insufficient in the observed chat, or a queued/deferred inspect handle is entering inspect display mode without a real user reaction.

## Owner Layer

Likely owner is the WhatsApp inspect/reaction presentation path, not media transcription quality or reasoning generation.

Relevant surfaces to inspect first:

- `whatsapp/outbound/send-content.js`: inspect state attachment, `👁` marker reaction, `displayMode`, and reaction subscription handling.
- `whatsapp/runtime/reaction-runtime.js`: normalized reaction dispatch and metadata.
- `whatsapp/outbound/queued-handles.js`: deferred `setInspect` behavior for messages whose handle is resolved later.
- `tests/create-whatsapp-transport.test.js`, `tests/sendBlocks.test.js`, `tests/acp-payload-to-whatsapp.test.js`, and `tests/conversation-runner-prompt-formatting.test.js` for reaction normalization, inspect reveal, reasoning, and transcription coverage.

## Constraints

- Work in `/home/mada/whatsapp-llm-bot` on `master`.
- Inspect a real reaction payload, log, trace, or diagnostic for the failing path before changing production behavior; do not design only from the suspected cause.
- Keep the `👁` marker as the discoverability signal for inspectable messages unless evidence shows it is fundamentally incompatible.
- Do not expose reasoning traces or audio transcriptions in the visible message before explicit user inspection.
- Preserve the intended behavior where a real user can react with `👁` before inspect data exists, and the detail appears once the data arrives.

## Acceptance Criteria

- Bot-authored `👁` marker echoes for reasoning/thinking and transcription messages are ignored, including the real payload shape observed for the regression.
- Attaching inspect data with `handle.setInspect` does not edit the visible message into inspect detail unless a real non-self user reaction already selected inspect mode.
- A real user `👁` reaction still edits the original message to the full inspect detail, both when inspect data already exists and when the user reacts before the data arrives.
- Regression coverage proves the failing WhatsApp entry path for at least one reasoning/thinking case and one audio transcription/status case, or records why one path cannot be reproduced with available fixtures.

## Next Action

Capture or inspect the latest outbound diagnostics/reaction normalization for an auto-opened inspectable thinking or transcription message, then add the smallest vertical regression that fails before the fix.

## Implementation Notes

- The available workspace diagnostics did not contain a persisted WhatsApp reaction record for the reported live auto-open. `.diagnostics/` only had enabled toggles, and `logs/codex-acp/app-server.log` contained ACP protocol traffic rather than WhatsApp reaction payloads.
- The closest existing real-shaped reaction fixture was the group `reactionMessage` upsert in `tests/create-whatsapp-transport.test.js`, which includes both a LID `participant` and phone `participantAlt`.
- The failing gap was that reaction normalization kept only one `senderId`. If a bot marker echo arrives with a primary LID sender and an alternate phone sender, the inspect handle cannot match the alternate id against `sock.user.id`, so it treats the bot marker as a user `👁` reaction.
- The fix preserves alternate reaction sender candidates as `senderIds` through the WhatsApp message-event classifier and reaction runtime. The outbound inspect filter now checks those candidates against socket self ids before entering inspect mode.
- `remoteJid` is used as a sender fallback only when no participant ids exist, because in group chats it is the chat id rather than a sender id.

## Verification

- Red proof: `pnpm test tests/sendBlocks.test.js --test-name-pattern "alternate sender id matches the bot"` failed in both the reasoning placeholder and audio transcription status cases because inspect output was edited into the visible message.
- Green proof: `pnpm test tests/sendBlocks.test.js --test-name-pattern "alternate sender id matches the bot|edits the original message to full plain-text inspect output after user|reveals inspect data attached after an earlier user"`
- Vertical green proof: `pnpm test tests/whatsapp-transport-scenarios.test.js`
- Green proof: `pnpm test tests/create-whatsapp-transport.test.js --test-name-pattern "reaction"`
- Support test: `pnpm test tests/conversation-runner-prompt-formatting.test.js --test-name-pattern "shows an inspectable transcribing status for audio live input"`
- Support test: `pnpm test tests/reaction-handler.test.js`
- Type-check: `pnpm type-check`
- Type-check: `pnpm type-check:tests`
- Full suite: `pnpm test` passed with 973 tests, 0 failures.

## Completion Notes

- Completed by preserving alternate reaction sender ids through the WhatsApp reaction normalization/runtime path and checking those ids in the outbound inspect self-filter.
- Added regressions for both reasoning/thinking placeholders and audio transcription status messages.
- Added scenario-runner vertical coverage for both reasoning/thinking placeholders and audio transcription status messages after the testing policy was clarified to require vertical proof for changes and bug fixes.
- Preserved explicit user inspection behavior, including reveal when inspect data already exists and reveal when a user reacted before inspect data arrived.
