# Test Type Checking

## Subject

Make test type-checking valuable by moving test-heavy seams toward small app-owned port types.

## End Goal

- `pnpm type-check:tests` is the durable full test type-check contract and passes.
- New reusable test infrastructure and new vertical/e2e scenario tests are type-checkable.
- Production code exposes narrow app-owned ports at test-heavy seams.
- Test mocks satisfy those app-owned ports instead of inline-casting partial objects into large third-party interfaces.
- Legacy mock-heavy tests are migrated to typed helpers or local narrow annotations without forcing partial mocks to satisfy giant third-party interfaces.
- The normal `pnpm type-check` contract remains green throughout.

## Context

The production `pnpm type-check` config currently excludes `tests/`. The clean target is not to force every mock to satisfy a giant third-party interface; it is to keep third-party types at adapter boundaries and let tests satisfy app-owned ports.

## Current Slice

Start with the WhatsApp socket seam because many tests currently create partial Baileys sockets and cast them to `WASocket`.

Done in this slice:

- introduced app-owned WhatsApp socket ports in `types.d.ts`;
- moved the WhatsApp transport, inbound channel input, select/confirm runtime, outbound durability, outbound delivery, HD media normalization, and connection-supervisor public seams toward those ports;
- updated the new WhatsApp transport scenario helper so its fake socket is a `WhatsAppTransportSocketPort` instead of a `WASocket` double-cast.
- started a full tests type-check migration by adding a dedicated `pnpm type-check:tests` command and `jsconfig.tests.json`.

Verified during migration:

- `pnpm type-check`
- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/whatsapp-transport-scenario-modules.js`
- `pnpm test tests/whatsapp-transport-scenarios.test.js`
- `pnpm test tests/select-runtime.test.js`
- `pnpm test tests/connection-supervisor.test.js`
- `pnpm test tests/whatsapp-transport.test.js`
- `pnpm test tests/adapter.test.js`
- `pnpm test tests/sendBlocks.test.js`
- `pnpm test tests/workspace-lifecycle.test.js`
- `pnpm test tests/media-to-text.test.js` (needed local mock-server bind permission)
- `pnpm test tests/message-formatting.test.js`
- `pnpm test tests/conversation-runner-prompt-formatting.test.js`
- `pnpm test tests/store.test.js`
- `pnpm test tests/chat-settings.test.js`
- `pnpm test tests/harness-session-binding.test.js`
- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/acp-payload-to-whatsapp.test.js --pretty false`
- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/harness-run-coordinator.test.js --pretty false`
- `pnpm test tests/harness-run-coordinator.test.js`
- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/e2e-adapter.test.js --pretty false`
- `pnpm test tests/e2e-adapter.test.js` (needed local mock-server bind permission)
- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/acp-harness.test.js --pretty false`
- `pnpm test tests/acp-harness.test.js` (needed unrestricted process/network sandbox permission; restricted sandbox made ACP mock-process tests time out)
- focused type-checks and behavior tests for `tests/shutdown-lifecycle.test.js`, `tests/shutdown-lifecycle-process.test.js`, `tests/restart-command.test.js`, `tests/restart-scheduler.test.js`, `tests/http-api-transport.test.js`, `tests/harness-registry.test.js`, `tests/build-agent-io-hooks.test.js`, `tests/whatsapp-workspace-presenter.test.js`, `tests/channel-input-routing.test.js`, `tests/build-run-config.test.js`, `tests/acp-file-changes.test.js`, `tests/workspace-control.test.js`, `tests/vertical-slice-scenarios.js`, `tests/command-orchestration.test.js`, `tests/acp-model-command.test.js`, `tests/acp-events.test.js`, `tests/acp-read-presentation-vertical.test.js`, `tests/action-request-runtime.test.js`, `tests/active-session-directory.test.js`, `tests/agent-run-activity-reconciliation.test.js`, `tests/app-output-port.test.js`, `tests/build-harness-turn-input.test.js`, `tests/chat-settings-interaction.test.js`, `tests/conversation-clear-follow-up.test.js`, `tests/conversation-runner-prompt-formatting.test.js`, `tests/create-whatsapp-transport.test.js`, and `tests/db-diagnostics.test.js` where applicable.
- additional focused type-checks and behavior tests for the final migration files, including `tests/harness-runtime-event-dispatcher.test.js`, `tests/harness-session-commands.test.js`, `tests/http-api-turn-flow.test.js`, `tests/http-api-turn-intake.test.js`, `tests/index-restart.test.js`, `tests/live-input-text.test.js`, `tests/memory.test.js`, `tests/notifications.test.js`, `tests/outbound-event-rendering.test.js`, `tests/prompt-media.test.js`, `tests/reminder-daemon.test.js`, `tests/restart-ack-delivery.test.js`, `tests/sandbox-approval-coordinator.test.js`, `tests/session-title.test.js`, `tests/tool-presentation-model.test.js`, `tests/whatsapp-delivery-plan.test.js`, `tests/whatsapp-file-change-content.test.js`, `tests/whatsapp-outbound-durability.test.js`, `tests/whatsapp-tool-presenter.test.js`, `tests/workspace-lifecycle-service.test.js`, and `tests/workspace-resolver.test.js`.
- `pnpm type-check:tests`
- `pnpm type-check`

Migration proof:

- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/**/*.js --pretty false` fails before the full migration.
- After the first WhatsApp port slice, the log was down to 1393 diagnostic lines.
- After migrating the focused WhatsApp transport, adapter, select runtime, connection supervisor, sendBlocks, workspace lifecycle, and fake Codex app server surfaces, the log is down to 704 diagnostic lines.
- After migrating media-to-text, message formatting, conversation runner prompt formatting, store, chat settings, and harness session binding tests, the log is down to 430 diagnostic lines.
- After migrating ACP payload typing, harness run coordinator, e2e adapter, and ACP harness tests, the log is down to 356 diagnostic lines.
- After migrating the next broad cluster of runtime-event, command, workspace, outbound, and HTTP tests, the log is down to 116 diagnostic lines.
- After the final migration, `pnpm type-check:tests` passes.

## Completion Notes

- Added `jsconfig.tests.json` and the `pnpm type-check:tests` package script as the durable test type-check contract.
- Migrated legacy mock-heavy tests by adding typed helpers, explicit discriminant narrowing, complete row fixtures where required, and real test stores where that was cleaner than partial fake stores.
- Kept production `pnpm type-check` green after the test migration.
- Attempted full `pnpm test`. Unrestricted execution was blocked by the approval system; the restricted sandbox run failed on local `127.0.0.1` bind restrictions (`EPERM`), which is a known sandbox limitation for this suite. Focused behavior tests were run for changed areas as listed above, including escalated local-bind tests where approval was available.

## Status

Completed. `pnpm type-check:tests` and `pnpm type-check` pass.
