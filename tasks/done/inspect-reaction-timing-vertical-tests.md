# Inspect Reaction Timing Vertical Tests

Status: Done

## Subject

Harden the WhatsApp vertical inspect tests so they prove the user-facing timing contract: full reasoning and transcription detail appears only after a real user `👁` reaction, regardless of whether the reaction or detail arrives first.

## Evidence

User clarified the desired test intent on 2026-07-05:

- The concern is timing, not an abstract state table.
- The test should cover multiple common orderings.
- Completion timing alone must never reveal full thought/transcript detail.

Agreed timelines:

- Detail finishes without any user `👁`: compact message only.
- Non-user `👁` event arrives before detail finishes: compact message only after detail finishes.
- Real user `👁` arrives before detail finishes: reveal when detail finishes.
- Detail finishes before real user `👁`: compact until reaction, then reveal.
- Repeat the risky non-user-before-detail ordering for audio transcription.

## Changes

- Reworked `tests/vertical/whatsapp-inspect-reactions.test.js` into timeline-named vertical tests.
- Added delayed negative assertions so async/debounced inspect reveals cannot pass an immediate false check.
- Added `whatsappGroupOnlyReactionMessage` to the vertical testbed to simulate a reaction event that identifies only the group/chat, not a person.
- Preserved real-user reveal coverage for reasoning and transcription.

## Verification

- `pnpm test tests/vertical/whatsapp-inspect-reactions.test.js`
- `pnpm test tests/vertical/whatsapp-agent-user-case.test.js`
- `pnpm run type-check:tests`
- `pnpm run type-check`
- `git diff --check`
