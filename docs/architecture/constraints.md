# Architectural Constraints

## Provider Payload Boundary

- Raw provider payloads must die inside the Agent Run Activity layer. If any downstream module needs a fact from ACP or another provider protocol, the Agent Run Activity layer must expose that fact through canonical OutboundEvent fields.
- Raw provider payload diagnostics must stay in a side channel keyed by canonical correlation IDs. Do not carry raw payloads through OutboundEvents or Presentation just to make debugging convenient.
- `diagnosticRaw` may cross from an ACP adapter into the Agent Run Activity dispatcher so it can write raw-event diagnostics. The dispatcher must drop it before app-facing runtime hooks, OutboundEvents, queues, replay, transports, or Presentation see the event.
- Raw provider data must not be a Presentation input or hidden dependency.

## Vocabulary Migration

- Harness/chat/turn vocabulary migration should break hard inside internal seams and keep compatibility only at external/config surfaces. Existing chat config, database fields, environment/config inputs, and tests may retain legacy names until migrated; new docs and internal interfaces should use Channel, ChannelInput, Session, Invocation, Agent Runtime, ACP adapter, Agent Run Activity, or OutboundEvent vocabulary.

## Output Events

- Presentation should consume OutboundEvents. Do not split the interface into Run Event/App Message macro-categories. Do not encode origin in event names or add generic source/cause fields unless a real consumer needs that distinction.
- OutboundEvent creation should be split by producer ownership even though delivery is unified. Agent Run Activity should receive an agent-run output port; app and command modules should receive app output ports; external clients should submit ChannelInputs or commands, not create OutboundEvents.
- The initial output seam names are `AgentRunOutputPort`, `AppOutputPort`, and `OutboundEventSink`. Keep these roles distinct: producer ports create owned events; sinks handle already-created events.
- Producer output ports should be narrow and semantic. Avoid handing modules a generic `emitOutboundEvent` function unless the module is an output infrastructure adapter whose job is only to persist, queue, replay, or deliver already-created OutboundEvents.
- Final assistant output is part of the agent-run lifecycle and should be represented as an OutboundEvent with the fields needed for agent-run behavior.
- User-visible command output should use OutboundEvent names that describe the behavior. If a command starts or participates in an agent invocation, include the fields needed for invocation handling.

## Invocation Lifecycle

- Snapshot file changes detected as invocation reconciliation are OutboundEvents owned by Agent Run Activity. They are app-observed rather than provider-generated, but they are still caused by the agent invocation and belong behind the Agent Run Activity layer's normalization and deduplication policy.
- Cancelling an active agent invocation should emit an OutboundEvent for the invocation lifecycle change. "Nothing to cancel" should use an OutboundEvent that does not claim an invocation lifecycle change.
- Clearing session history should use an OutboundEvent that describes the history-clear result. Clearing, stopping, or replacing an active agent runtime session should additionally emit OutboundEvents with the invocation/session lifecycle fields needed for that behavior.

## Runtime And Transport Boundaries

- Input Orchestration owns command routing. Agent Runtime owns provider/session-specific command execution for commands such as model, config, permissions, fork, back, clear, and resume; Input Orchestration should pass semantic commands to the active Agent Runtime rather than embedding provider control details.
- Agent Runtime should target ACP only for now. Do not introduce speculative protocol-neutral runtime abstractions until there is a real non-ACP adapter. ACP still remains contained before the Agent Run Activity layer, and raw ACP/provider payloads must not cross the Agent Run Activity seam.
- Keep concrete Transports explicit. Transport-specific inbound/outbound details and vocabulary should live in their concrete implementation and `docs/transports/` document; do not promote internal transport seams into app-wide concepts unless another Transport needs the same seam.
