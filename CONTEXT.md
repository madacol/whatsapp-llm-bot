# Context

## Domain Vocabulary

- **Transport**: An inbound/outbound adapter such as WhatsApp or the HTTP API used by a voice assistant. Transports should convert external messages into app-owned turns and render app-owned outbound events, not carry provider-specific agent runtime details through the system.
- **Turn Orchestration**: The app-owned layer that handles conversation intake, chat/workspace/session policy, routing, and agent-run initiation after a transport has normalized an inbound message.
- **Agent runtime seam**: The app-owned seam between Turn Orchestration and concrete agent providers. ACP adapters live behind this seam.
- **ACP adapter**: A concrete adapter that speaks Agent Client Protocol to an agent provider such as Codex. ACP is provider/runtime protocol detail, not the app's presentation protocol.
- **Run Event layer**: The app-owned layer that turns provider/runtime activity into canonical, run-scoped events for presentation. It owns normalization and run-scoped state policy such as correlation, deduplication, snapshot reconciliation, usage aggregation, and completion semantics.
- **Run Event**: A canonical event describing agent-run activity, such as reasoning, assistant output, tool activity, command activity, file changes, snapshots, usage, plans, subagents, warnings, or run-scoped user-input/approval lifecycle.
- **Raw provider payload**: Diagnostic material from ACP or another provider protocol. It may be retained for troubleshooting at the runtime/diagnostic layer, but presentation should not branch on raw provider payloads for user-facing rendering.
- **Presentation**: The layer that renders canonical app events for a concrete output surface. Presentation decides display policy, not provider payload meaning.
- **Non-run notification**: App-originated output such as reminders or restart acknowledgements. These may enter presentation, but they are not part of the agent-run pipeline or the Run Event layer.
- **Harness**: Legacy implementation vocabulary for agent runtime modules. Prefer Agent Runtime, ACP adapter, or Run Event layer in new architecture language.

## Architectural Constraints

- Presentation must not branch on raw provider payloads for user-facing rendering. If presentation needs a fact from ACP or another provider protocol, the Run Event layer must expose that fact through canonical Run Event fields.
