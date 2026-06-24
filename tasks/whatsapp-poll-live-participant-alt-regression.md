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
- After commit `83233ac`, a new manual `! restart` plus `!s show` repro created fresh journal rows at `2026-06-24 17:38 UTC`.
- The new poll creation row is bot-authored and contains the sent poll secret and poll options.
- The new poll vote row is still stuck in `received`, retrying the same Baileys GCM authentication failure, so the participantAlt candidate fix is incomplete.
- The new captured shape includes a bot-authored poll creation key with a LID participant, a vote key with a voter LID and a voter `participantAlt`, and a sent poll message that also carries a top-level bot device participant outside `message.key`.
- The next change must be driven by a replay test built from those captured rows, not another manual WhatsApp loop.
- Brute-forcing only identities present in the captured rows showed the live ciphertext decrypts with bot LID as poll creator and voter LID as voter, proving the failure was not missing author candidates.
- The captured sent poll secret shape was base64 text; existing tests only covered byte-valued `messageSecret`.
- Red proof: the new captured-shape select-runtime replay failed with the same `Unsupported state or unable to authenticate data` before production edits.
- Fix: normalize `messageContextInfo.messageSecret` from base64 text to bytes before deriving the Baileys poll vote key.
- Green proof: captured-shape select-runtime replay and transport-level `messages.upsert` selectMany replay now pass.

## Constraints

- Keep the journal row in `received` if all decrypt candidates fail; do not falsely acknowledge a vote that did not settle.
- Avoid committing live WhatsApp identifiers in tests or task notes.
- Sanitize any fixture derived from the captured journal rows while preserving the cryptographic author/key relationships needed to reproduce decrypt behavior.
- Preserve the raw LID/LID decrypt path that `57d1985` added.

## Acceptance Criteria

- Raw LID poll vote regression passes when the encrypted vote is bound to `participantAlt`.
- A replay test using the captured poll creation/vote payloads fails before production edits and passes after the fix.
- The full WhatsApp transport path settles a raw `messages.upsert.pollUpdateMessage` vote with LID plus participantAlt identity.
- Focused tests, type-check, and the relevant fast suite pass.
- The running bot is restarted or confirmed to reload the fix, and the stuck ingress rows drain or the remaining failure is identified.

## Verification

- `pnpm test tests/select-runtime.test.js --test-name-pattern "base64 text"`: red before the fix, green after.
- `pnpm test tests/select-runtime.test.js tests/whatsapp-transport.test.js`: passed.
- `pnpm type-check`: passed.
- Sandboxed `pnpm test --fast`: blocked by `listen EPERM` on localhost.
- Host-level `pnpm test --fast`: passed 918 tests.
- `pnpm run restart`: signal sent; host process remains on the pre-fix pid while this active Codex turn drains.
- The old `17:38 UTC` prompt timed out before the fix could be loaded, so that poll card is stale for user-visible acknowledgement.
