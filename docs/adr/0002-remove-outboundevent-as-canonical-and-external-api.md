# ADR 0002: Remove OutboundEvent As Canonical And External API

## Status

Accepted.

## Context

The current codebase uses `OutboundEvent` as a broad delivery shape for WhatsApp, the HTTP API transport, outbound queues, replay, tests, and some internal handoffs. That shape mixes agent-run progress and app-originated messages.

The target architecture has two canonical output concepts:

```text
Run Event
App Message
```

Run Events are caused by an agent run and are owned by the Agent Run Activity layer. App Messages are app-originated output not caused by an agent run. Keeping a global `OutboundEvent` interface would blur that distinction and make transport delivery shape look like app meaning.

Some `OutboundEvent` surfaces are external or external-adjacent:

- HTTP API event polling and SSE streaming currently document raw `OutboundEvent` payloads.
- Persistent outbound queues may contain queued `OutboundEvent` payloads.
- WhatsApp replay/rendering currently consumes `OutboundEvent`.

Backward compatibility for those surfaces is not required for this migration.

## Decision

Remove `OutboundEvent` as both an internal canonical interface and an external event API shape.

The external HTTP event API, persisted outbound queue, replay path, and transport rendering path should move to Run Event and App Message shapes directly. Do not add an `OutboundEvent` compatibility layer for old clients, old queue payloads, or old renderer inputs unless a future ADR explicitly reopens this decision.

The migration is allowed to be a breaking change.

## Consequences

- Internal seams should pass `RunEvent` or `AppMessage`, not `OutboundEvent`.
- HTTP event polling and SSE streaming should publish the new canonical shapes rather than `kind: "content"` / `kind: "runtime_event"` legacy envelopes.
- Persisted queue/replay storage should store the new canonical shapes; old queued `OutboundEvent` payloads may be invalidated by the migration.
- Presentation and transport renderers should branch on Run Event vs App Message semantics, not legacy outbound kinds.
- Tests should be updated around the new canonical event shapes instead of preserving old `OutboundEvent` expectations.
