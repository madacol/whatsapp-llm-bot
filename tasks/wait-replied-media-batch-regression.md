# Wait Replied Media Batch Regression

Status: Todo

## Subject

Fix the `/wait` batching behavior when the `/wait` command is sent as a reply to an existing media message. The replied image should seed the newly opened batch immediately instead of the batch starting with `0 messages queued`.

## Evidence

User report, 2026-07-02:

- The user sent `/wait` while replying to an image/screenshot.
- The bot answered: `Batch started. 0 messages queued. Send /send when ready.`
- The user clarified: "that image should have been queued from the start."
- A follow-up screenshot shows the sequence more precisely: a replied `/wait` message with an image thumbnail, then the bot's `0 messages queued` response, then another `/wait` response saying the batch is already open with `0 messages queued`.

Attached evidence:

- First screenshot: [1636c1d69a0d5ac02590140d85894652b2d8cfb84306b08544781535f2048745.jpg](../.media/1636c1d69a0d5ac02590140d85894652b2d8cfb84306b08544781535f2048745.jpg)
- Clarifying screenshot: [9f15dbcfbdb15a3f0cb0c7bcf621a790e7334d4733da9b5f08da9c5680eb78e2.jpg](../.media/9f15dbcfbdb15a3f0cb0c7bcf621a790e7334d4733da9b5f08da9c5680eb78e2.jpg)
- Voice note: [eddf74da15f1b448bc466f53fbeaf70256666b4af4d5fd42ac62849f108f0e85.ogg](../.media/eddf74da15f1b448bc466f53fbeaf70256666b4af4d5fd42ac62849f108f0e85.ogg)

Related completed work: [wait-send-batching-command.md](done/wait-send-batching-command.md).

## Current Understanding

The completed `/wait` task intentionally kept `/wait`, `/send`, and `/cancel` control messages out of the pending batch. This report appears to refine that rule: the command text should remain control-only, but a replied/quoted media payload that the command points at should be treated as the first batch item.

The exact inbound representation of replied media is not yet confirmed. Before implementation, inspect the real WhatsApp payload or the normalized channel input for the replied `/wait` message and identify where the quoted image reference/media content is available.

## Owner Layer

Likely owner is the WhatsApp inbound normalization and conversation batching path:

- `whatsapp/inbound/channel-input.js` for media and quoted/replied message extraction.
- `conversation/wait-send-batching.js` for opening a batch and reporting queued counts.
- `conversation/create-conversation-runner.js` for routing `/wait` before agent invocation.
- Existing vertical tests under `tests/vertical/wait-send-batching.test.js` and WhatsApp transport scenario coverage.

## Constraints

- Do not include the literal `/wait` command text in the eventual agent turn.
- Preserve chat-scoped batch isolation.
- Avoid a broad special case until the real replied-media payload shape is inspected.
- Keep normal `/wait` with no replied/attached content as an empty batch opener.

## Acceptance Criteria

- Sending `/wait` as a reply to a supported image starts a batch with that image already queued.
- The app-owned acknowledgement reports the correct queued count, expected `1 messages queued` or a grammatically equivalent singular form.
- `/send` submits the queued replied image through the normal agent path with preserved media content and any existing media-to-text preprocessing behavior.
- The `/wait` command text is not included in the submitted user turn.
- Tests cover a plain empty `/wait`, `/wait` replying to an image, and `/send` after a replied-media seeded batch.

## Next Action

Inspect a real inbound replied-media `/wait` payload or existing diagnostics, then add a failing regression before changing batching behavior.
