# ADR 0001: Raw Provider Payloads Stop At The Agent Run Activity Layer

## Status

Accepted.

## Context

Madabot currently speaks ACP through ACP adapters. ACP payloads contain provider-specific structure such as `session/update`, `rawInput`, `rawOutput`, `locations`, and provider metadata. Those fields are useful while interpreting provider activity, but they are not app-owned event semantics.

The target architecture has this flow:

```text
Transport -> Turn Orchestration -> Agent Runtime / ACP adapter -> Agent Run Activity layer -> Presentation
```

The ACP adapter speaks provider protocol. The Agent Run Activity layer interprets provider/runtime activity and emits canonical OutboundEvents. Presentation renders canonical app events for concrete transports such as WhatsApp.

The current implementation still carries `raw` on runtime events in some places. That is migration debt. Examples observed today include WhatsApp reading raw ACP details to display read paths, line ranges, shell commands, and web actions, and runtime dispatch reading ACP metadata to suppress noisy terminal progress.

## Decision

Raw provider payloads are input to the Agent Run Activity layer only.

Canonical OutboundEvents and Presentation inputs must not include raw provider payloads.

If any module downstream of the Agent Run Activity layer needs a provider-derived fact, the Agent Run Activity layer must expose that fact through a canonical OutboundEvent field.

Raw payloads may be retained only in a diagnostic side channel such as raw-event logs or provider troubleshooting records. Those diagnostics must be keyed by canonical correlation IDs, such as event, turn, item, request, or provider reference IDs, rather than embedded in canonical events.

## Consequences

- Presentation must render from OutboundEvents, not from ACP/provider payload shape.
- Agent Run Activity dispatch must not branch on raw ACP metadata after normalization.
- Existing `raw` fields on runtime events are migration debt and should be removed in cleanup slices.
- Current WhatsApp raw ACP helpers should be replaced by canonical OutboundEvent fields for tool display facts such as semantic kind, paths, line ranges, commands, web action details, and progress visibility.
- Diagnostic records can keep raw ACP/provider payloads for troubleshooting without making those payloads part of the OutboundEvent interface.
- Tests should prove that downstream rendering and dispatch behavior follows canonical OutboundEvent fields even when raw provider payloads are absent.
