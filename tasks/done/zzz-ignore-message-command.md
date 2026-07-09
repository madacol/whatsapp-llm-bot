# `!zzz` Ignore Message Command

Status: Done

## Subject

Add `!zzz` as an app-owned no-op command that causes the bot to ignore the current message.

## Evidence

User request, 2026-07-05: "add to todo, command !zzz to ignore this msg"

## Intended Behavior

- Messages whose first text block starts with `!zzz` should not invoke the agent.
- The command should apply only to the current inbound message.
- The command should work even if the message contains additional text or media; the whole message is ignored.
- Prefer no chat reply for the MVP, because the requested behavior is "ignore this msg".

## Owner Layer

Likely owner is the bang-command routing path before workspace commands or agent dispatch.

Relevant surfaces:

- `commands/bang-command-router.js`
- `conversation/channel-input-routing.js`
- WhatsApp inbound tests that prove app-owned commands do not start agent runs

## Acceptance Criteria

- `!zzz` is recognized as an app-owned command.
- A `!zzz` message is not added as a user message for agent context.
- A `!zzz` message does not start, enqueue, cancel, or otherwise affect an agent run.
- Mixed text/media messages starting with `!zzz` are ignored as one inbound message.

## Completion Notes

- Added `!zzz` handling at the bang-command router before workspace commands and app-owned command side effects.
- The command returns without replying, adding a message, invoking the agent, or touching active run state.
- Added a pipeline regression with mixed text/image content proving the message is not persisted and no ACP turn starts.

## Verification

- `pnpm test tests/llm-pipeline.test.js tests/acp-payload-to-whatsapp.test.js tests/sendBlocks.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
