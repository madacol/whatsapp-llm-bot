# Codex apply_patch delete+add rewrite diff

## Final repo state

- Task is complete and removed from [`tasks/todo.md`](todo.md).
- Added capture script: [`../scripts/codex-app-server-approval-delete-add-capture.js`](../scripts/codex-app-server-approval-delete-add-capture.js).
- Added real direct app-server fixture: [`../tests/fixtures/codex-app-server-approval-delete-add-traffic.json`](../tests/fixtures/codex-app-server-approval-delete-add-traffic.json).
- Added this detail doc.
- Added a WhatsApp e2e pipeline regression test for the captured delete+add rewrite shape.
- No production fix was needed: the harness baseline reconciliation already corrects the user-visible output to an update.
- `tasks/quoted-thinking-inspect-regression.md` remains the next unrelated task.

## Outcome

Pipeline verified through WhatsApp inbound -> selected ACP harness -> patched `codex-acp` -> fake Codex app-server -> WhatsApp rendered output:

- The fake app-server emits the captured shape: existing-file rewrite reported as add-only `fileChange`, followed by late `turn/diff/updated`.
- The e2e test creates the file before the turn so the run-start baseline exists.
- WhatsApp renders exactly one `Update` caption for `approval-delete-add.md`.
- WhatsApp renders no `Add` caption for `approval-delete-add.md`.

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
