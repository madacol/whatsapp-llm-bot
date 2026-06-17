# Context

## Domain Vocabulary

- **Transport**: An inbound/outbound adapter such as WhatsApp or the HTTP API used by a voice assistant. Transports should convert external messages into app-owned turns and render app-owned outbound events, not carry provider-specific agent runtime details through the system.
- **Turn Orchestration**: The app-owned layer that handles conversation intake, chat/workspace/session policy, routing, and agent-run initiation after a transport has normalized an inbound message.
- **Agent runtime seam**: The app-owned seam between Turn Orchestration and concrete agent providers. ACP adapters live behind this seam.
- **ACP adapter**: A concrete adapter that speaks Agent Client Protocol to an agent provider such as Codex. ACP is provider/runtime protocol detail, not the app's presentation protocol.
- **Agent Run Activity layer**: The app-owned layer that turns provider/runtime activity into canonical, run-scoped events for presentation. It owns normalization, raw provider payload interpretation, and run-scoped state policy such as correlation, deduplication, snapshot reconciliation, usage aggregation, and completion semantics.
- **OutboundEvent**: The canonical app-owned event model for anything intended to be presented or delivered outside the core orchestration flow. OutboundEvent covers both agent-run activity and app-originated messages. Use event names that describe the behavior; add source, cause, or policy fields only when a concrete consumer needs them.
- **Agent-run OutboundEvent**: An OutboundEvent emitted from the Agent Run Activity layer, such as reasoning, assistant output, tool activity, command activity, file changes, snapshots, usage, plans, subagents, warnings, or run-scoped user-input/approval lifecycle. Use this distinction only when agent-run ownership affects behavior.
- **App-originated OutboundEvent**: An OutboundEvent produced by app behavior outside an agent run, such as reminders, restart acknowledgements, setup replies, status replies, command errors, or plain system notifications. Use this distinction only when app ownership affects behavior.
- **Output port**: A narrow producer seam for creating OutboundEvents. Output ports are ownership-specific; they should expose semantic creation methods rather than a generic `emitOutboundEvent` escape hatch.
- **Raw provider payload**: Diagnostic material from ACP or another provider protocol. It is input to the Agent Run Activity layer and may be retained only in provider diagnostics or raw-event logs; it must not be part of canonical OutboundEvents or Presentation inputs.
- **Diagnostic side channel**: Provider troubleshooting records kept outside canonical app events, such as raw-event logs keyed by event, turn, item, request, or provider correlation IDs. Diagnostics may preserve raw provider payloads, but they must not define user-facing behavior.
- **Presentation**: The layer that renders canonical app events for a concrete output surface. Presentation decides display policy, not provider payload meaning.
- **Harness**: Legacy implementation vocabulary for agent runtime modules. Treat harness naming as architecture debt to migrate in slices. Prefer Agent Runtime, ACP adapter, or Agent Run Activity vocabulary in new interfaces, docs, and touched modules.

## Architectural Constraints

- Raw provider payloads must die inside the Agent Run Activity layer. If any downstream module needs a fact from ACP or another provider protocol, the Agent Run Activity layer must expose that fact through canonical OutboundEvent fields.
- Raw provider payload diagnostics must stay in a side channel keyed by canonical correlation IDs. Do not carry raw payloads through OutboundEvents or Presentation just to make debugging convenient.
- Harness vocabulary migration should break hard inside internal seams and keep compatibility only at external/config surfaces. Existing chat config, database fields, and environment/config inputs may translate legacy harness names at the edge; new docs, tests, and internal interfaces should use Agent Runtime, ACP adapter, Agent Run Activity, or OutboundEvent vocabulary.
- Presentation should consume OutboundEvents. Do not split the interface into Run Event/App Message macro-categories. Do not encode origin in event names or add generic source/cause fields unless a real consumer needs that distinction.
- OutboundEvent creation should be split by producer ownership even though delivery is unified. Agent Run Activity should receive an agent-run output port; app and command modules should receive app output ports; external clients should submit inbound turns or commands, not create OutboundEvents.
- Producer output ports should be narrow and semantic. Avoid handing modules a generic `emitOutboundEvent` function unless the module is an output infrastructure adapter whose job is only to persist, queue, replay, or deliver already-created OutboundEvents.
- Final assistant output is part of the agent-run lifecycle and should be represented as an OutboundEvent with the fields needed for agent-run behavior.
- Raw provider data must not be a Presentation input or hidden dependency.
- User-visible command output should use OutboundEvent names that describe the behavior. If a command starts or participates in an agent run, include the fields needed for agent-run handling.
- Snapshot file changes detected as run reconciliation are OutboundEvents owned by Agent Run Activity. They are app-observed rather than provider-generated, but they are still caused by the agent run and belong behind the Agent Run Activity layer's normalization and deduplication policy.
- Cancelling an active agent run should emit an OutboundEvent for the run lifecycle change. "Nothing to cancel" should use an OutboundEvent that does not claim a run lifecycle change.
- Clearing conversation history should use an OutboundEvent that describes the history-clear result. Clearing, stopping, or replacing an active agent runtime session should additionally emit OutboundEvents with the run/session lifecycle fields needed for that behavior.
- Turn Orchestration owns command routing. Agent Runtime owns provider/session-specific command execution for commands such as model, config, permissions, fork, back, clear, and resume; Turn Orchestration should pass semantic commands to the active Agent Runtime rather than embedding provider control details.
- Agent Runtime should target ACP only for now. Do not introduce speculative protocol-neutral runtime abstractions until there is a real non-ACP adapter. ACP still remains contained before the Agent Run Activity layer, and raw ACP/provider payloads must not cross the Agent Run Activity seam.
