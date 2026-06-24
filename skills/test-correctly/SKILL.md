---
name: test-correctly
description: Use when planning, adding, reviewing, or verifying tests for a feature, bug fix, regression, refactor, integration, async workflow, or behavior change; especially when the desired outcome, proof seam, fixtures, mocks, or definition of done could be ambiguous.
---

# Test Correctly

Use testing to prove the intended behavior, not to confirm an implementation story.

## Workflow

1. Define the desired outcome in user terms.
   - Identify the action/input, expected result, visible output, durable side effect, and cleanup/settlement condition.
   - If any of those are unclear and materially affect the test, ask a concise clarification question before choosing the test target.

2. Start with a vertical proof path.
   - Default to a vertical test/replay that begins at the real entry point and follows the behavior to the user-valued outcome.
   - It may be temporary diagnostic scaffolding when the failure location is unknown, but it must exercise enough of the real path to localize the failing seam.
   - Include important boundaries that production crosses: serialization, persistence, queues, async workers, retries, subprocesses, external adapters, rendering, caches, permissions, or process reloads.
   - After the failing seam is known, add narrower tests only as support when they isolate important logic or edge cases.

3. For regressions, prove red before production edits.
   - Prefer real captured inputs, persisted state, logs, or fixtures derived from the failure.
   - The red test should fail for the observed behavior, not for an artificial approximation.
   - If red proof is impractical, state why and choose the next strongest evidence.

4. Patch only after the vertical proof target is clear.
   - Keep the change scoped to the behavior under test.
   - Do not mock away the boundary that is suspected to be failing.

5. Verify green at the same vertical proof seam.
   - Confirm the expected result and the absence of leftover failed/stuck state.
   - When the bug is live, also verify the running/deployed version or clearly state that it was not verified.

6. Report verification with labels.
   - `red proof`: the failing behavior was reproduced.
   - `green proof`: the intended behavior passed at the chosen seam.
   - `support test`: narrower tests that help but are not the main proof.
   - `live proof`: deployed/running state was checked.

## Guardrails

- Do not start with a lower-level helper test when a vertical test/replay is practical.
- Do not treat a lower-level helper test as proof for a cross-boundary behavior.
- Do not call a feature done because an intermediate step succeeded if the user-valued outcome has not happened.
- Do not infer payload shape, persisted shape, or async behavior when real evidence is available.
- Do not ask the user to retry before checking existing evidence that should already contain the failure.
- Do not silently downgrade the desired outcome to something easier to test.
- Do not keep temporary diagnostic scaffolding unless it adds durable regression value; convert it into a maintainable test or remove it after the fix.

For non-trivial regressions in this repo, use `tasks/templates/regression.md` for the task note.
