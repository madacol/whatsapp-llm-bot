# Generic Agent Event Presentation

Status: Done

## Subject

Ensure every executed tool action or agent runtime event has some visible chat representation. If an event is not a recognized tool call, present it through a generic event fallback instead of silently omitting it.

## Evidence

User supplied a mobile WhatsApp screenshot on 2026-07-05 from the `Get Bookmarklets` chat:

- [Screenshot](../.media/9a236b80e18b959a3717926535735d5d9038393aa9d9530ca9481a2f6b2ac377.jpg)

Visible messages showed:

- The assistant said it was checking a running screenshot capture, inspecting an image, and rerunning checks.
- A `Thought` placeholder and later `Shell` and `List` tool blocks were visible.
- User observed that some executed action/event did not appear in chat and noted that there should be a generic way to represent tool executions. If the missing item is not actually a tool call, there should still be a generic representation for generic events.

## Requirement

The outbound event presentation layer should not rely only on known, specialized tool presentations. Unknown tool calls and non-tool agent events that imply execution/activity need a minimal fallback presentation that includes enough information for the user to see that something happened.

## Owner Layer

Likely owner is the shared outbound presentation/event model first, with transport-specific rendering only at the final formatting layer.

Inspect before implementation:

- Agent/runtime event emission for tool and non-tool execution events.
- Shared outbound event types and presentation conversion.
- WhatsApp chat renderer and shared transport renderers for recognized tool blocks and fallback messages.
- Diagnostics or traces for the screenshot scenario to identify the exact missing event shape.

## Acceptance Criteria

- Unknown or currently-unhandled tool execution events render in chat with a generic label, status, and concise detail.
- Non-tool execution/activity events that should be user-visible render through a generic event fallback.
- Known specialized tool presentations continue to render as they do today.
- A regression test covers the concrete missing event shape from the screenshot scenario, or records why only a synthetic generic-event fixture is available.

## Completion Notes

- Kept existing unknown runtime-tool generic fallback coverage intact.
- ACP `item.*` runtime events are no longer blanket-suppressed; assistant and reasoning bookkeeping remains hidden, while file/tool/unknown items render through the generic runtime status fallback.
- Generic item summaries now include a concise first-line detail when the provider supplies item text.
- The screenshot evidence did not include the exact raw runtime payload in the repo, so coverage uses a synthetic ACP `item.started` fixture matching the missing screenshot-capture activity class.

## Verification

- `pnpm test tests/llm-pipeline.test.js tests/acp-payload-to-whatsapp.test.js tests/sendBlocks.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
