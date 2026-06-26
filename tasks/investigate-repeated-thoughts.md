# Investigate Repeated LLM Thoughts

## Context

- User note on 2026-06-24: "add to todo, that thoughts sometimes get repeated, why?"
- Nearby work touched ACP reasoning/thought handling, runtime event dispatch, pinned status updates, and WhatsApp presentation for runtime events.
- The exact repeated surface is not yet confirmed.

## Ambiguity

Plausible sources:

- ACP provider emits both delta chunks and later snapshot chunks for the same thought.
- Runtime coalescing in `harnesses/acp-runtime-model.js` or `harnesses/harness-runtime-event-dispatcher.js` fails for a specific thought shape.
- WhatsApp outbound edit/send state creates duplicate visible thought messages.
- Pinned status and standalone thought rendering both show the same content.

## Investigation

- Capture a real repeated-thought payload or reproduce with a fixture.
- Determine whether duplication exists in provider events, normalized runtime events, outbound events, or only rendered WhatsApp messages.
- Fix the owning layer instead of adding downstream suppression unless the provider legitimately emits duplicate snapshots.

## Acceptance

- Root cause identified with payload/event evidence.
- Repeated thought rendering is covered by a focused test at the relevant seam.
- Fix is verified with the focused test and the relevant runtime/WhatsApp regression tests.
