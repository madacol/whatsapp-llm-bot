# ACP Delete File Rendered As Update

Status: Todo

## Subject

Fix the regression where an ACP/apply_patch file deletion is presented in chat as `Update` instead of `Delete`.

## Evidence

User request audio, 2026-07-05: [1499b86604c5ab4de5c9744356f0ec1ecb423b8f5fc3751123b203daf936352c.ogg](../.media/1499b86604c5ab4de5c9744356f0ec1ecb423b8f5fc3751123b203daf936352c.ogg)

User observed a WhatsApp-rendered diff captioned:

```text
🔧 *Update*  `/home/mada/.codex/skills/snapshot-ignore/SKILL.md`
```

The displayed diff was a full deletion:

```diff
@@ -1,8 +0,0 @@
- ---
- name: snapshot-ignore
- description: Use when the user asks to ignore paths from
-     snapshots.
- ---
-
- # Snapshot Ignore
-
- Add the requested paths to `snapshot-ignore.txt` as
-     simple relative globs, e.g. `node_modules/**`.
```

The actual tool action was `apply_patch` with a `Delete File` hunk, and the result reported the file as deleted. See [ACP/apply_patch capture](acp-delete-file-rendered-as-update-capture.md).

## Requirement

Delete-file events need a specific delete presentation. A file that disappears must not be labeled as `Update`, even if the rendered diff body only shows a hunk like `@@ -1,8 +0,0 @@` without `+++ /dev/null` headers.

Turn the captured ACP/apply_patch input into a fixture for the raw ACP/REST-call test path.

## Likely Owner Layer

Start from the ACP/REST payload seam, not only the final renderer unit.

Relevant surfaces:

- `tests/acp-payload-to-whatsapp.test.js`: raw ACP payload to WhatsApp/REST-style fixture path.
- `harnesses/acp-runner.js`: `apply_patch` snapshot capture and event emission.
- `harnesses/acp-file-changes.js`: targeted and snapshot file-change event construction.
- `whatsapp/outbound/file-change-content.js`: `Delete`/`Update` presentation title selection.
- Existing direct renderer tests in `tests/sendBlocks.test.js` already cover some delete labels; this regression needs the captured ACP path.

## Acceptance Criteria

- Add a fixture/test from the captured ACP/apply_patch delete input.
- The resulting outbound file-change event preserves deletion semantics.
- WhatsApp presentation labels the file as `Delete`, not `Update`.
- The test would fail against the observed bad behavior before the fix.
