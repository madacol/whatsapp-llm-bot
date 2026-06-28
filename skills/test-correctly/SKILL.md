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

3. Start vertical and use real evidence.
   Default to a test or replay that enters through the real entry point and follows the path to the user-valued outcome. For regressions, inspect the latest relevant captured input, logs, persisted state, trace, or fixture before production edits.

   For changes and bug fixes in this repo, identify the vertical slice or end-to-end proof for the behavior being changed. If a relevant vertical/e2e test already exists, migrate that proof to the scenario-runner pattern as part of the change. If no relevant vertical/e2e test exists, create one with the scenario-runner pattern. Use `tests/scenario-runner.js`: plain JavaScript step arrays, explicit scenario steps, real capture records from logs or smoke-generated capture output, and plain assertions over scenario context. Create shared scenario helpers or composites for production modules or groupings already documented in `CONTEXT.md`, the architecture docs it links, or the module's own internal files. Keep test-only sequencing visible as scenario steps. Migrate only the relevant proof; broad unrelated legacy-test migration can stay deferred.

   For cross-seam behavior, test from the relevant start seam to the relevant end seam before adding narrower tests.

4. Clarify when the proof target is ambiguous.
   If the desired result, acknowledgement, durable state, or cleanup condition changes the test and is materially ambiguous, ask before choosing the proof target.

5. Keep the suspected seam in the proof.
   Base red proof on the real failing artifact when one exists. Do not mock, bypass, or unit-test around the boundary most likely to be failing. Narrow seam/unit tests are support tests; they do not replace the vertical proof for a behavior change or bug fix.

6. Verify green on the same path.
   Green proof must cover the user-valued outcome and any relevant durable/async settlement. For live bugs, also verify the running version or say it was not verified.

If a fix fails in live/manual verification, stop extending the previous hypothesis. Treat the latest failure as the new source of truth, rebuild or adjust the vertical red proof from that evidence, then patch again.

If the same symptom appears through multiple entry points, assume a shared path until disproven. Test the shared path vertically instead of debugging each entry point separately.

Report verification as `red proof`, `green proof`, `support test`, and `live proof` when those labels apply.

For non-trivial regressions in this repo, use `tasks/templates/regression.md`.
