# Context

## Domain Vocabulary

- **Transport**: An inbound/outbound adapter such as WhatsApp or the HTTP API used by a voice assistant. Transports should convert external messages into app-owned turns and render app-owned outbound events, not carry provider-specific agent runtime details through the system.
- **Turn Orchestration**: The app-owned layer that handles conversation intake, chat/workspace/session policy, routing, and agent-run initiation after a transport has normalized an inbound message.
- **Agent runtime seam**: The app-owned seam between Turn Orchestration and concrete agent providers. ACP adapters live behind this seam.
- **ACP adapter**: A concrete adapter that speaks Agent Client Protocol to an agent provider such as Codex. ACP is provider/runtime protocol detail, not the app's presentation protocol.
- **Agent Run Activity layer**: The app-owned layer that turns provider/runtime activity into canonical, run-scoped events for presentation. It owns normalization, raw provider payload interpretation, and run-scoped state policy such as correlation, deduplication, snapshot reconciliation, usage aggregation, and completion semantics.
- **OutboundEvent**: The canonical app-owned event model for anything intended to be presented or delivered outside the core orchestration flow. OutboundEvent covers both agent-run activity and app-originated messages. Use precise event names first; add source, cause, or policy fields only when a concrete consumer needs them.
- **Agent-run OutboundEvent**: An OutboundEvent emitted from the Agent Run Activity layer, such as reasoning, assistant output, tool activity, command activity, file changes, snapshots, usage, plans, subagents, warnings, or run-scoped user-input/approval lifecycle.
- **App-originated OutboundEvent**: An OutboundEvent produced by app behavior outside an agent run, such as reminders, restart acknowledgements, setup replies, status replies, command errors, or plain system notifications.
- **Raw provider payload**: Diagnostic material from ACP or another provider protocol. It is input to the Agent Run Activity layer and may be retained only in provider diagnostics or raw-event logs; it must not be part of canonical OutboundEvents or Presentation inputs.
- **Diagnostic side channel**: Provider troubleshooting records kept outside canonical app events, such as raw-event logs keyed by event, turn, item, request, or provider correlation IDs. Diagnostics may preserve raw provider payloads, but they must not define user-facing behavior.
- **Presentation**: The layer that renders canonical app events for a concrete output surface. Presentation decides display policy, not provider payload meaning.
- **Harness**: Legacy implementation vocabulary for agent runtime modules. Treat harness naming as architecture debt to migrate in slices. Prefer Agent Runtime, ACP adapter, or Agent Run Activity vocabulary in new interfaces, docs, and touched modules.

## Architectural Constraints

- Raw provider payloads must die inside the Agent Run Activity layer. If any downstream module needs a fact from ACP or another provider protocol, the Agent Run Activity layer must expose that fact through canonical OutboundEvent fields.
- Raw provider payload diagnostics must stay in a side channel keyed by canonical correlation IDs. Do not carry raw payloads through OutboundEvents or Presentation just to make debugging convenient.
- Harness vocabulary migration should break hard inside internal seams and keep compatibility only at external/config surfaces. Existing chat config, database fields, and environment/config inputs may translate legacy harness names at the edge; new docs, tests, and internal interfaces should use Agent Runtime, ACP adapter, Agent Run Activity, or OutboundEvent vocabulary.
- Presentation should consume OutboundEvents. Agent-run activity and app-originated messages should use precise event names rather than separate Run Event/App Message interface splits. Do not add generic source/cause fields unless a real consumer needs them.
- Final assistant output is part of the agent-run lifecycle and should be represented as an agent-run OutboundEvent.
- Raw provider data must not be a Presentation input or hidden dependency.
- User-visible command output should use app-originated OutboundEvent names unless the command starts or participates in an agent run and emits agent-run OutboundEvents.
- Snapshot file changes detected as run reconciliation are agent-run OutboundEvents. They are app-observed rather than provider-generated, but they are still caused by the agent run and belong behind the Agent Run Activity layer's normalization and deduplication policy.
- Cancelling an active agent run should emit an agent-run OutboundEvent for the run lifecycle change. "Nothing to cancel" remains an app-originated OutboundEvent.
- Clearing conversation history is an app-originated OutboundEvent. Clearing, stopping, or replacing an active agent runtime session should additionally emit agent-run OutboundEvents when there is run/session lifecycle behavior to show.
- Turn Orchestration owns command routing. Agent Runtime owns provider/session-specific command execution for commands such as model, config, permissions, fork, back, clear, and resume; Turn Orchestration should pass semantic commands to the active Agent Runtime rather than embedding provider control details.
- Agent Runtime should target ACP only for now. Do not introduce speculative protocol-neutral runtime abstractions until there is a real non-ACP adapter. ACP still remains contained before the Agent Run Activity layer, and raw ACP/provider payloads must not cross the Agent Run Activity seam.
