# Codex apply_patch delete+add rewrite diff

## Current repo state

- Active task is linked from [`tasks/todo.md`](todo.md).
- Added capture script: [`../scripts/codex-app-server-approval-delete-add-capture.js`](../scripts/codex-app-server-approval-delete-add-capture.js).
- Added real direct app-server fixture: [`../tests/fixtures/codex-app-server-approval-delete-add-traffic.json`](../tests/fixtures/codex-app-server-approval-delete-add-traffic.json).
- Added this detail doc.
- No production fix or regression test is complete yet.
- `tasks/quoted-thinking-inspect-regression.md` is an unrelated untracked task detail file; do not mix it into this work.

## Problem

For an existing file rewritten by one `apply_patch` containing same-path `Delete File` + `Add File`, WhatsApp can show **Add** instead of one **Update** diff.

## Verified facts

From the real `codex app-server` fixture:

- The run used a real existing file and requested a same-path delete+add `apply_patch`.
- App-server emitted a `fileChange` item for the rewritten file.
- That `fileChange` is add-only:
  - `params.item.type: "fileChange"`
  - `params.item.changes[0].kind.type: "add"`
  - `params.item.changes[0].diff` is only the new file content.
- The same traffic also emitted the correct unified patch in `turn/diff/updated.params.diff`.
- `turn/diff/updated` appears multiple times with the same useful diff.

From `node_modules/@agentclientprotocol/codex-acp/dist/index.js`:

- `CodexEventHandler.createUpdateEvent()` ignores `turn/diff/updated`.
- `codex-acp` does process `fileChange`.
- `createPatchContent()` maps the add-only `fileChange` to ACP content with `oldText: null`, `newText: change.diff`, `_meta.kind: "add"`.

Conclusion: the real app-server has the correct diff, but the ACP adapter drops it and keeps the bad add-only fileChange.

## Verified negative findings

- I did not capture a manual blocking approval request.
- With both workspace-write and read-only attempts, app-server used `approvalsReviewer: "auto_review"`.
- The real traffic shows auto-review notifications, not a client approval request:
  - `item/autoApprovalReview/started`
  - `guardianWarning`
  - `item/autoApprovalReview/completed`

## Hypothesis

The fix should use `turn/diff/updated` rather than approval-time file snapshots for this case.

Likely shape:

- Store the latest `turn/diff/updated.params.diff` by `turnId`.
- When a `fileChange` for the same turn is add-only, check whether the turn diff contains that path.
- If yes, emit/update ACP content as an update with the unified diff instead of an add.

## Unknowns

- Whether `turn/diff/updated` always arrives before the final `fileChange` completion.
- How to split one turn-level diff across multiple fileChange items.
- Whether the fix belongs entirely in the `codex-acp` patch or partly in our harness.
- Whether manual approval blocking can be forced later; it is not required to prove the current add-only bug because the useful diff is already in the real app-server traffic.
