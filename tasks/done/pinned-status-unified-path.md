# Unify Pinned Lifecycle And Tool Status Path

## Task

Pinned lifecycle status and pinned tool/command status are the same feature and must use the same message/state path. Tool status must not create one pinned message and then have `turn.started` create a second pinned message.

## Evidence

- User correction: "the lifecycle status message and the tool called status message, it should be just the same message. It should be the same path."
- Current `updatePinnedTurnStatus` resets existing pinned state whenever a `createsStatus` presentation arrives. That is correct for a genuinely new turn after an existing turn, but wrong when tool status created the pinned state before the lifecycle `turn.started` event arrived.

## Acceptance

- If a pinned tool/command status exists and `turn.started` arrives later, `turn.started` edits the existing pinned status message instead of unpinning it and creating another pinned message.
- A genuinely new `turn.started` after an existing lifecycle turn still cleans up prior tracked pins defensively.
- Existing lifecycle-first pinned status behavior remains supported.

## Verification

- Red proof before production edit: `pnpm test --test-name-pattern="keeps tool-first pinned status" tests/sendBlocks.test.js` failed because tool status pinned `msg-1`, `turn.started` unpinned it, and lifecycle status created `msg-4`.
- Green proof after production edit:
  - `pnpm test --test-name-pattern="keeps tool-first pinned status|routes tool and command rows through pinned status|unpins tracked status handles before starting" tests/sendBlocks.test.js`
  - `pnpm test tests/sendBlocks.test.js`
  - `pnpm type-check`

## Completion Notes

- `turn.started` now only resets an existing pinned status state when that state already has a lifecycle turn entry.
- Tool-first pinned status state is treated as the same status pipeline, so `turn.started`, tool/command updates, and `turn.completed` edit the same pinned message.
