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

## Resolution

Resolved by the completed thinking coalescing task in `tasks/done/thinking-message-coalescing.md` and commit `7482fe8`.

The repeated visible thought symptom was not downstream WhatsApp suppression or pinned-status duplication. The recorded examples showed separate internal thinking/progress traces stitched into one visible `Thought` message, making earlier thought headings appear again later in the same message.

Root cause:

- ACP reasoning delta assembly treated a fresh `Thinking...` boundary after non-placeholder reasoning as continuation text.
- Agent I/O reasoning state reused the existing finalized thought handle instead of starting a new visible thinking message for the next reasoning trace.

Owning layers:

- `harnesses/harness-runtime-event-dispatcher.js` owns ACP reasoning delta/snapshot assembly and completion synthesis.
- `conversation/build-agent-io-hooks.js` owns the runtime-reasoning-to-outbound handle lifecycle.

Evidence:

- `tasks/done/thinking-message-coalescing.md` records two captured user-visible examples.
- `tests/build-agent-io-hooks.test.js` includes `starts a new thinking message for a new reasoning trace after finalization`.
- `tests/harness-runtime-event-dispatcher.test.js` includes dispatcher coverage for explicit reasoning completion, delta synthesis, and snapshot deduplication.

## Verification

The original fix was verified in commit `7482fe8` with dispatcher and agent I/O regressions. No new production changes were needed for this closure.

## Status

Done.
