# Wait/Send Batching Command

Status: Complete

## Subject

Add an app-owned command flow that lets the user intentionally hold multiple incoming messages, including text and media, and submit them later as one coalesced user turn.

## Evidence

Audio note: [7989f4bec0f079781769d1dd27625cd391f14447f35b2f21462042d9fbc2edc8.ogg](../.media/7989f4bec0f079781769d1dd27625cd391f14447f35b2f21462042d9fbc2edc8.ogg)

Follow-up clarification audio note: [6a396709cebc093f549056f179209a6006bdb0247111abddd61773d342af071e.ogg](../.media/6a396709cebc093f549056f179209a6006bdb0247111abddd61773d342af071e.ogg)

User request, 2026-06-28:

- User wants this recorded as a task on `master`, not implemented now.
- Proposed command name is `/wait`; user is open to a better interface.
- Receiving `/wait` should not invoke the agent.
- `/wait` should enter a waiting mode where the `/wait` message itself and subsequent messages are collected into one pending user message.
- Subsequent messages may include text, images, audio, and other supported inbound content.
- The pending content should not be sent to the agent until the user sends a commit-style command, proposed as `/send`.
- User described the desired behavior as similar to starting and committing a SQL transaction.

## Naming / Interface Questions

`/wait` and `/send` are acceptable starting names, but confirm before implementation whether the public command pair should instead use clearer transaction language such as `/begin` and `/send`, `/batch` and `/send`, or `/draft` and `/send`.

Decide whether the command text itself is stripped from the eventual model input or preserved as user-authored content after removing only the command token. The likely behavior is to strip the command token and include any remaining text/media from the same message.

## Owner Layer

Likely owner is input orchestration before agent invocation, with WhatsApp transport support for multi-message content accumulation.

Relevant surfaces to inspect before implementation:

- `conversation/command-orchestration.js` and `conversation/channel-input-routing.js` for app-owned slash command routing.
- `conversation/create-conversation-runner.js` and `conversation/agent-runtime.js` for run-start decisions and existing active-run buffering.
- `whatsapp/create-whatsapp-transport.js` for current quiet-window coalescing of rapid same-chat messages.
- `whatsapp/inbound/channel-input.js` for merging text and media into one `ChannelInput`.
- `conversation/build-harness-turn-input.js`, `conversation/prepare-run-messages.js`, and related tests for existing buffered text semantics.

## Constraints

- Work in `/home/mada/whatsapp-llm-bot` on `master`.
- Do not invoke the agent for the `/wait` command itself.
- Waiting mode must be chat-scoped, not global.
- Preserve all supported inbound content types when batching, not just text.
- Keep existing rapid-message quiet-window coalescing behavior unless the new explicit waiting mode replaces it by design.
- Unknown slash commands should continue to follow the existing slash-command routing rules; reserve only the chosen command names.

## Acceptance Criteria

- A `/wait` message enters waiting mode and returns an app-owned acknowledgement/status without starting an agent run.
- Text/media attached to the `/wait` message is included in the pending batch according to the confirmed command-stripping rule.
- Additional messages in the same chat are accepted into the pending batch without starting agent runs.
- `/send` submits the collected content as one user turn through the normal agent path.
- `/send` with no pending batch gives a clear app-owned response and does not invoke the agent.
- Waiting state is isolated per chat and survives interleaved messages in other chats.
- Tests cover text-only batching, mixed media batching, command text stripping, empty send, and active-run interaction.

## Next Action

Done. Future follow-up should come from live use or a concrete user-case gap.

## Result

Implemented the explicit `/wait` and `/send` flow.

- `/wait` opens a chat-scoped in-memory batch and replies with an app-owned status.
- `/wait trailing text` strips the command token and keeps `trailing text` in the batch.
- Messages in the same chat are collected without starting agent turns while the batch is open.
- `/send` strips its command token, appends trailing text or media from the send message, and commits the collected content through the normal agent path.
- `/send` with no pending batch replies with an app-owned "No pending batch" response and does not invoke the agent.
- Batched media remains in the committed `ChannelInput` content.
- Interleaved chats remain isolated.
- If `/send` commits while an agent run is still active, the committed batch follows the existing buffered-turn path and runs after the active turn completes.

The implementation lives in `conversation/wait-send-batching.js` and is wired from `conversation/create-conversation-runner.js`.

## Verification

Red proof:

- `pnpm test tests/vertical/wait-send-batching.test.js` failed before production changes because `/wait` and `/send` were treated as ordinary agent input.

Green proof:

- `pnpm test tests/wait-send-batching.test.js`
- `pnpm test tests/vertical/wait-send-batching.test.js`
- `pnpm test tests/channel-input-routing.test.js tests/command-orchestration.test.js tests/conversation-runner-prompt-formatting.test.js tests/wait-send-batching.test.js tests/vertical/wait-send-batching.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
- `pnpm test:fast`
- `pnpm test:vertical`
