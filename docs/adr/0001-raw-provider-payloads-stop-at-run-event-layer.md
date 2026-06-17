# ADR 0001: Raw Provider Payloads Stop At The Run Event Layer

## Status

Accepted.

## Context

Madabot currently speaks ACP through ACP adapters. ACP payloads contain provider-specific structure such as `session/update`, `rawInput`, `rawOutput`, `locations`, and provider metadata. Those fields are useful while interpreting provider activity, but they are not app-owned event semantics.

The target architecture has this flow:

```text
Transport -> Turn Orchestration -> Agent Runtime / ACP adapter -> Run Event layer -> Presentation
```

The ACP adapter speaks provider protocol. The Run Event layer interprets provider/runtime activity and emits canonical Run Events. Presentation renders canonical app events for concrete transports such as WhatsApp.

The current implementation still carries `raw` on runtime events in some places. That is migration debt. Examples observed today include WhatsApp reading raw ACP details to display read paths, line ranges, shell commands, and web actions, and runtime dispatch reading ACP metadata to suppress noisy terminal progress.

## Decision

Raw provider payloads are input to the Run Event layer only.

Canonical Run Events must not include raw provider payloads. App Messages and Presentation inputs must not include raw provider payloads either.

If any module downstream of the Run Event layer needs a provider-derived fact, the Run Event layer must expose that fact through a canonical Run Event field.

Raw payloads may be retained only in a diagnostic side channel such as raw-event logs or provider troubleshooting records. Those diagnostics must be keyed by canonical correlation IDs, such as event, turn, item, request, or provider reference IDs, rather than embedded in canonical events.

## Consequences

- Presentation must render from Run Events and App Messages, not from ACP/provider payload shape.
- The Run Event dispatcher must not branch on raw ACP metadata after normalization.
- Existing `raw` fields on runtime events are migration debt and should be removed in cleanup slices.
- Current WhatsApp raw ACP helpers should be replaced by canonical Run Event fields for tool display facts such as semantic kind, paths, line ranges, commands, web action details, and progress visibility.
- Diagnostic records can keep raw ACP/provider payloads for troubleshooting without making those payloads part of the Run Event interface.
- Tests should prove that downstream rendering and dispatch behavior follows canonical Run Event fields even when raw provider payloads are absent.
