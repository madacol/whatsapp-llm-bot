---
name: test-correctly
description: Use when choosing or verifying tests for a feature, bug fix, regression, refactor, integration, async workflow, or behavior change. Focuses agents on vertical proof first, real evidence before fixes, red/green proof, and clarification when the desired outcome is ambiguous.
---

# Test Correctly

Use testing to prove the user-valued behavior, not the implementation story.

## Core Rules

1. Clarify the outcome when it changes the test.
   If the desired result, acknowledgement, durable state, or cleanup condition is materially ambiguous, ask before choosing the proof target.

2. Start vertical.
   Default to a test or replay that enters through the real entry point and follows the path to the user-valued outcome. It may be temporary diagnostic scaffolding if the failing seam is unknown.

3. Use real evidence before theory.
   For regressions, inspect the latest relevant captured input, logs, persisted state, trace, or fixture before production edits. Do not ask the user to retry until existing evidence has been checked.

4. Prove red at the vertical path.
   The red proof should fail for the observed behavior. If full red proof is impractical, state why and use the strongest available replay.

5. Do not hide the suspected seam.
   Do not mock, bypass, or unit-test around the boundary most likely to be failing. Narrow tests are support only after the vertical path localizes the seam.

6. Verify green on the same path.
   Green proof must cover the user-valued outcome and any relevant durable/async settlement. For live bugs, also verify the running version or say it was not verified.

Report verification as `red proof`, `green proof`, `support test`, and `live proof` when those labels apply.

For non-trivial regressions in this repo, use `tasks/templates/regression.md`.
