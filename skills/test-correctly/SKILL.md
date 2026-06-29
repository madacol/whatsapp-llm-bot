---
name: test-correctly
description: Use before choosing, creating, modifying, or verifying tests for a feature, bug fix, regression, refactor, integration, async workflow, or behavior change. Focuses agents on vertical proof first, real evidence before fixes, red/green proof, and clarification when the desired outcome is ambiguous.
---

# Test Correctly

Use testing to prove the user-valued behavior, not the implementation story.

## Core Rules

1. Additions and fixes: red, then green.
   Before production edits for a new feature, bug fix, or intended supported-behavior change, create or run the strongest relevant failing proof. Then make the change, run `pnpm type-check` and relevant tests, and note the red/green verification in the commit.

2. Removals: green, then red, then delete or update.
   For obsolete behavior removals, find the existing test that proves the behavior and run it green when practical. Remove or change the feature, rerun the same test and confirm it fails for the expected reason, then delete or update that obsolete test. Keep absence tests only when absence is itself a durable user-valued, safety, or architecture invariant.

3. Start from the user case and real evidence.
   For a new user case or bug, create or update an independently runnable vertical test that represents that user case. Vertical tests are the user-case catalog: they may be too expensive for the default automatic suite, but they should be runnable directly for the behavior under investigation.

   In vertical tests, mock only the external transport and agent seams unless there is a specific reason to do otherwise. The production code between those seams should run for real. Inputs crossing mocked seams should prefer capture-system outputs from logs, smoke tests, or other legitimate capture runs; made-up payloads are a weaker fallback when capture evidence is not practical.

   When a vertical test exposes a module flaw, add the narrowest useful automatic regression test for that module. The vertical test proves the user case; the narrow test becomes the cheap guard for the specific defect.

4. Clarify when the proof target is ambiguous.
   If the desired result, acknowledgement, durable state, or cleanup condition changes the test and is materially ambiguous, ask before choosing the proof target.

5. Keep the suspected seam in the proof.
   Base red proof on the real failing artifact when one exists. Do not replace the production module or boundary most likely to be failing with test behavior. Mocked external transport and agent seams are acceptable in vertical tests; the production code between those seams should remain in the proof. Narrow seam/unit tests are support tests; they do not replace the vertical user-case proof for a behavior change or bug fix.

6. Verify green on the same path.
   Green proof must cover the user-valued outcome and any relevant durable/async settlement. For live bugs, also verify the running version or say it was not verified.

If a fix fails in live/manual verification, stop extending the previous hypothesis. Treat the latest failure as the new source of truth, rebuild or adjust the vertical red proof from that evidence, then patch again.

If the same symptom appears through multiple entry points, assume a shared path until disproven. Test the shared path vertically instead of debugging each entry point separately.

Report verification as `red proof`, `green proof`, `support test`, and `live proof` when those labels apply.

For non-trivial regressions in this repo, use `tasks/templates/regression.md`.
