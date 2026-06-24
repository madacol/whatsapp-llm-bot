# Show Settings Poll No Response

## Subject

Investigate and fix the `!s show` WhatsApp poll appearing to accept a vote without producing a settings update.

## Evidence

- User screenshot: `!s show` sends a WhatsApp multi-select poll titled "Choose which extra agent progress outputs are shown in chat."
- After selecting "Show pinned tool status", WhatsApp shows the option selected with one vote, but the user reports "nothing happens".
- The command path is `commands/chat-settings-command.js` -> `chat-settings-service.js` multi-picker -> `whatsapp/runtime/select-runtime.js`.

## Constraints

- Preserve poll-backed select semantics for other prompts.
- Prove the regression red before production edits, then run focused tests, `pnpm type-check`, and commit.
- Use `pnpm` for package scripts.

## Acceptance Criteria

- A live `!s show` poll vote settles into a visible settings response when the user changes output visibility.
- The picker reflects current output visibility in a way that does not make a valid tap look inert.
- Existing select runtime and chat settings tests pass.

## Completion Notes

- Root cause: Baileys emits decrypted poll votes on `messages.update` as `update.pollUpdates`; the transport only handled poll updates that arrived as `messages.upsert` payloads.
- Added `messages.update` resolution in the select runtime and confirm runtime wrapper.
- Wired WhatsApp transport and persistent ingress dispatch to capture, journal, and dispatch poll update events.
- Added regression coverage for select runtime poll update resolution and a full transport `selectMany` vote delivered through `messages.update`.

## Verification

- Red proof: `pnpm test tests/select-runtime.test.js` failed with `TypeError: registry.resolvePollUpdate is not a function`.
- Green focused: `pnpm test tests/select-runtime.test.js tests/create-whatsapp-transport.test.js tests/whatsapp-transport.test.js`.
- Green type-check: `pnpm type-check`.
- Green broad: `pnpm test --fast` with local bind escalation, 913 tests passed.
