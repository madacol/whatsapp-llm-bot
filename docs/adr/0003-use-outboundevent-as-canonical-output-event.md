# ADR 0003: Use OutboundEvent As The Canonical Output Event

## Status

Accepted.

## Context

The codebase already uses `OutboundEvent` as the unified event shape for things that are intended to be presented or delivered outside the core orchestration flow. A previous decision, ADR 0002, proposed removing `OutboundEvent` and splitting canonical output into separate Run Event and App Message interfaces.

That split made ownership explicit, but it also introduced a macro-category distinction that can be represented more simply with precise event names and fields. The practical event stream is still one stream of presentable output. Rendering, HTTP streaming, queueing, replay, and transport delivery are simpler when they share one canonical event model.

Agent-run activity and app-originated output can still have different event names and fields when that distinction matters to behavior. The distinction does not require separate top-level event interfaces, mandatory origin prefixes, or mandatory generic source/cause metadata.

## Decision

Use `OutboundEvent` as the canonical app-owned output event model.

Do not split the public or internal output model into separate top-level Run Event and App Message interfaces. Prefer OutboundEvent names that describe the behavior. Add source, cause, or policy fields only when a concrete consumer needs them. For example, an active-run cancellation and a "nothing to cancel" reply should be different OutboundEvent names/shapes if they need different handling, not the same generic command result.

Raw provider payloads are still prohibited from OutboundEvents. Agent-run OutboundEvents are produced from Agent Run Activity normalization, and any provider-derived fact needed downstream must be represented as an app-owned OutboundEvent field.

## Consequences

- Presentation, HTTP event APIs, queues, replay, and transport renderers should converge on `OutboundEvent` as the single canonical output event model.
- Event names should describe behavior directly. Do not encode source in every event name; source/cause fields are optional and should be added only when they simplify real behavior.
- Agent-run lifecycle, usage, file-change reconciliation, and app-originated messages remain distinct through event names and required fields.
- ADR 0002 is superseded; do not remove `OutboundEvent` merely because it is unified.
- Existing `OutboundEvent` shapes still need cleanup where they leak raw provider data, vague generic content, or legacy harness vocabulary.
