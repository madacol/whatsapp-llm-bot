# ADR 0004: Split OutboundEvent Producer Seams

## Status

Accepted.

## Context

ADR 0003 keeps `OutboundEvent` as the single canonical output event model. That keeps delivery simple: Presentation, HTTP streaming, queues, replay, and transports can consume one event stream.

A single output model does not mean every module should be able to create every event. Agent Run Activity owns agent-run lifecycle, tool, file, usage, reasoning, assistant output, and run-scoped request events. Turn Orchestration and app command modules own app behavior such as setup replies, restart acknowledgements, reminders, command errors, and "nothing to cancel" replies.

If every producer receives a generic `emitOutboundEvent(event)` function, it becomes easy for one ownership area to emit another area's events. That weakens the same ownership constraints the architecture is trying to clarify.

## Decision

Keep OutboundEvent delivery unified, but split OutboundEvent creation by producer ownership.

Agent Run Activity should receive a narrow agent-run output port that can create only the OutboundEvents it owns. App and command modules should receive narrow app output ports that can create only the OutboundEvents they own. External clients should not create OutboundEvents; they submit inbound turns or commands.

Output ports should expose semantic methods or tightly-scoped builders, not a generic free-form `emitOutboundEvent` escape hatch. Generic persistence, queue, replay, and delivery adapters may accept already-created OutboundEvents because they are infrastructure consumers, not domain producers.

## Consequences

- Creation is ownership-specific; delivery remains unified.
- The shared queue can store one OutboundEvent stream without giving producers permission to create arbitrary event names.
- Agent Run Activity cannot emit app-owned events unless an output port explicitly exposes that capability.
- App command modules cannot emit agent-run lifecycle/tool/file/usage events unless an output port explicitly exposes that capability.
- Tests should cover output ports as producer seams, not only final Presentation rendering.
