# Defer Existing Vertical Test Migration

## Subject

Defer broad migration of unrelated existing vertical/e2e tests while requiring each behavior change or bug fix to have a scenario-runner vertical proof.

## Context

The first scenario-runner proof added a duplicate scenario test for the raw LID `selectMany` `messages.upsert` flow. The original long WhatsApp transport test remains in place as the established behavior contract.

The user wants future vertical slice and end-to-end tests to use the new scenario-runner pattern. For changes and bug fixes, the relevant vertical proof should use the new pattern now: migrate an existing relevant vertical/e2e proof when one exists, or create a new scenario-runner vertical test when none exists.

Broad migration of unrelated legacy vertical/e2e tests is still deferred until several useful new scenario tests prove the pattern is readable and maintainable.

## Guidance

- Add new vertical/e2e coverage with `tests/scenario-runner.js` when a change or bug fix crosses subsystem seams.
- If a relevant vertical/e2e test already exists for the behavior being changed, migrate that proof to `tests/scenario-runner.js` as part of the change.
- Use shared scenario helpers or composites for production modules or groupings already documented in `CONTEXT.md`, linked architecture docs, or the module's own internal files.
- Keep test-only sequencing visible as plain scenario steps.
- Use real capture records from logs or smoke-generated capture output.
- Keep assertions as plain functions over scenario context.
- Preserve unrelated existing long tests until the scenario pattern has demonstrated a clear readability and maintenance benefit across several new tests.

## Next Action

After several useful new scenario tests exist, review whether the original raw LID `selectMany` transport test should be replaced by the scenario version.

## Status

Todo.
