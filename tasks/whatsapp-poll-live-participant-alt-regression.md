# Live WhatsApp Poll ParticipantAlt Regression

## Subject

Investigate and fix live WhatsApp poll-backed select votes that still fail to settle after `57d1985`.

## Evidence

- The user retried `!setup` after `57d1985` and reported it still did not work.
- The durable ingress journal has fresh `messages.upsert` poll vote rows from `2026-06-24 16:57:25` through `16:57:33` stuck in `received`.
- Those rows retry with `Unsupported state or unable to authenticate data` from Baileys `decryptPollVote`, reached through `whatsapp/runtime/select-runtime.js`.
- The fresh vote payload shape still carries a voter LID in `participant`, a phone-number JID in `participantAlt`, and the bot LID in `pollCreationMessageKey.participant`.
- The live auth state includes both a bot phone JID and bot LID, so the earlier missing-`sock.user.lid` case does not explain this failure.
- Baileys rc13 `getKeyAuthor` prefers `participantAlt` before `participant`; the custom raw LID branch was still trying only the LID voter identity.

## Constraints

- Keep the journal row in `received` if all decrypt candidates fail; do not falsely acknowledge a vote that did not settle.
- Avoid committing live WhatsApp identifiers in tests or task notes.
- Preserve the raw LID/LID decrypt path that `57d1985` added.

## Acceptance Criteria

- Raw LID poll vote regression passes when the encrypted vote is bound to `participantAlt`.
- The full WhatsApp transport path settles a raw `messages.upsert.pollUpdateMessage` vote with LID plus participantAlt identity.
- Focused tests, type-check, and the relevant fast suite pass.
- The running bot is restarted or confirmed to reload the fix, and the stuck ingress rows drain or the remaining failure is identified.
