# Context

## Domain Vocabulary

- **Transport**: An inbound/outbound adapter such as WhatsApp or the HTTP API used by a voice assistant. Transports should convert external messages into app-owned turns and render app-owned outbound events, not carry provider-specific agent runtime details through the system.
- **Turn Orchestration**: The app-owned layer that handles conversation intake, chat/workspace/session policy, routing, and agent-run initiation after a transport has normalized an inbound message.
- **Agent runtime seam**: The app-owned seam between Turn Orchestration and concrete agent providers. ACP adapters live behind this seam.
- **ACP adapter**: A concrete adapter that speaks Agent Client Protocol to an agent provider such as Codex. ACP is provider/runtime protocol detail, not the app's presentation protocol.
- **Run Event layer**: The app-owned layer that turns provider/runtime activity into canonical, run-scoped events for presentation. It owns normalization and run-scoped state policy such as correlation, deduplication, snapshot reconciliation, usage aggregation, and completion semantics.
- **Run Event**: A canonical event describing agent-run activity, such as reasoning, assistant output, tool activity, command activity, file changes, snapshots, usage, plans, subagents, warnings, or run-scoped user-input/approval lifecycle.
- **App Message**: App-originated output that is not caused by an agent run, such as reminders, restart acknowledgements, setup replies, status replies, command errors, or plain system notifications.
- **Raw provider payload**: Diagnostic material from ACP or another provider protocol. It may be retained for troubleshooting at the runtime/diagnostic layer, but presentation should not branch on raw provider payloads for user-facing rendering.
- **Presentation**: The layer that renders canonical app events for a concrete output surface. Presentation decides display policy, not provider payload meaning.
- **Harness**: Legacy implementation vocabulary for agent runtime modules. Treat harness naming as architecture debt to migrate in slices. Prefer Agent Runtime, ACP adapter, or Run Event layer in new interfaces, docs, and touched modules.

## Architectural Constraints

- Presentation must not branch on raw provider payloads for user-facing rendering. If presentation needs a fact from ACP or another provider protocol, the Run Event layer must expose that fact through canonical Run Event fields.
- Harness vocabulary migration should break hard inside internal seams and keep compatibility only at external/config surfaces. Existing chat config, database fields, and environment/config inputs may translate legacy harness names at the edge; new docs, tests, and internal interfaces should use Agent Runtime, ACP adapter, or Run Event vocabulary.
- Presentation should consume Run Events as the only agent-run progress input. Legacy agent-run outbound event kinds such as tool calls, tool activity, plans, usage, subagent messages, and file changes should collapse into canonical Run Event types; generic content and App Messages may remain separate presentation inputs.
- Final assistant output is part of the agent-run lifecycle and should be represented as a Run Event first. Generic content projection may exist only as a compatibility or delivery convenience, such as accumulated text for simple blocking HTTP clients.
- Presentation has two semantically distinct input seams: Run Events for anything caused by an agent run, and App Messages for app-originated output not caused by an agent run. Raw provider data must not be a presentation input.
- User-visible command output should be App Messages unless the command starts or participates in an agent run and emits Run Events.
- Snapshot file changes detected as run reconciliation are Run Events. They are app-observed rather than provider-generated, but they are still caused by the agent run and belong behind the Run Event layer's normalization and deduplication policy.
- Cancelling an active agent run should emit a Run Event for the run lifecycle change. A user-facing acknowledgement may be rendered from that Run Event rather than as a separate App Message; "nothing to cancel" remains an App Message.
- Clearing conversation history is an App Message. Clearing, stopping, or replacing an active agent runtime session should additionally emit Run Events when there is run/session lifecycle behavior to show.
- Turn Orchestration owns command routing. Agent Runtime owns provider/session-specific command execution for commands such as model, config, permissions, fork, back, clear, and resume; Turn Orchestration should pass semantic commands to the active Agent Runtime rather than embedding provider control details.
