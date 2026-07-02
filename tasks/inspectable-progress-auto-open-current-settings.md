# Inspectable Progress Auto-Open Under Current Settings

Status: Todo

## Subject

Investigate and fix the current regression where reasoning trace and transcription inspect details appear automatically as soon as they become available. They should remain hidden/compact until an explicit user inspection action.

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

Attached evidence:

- Settings screenshot: [1636c1d69a0d5ac02590140d85894652b2d8cfb84306b08544781535f2048745.jpg](../.media/1636c1d69a0d5ac02590140d85894652b2d8cfb84306b08544781535f2048745.jpg)
- Clarifying screenshot: [9f15dbcfbdb15a3f0cb0c7bcf621a790e7334d4733da9b5f08da9c5680eb78e2.jpg](../.media/9f15dbcfbdb15a3f0cb0c7bcf621a790e7334d4733da9b5f08da9c5680eb78e2.jpg)
- Voice note: [46c5b81b63945029f374a4372ceff8f0c1bb9dd3cc0f2d262339ada784247880.ogg](../.media/46c5b81b63945029f374a4372ceff8f0c1bb9dd3cc0f2d262339ada784247880.ogg)

Related completed work:

- [prevent-inspectable-messages-auto-opening.md](done/prevent-inspectable-messages-auto-opening.md)
- [inspect-self-reaction-regression.md](done/inspect-self-reaction-regression.md)

## Current Understanding

This is probably a regression or uncovered variant of the prior inspectable-message auto-open bug, not a settings-display issue. The settings matter as evidence because `Show thinking` is off and the relevant output is still appearing.

The user's self-reaction hypothesis remains unproven. The next implementation pass must inspect a real payload, log, or diagnostic for the currently failing path before changing the reaction or inspect-state logic.

## Owner Layer

Likely owner is the WhatsApp inspect/reaction presentation path:

- `whatsapp/outbound/send-content.js` for inspect state, marker reaction handling, and display mode.
- `whatsapp/runtime/reaction-runtime.js` for normalized reaction dispatch.
- `whatsapp/outbound/queued-handles.js` for deferred inspect attachment.
- Settings surfaces for extra agent progress output visibility, if diagnostics show the settings layer now controls the affected output.

## Constraints

- Do not expose reasoning traces or audio transcriptions in visible chat until explicit user inspection.
- Preserve explicit user inspection behavior, including cases where the user reacts before inspect data exists.
- Do not assume the settings poll is causal without evidence.
- Inspect a real payload or diagnostic before production changes.

## Acceptance Criteria

- Reasoning trace inspect data remains compact/hidden when it becomes available unless the user explicitly inspects it.
- Audio transcription inspect data remains compact/hidden when it becomes available unless the user explicitly inspects it.
- Bot-authored marker reactions are ignored for the real currently observed payload shape.
- Current extras settings do not cause hidden reasoning or transcription details to auto-open.
- Regression coverage proves the failing path or records why it could not be reproduced from available fixtures.

## Next Action

Capture or inspect diagnostics for a current auto-open event, then add focused regressions for reasoning trace and transcription inspect detail visibility.
