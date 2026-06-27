# Command And Intake Architecture

## Subject

Implemented all four candidates from `architecture-review-site/reviews/20260627-1037-command-and-intake-seams.html`.

## User Request

The user said "do them all" after the current architecture review. In context, this meant:

- Deepen Command Orchestration.
- Deepen HTTP API Transport turn intake.
- Deepen Chat Settings interaction.
- Localize Channel identity migration.

## Completed Work

- Added `conversation/command-orchestration.js` to own bang command routing, slash command handling, disabled slash command responses, `/clear` follow-up flow, and Agent Runtime command handoff.
- Added `http-api-turn-intake.js` so HTTP text and audio turns share the same create-or-get, duplicate, active-turn, status, completion, and failure lifecycle.
- Moved chat settings interaction behavior into `chat-settings-service.js`, leaving `commands/chat-settings-command.js` as a command adapter with parameter metadata.
- Added `conversation/channel-identity.js` and threaded `channelId` through app-owned input/action seams while retaining `chatId` compatibility at transport/storage edges.
- Added focused seam tests and kept cross-seam behavior tests green.

## Verification

- Red proof: `pnpm test tests/command-orchestration.test.js tests/http-api-turn-intake.test.js tests/chat-settings-interaction.test.js tests/channel-identity.test.js` failed before production edits because the new modules/export did not exist.
- Green: `pnpm test tests/command-orchestration.test.js tests/http-api-turn-intake.test.js tests/chat-settings-interaction.test.js tests/channel-identity.test.js`
- Green: `pnpm type-check`
- Green: `pnpm test tests/command-orchestration.test.js tests/http-api-turn-intake.test.js tests/chat-settings-interaction.test.js tests/channel-identity.test.js tests/channel-input-routing.test.js tests/workspace-commands.test.js tests/chat-settings.test.js tests/http-api-turn-flow.test.js tests/http-api-transport.test.js tests/conversation-clear-follow-up.test.js tests/slash-diff-command.test.js tests/create-whatsapp-transport.test.js tests/whatsapp-boundary.test.js`
- Green: `pnpm test` passed 964 tests with 0 failures.

## Status

Done.
