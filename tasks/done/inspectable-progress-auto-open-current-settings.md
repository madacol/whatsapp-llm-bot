# Inspectable Progress Auto-Open Under Current Settings

Status: Done

## Subject

Fix the regression where reasoning trace and transcription inspect details appeared automatically after they became available. The visible `Thinking...` placeholder timing is correct and remained unchanged; only completed inspect details should remain hidden until an explicit user eye reaction.

## Evidence

User report, 2026-07-02:

- The user shared the current extras settings poll.
- Current visible settings are:
  - `Show pinned tool status`: off
  - `Show thinking`: off
  - `Hide file changes`: on
  - `Hide sub-agent output`: on
  - `Hide all extras`: off
- The user suspects these settings may be unrelated, but provided them as context.
- The observed bug is that reasoning traces and transcriptions are "being automatically inspected" and show immediately once available, possibly when the bot receives its self-reaction.
- Expected behavior: reasoning traces and transcriptions should not visibly expand unless the user explicitly inspects them.

User clarification, 2026-07-05:

- The issue is not the immediate visible `Thinking...` message.
- The completed thought/result and audio transcription inspect payload are being automatically shown.
- Expected behavior: completed inspect payloads wait for a real user `👁` reaction.
- Suspected owner: inspection/reaction logic.

Attached evidence:

- Settings screenshot: [1636c1d69a0d5ac02590140d85894652b2d8cfb84306b08544781535f2048745.jpg](../../.media/1636c1d69a0d5ac02590140d85894652b2d8cfb84306b08544781535f2048745.jpg)
- Clarifying screenshot: [9f15dbcfbdb15a3f0cb0c7bcf621a790e7334d4733da9b5f08da9c5680eb78e2.jpg](../../.media/9f15dbcfbdb15a3f0cb0c7bcf621a790e7334d4733da9b5f08da9c5680eb78e2.jpg)
- Voice note: [46c5b81b63945029f374a4372ceff8f0c1bb9dd3cc0f2d262339ada784247880.ogg](../../.media/46c5b81b63945029f374a4372ceff8f0c1bb9dd3cc0f2d262339ada784247880.ogg)

Related completed work:

- [prevent-inspectable-messages-auto-opening.md](prevent-inspectable-messages-auto-opening.md)
- [inspect-self-reaction-regression.md](inspect-self-reaction-regression.md)

## Root Cause

This was an uncovered variant of the prior inspectable-message auto-open bug, not a settings-display issue. The affected payload is inspect detail, not ordinary visible progress.

The failure mode is an inspect marker echo that reaches the reaction runtime with an ambiguous sender identity, such as the group/chat id instead of a participant id. The previous handler treated any non-self `👁` reaction as user intent, switched the message into inspect mode, and then auto-rendered completed inspect data.

## Fix

- Added reaction identity normalization shared by self checks and group ambiguity checks in `whatsapp/outbound/send-content.js`.
- Ignored group inspect reactions whose only sender identity is the group/chat container or `unknown`.
- Kept explicit user reactions working, including the case where the user reacts before inspect data is attached.
- Left the visible `Thinking...` placeholder behavior unchanged.

## Verification

- `pnpm exec node --test tests/sendBlocks.test.js`
- `pnpm exec node --test tests/vertical/whatsapp-inspect-reactions.test.js`
- `pnpm exec node --test tests/build-agent-io-hooks.test.js`
- `pnpm run type-check`
- `pnpm run type-check:tests`
- `git diff --check`
- `git diff -- conversation/build-agent-io-hooks.js http-api-transport-ledger.js tests/build-agent-io-hooks.test.js tests/acp-payload-to-whatsapp.test.js tests/http-api-transport-ledger.test.js`
