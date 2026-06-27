# Defer Existing Vertical Test Migration

## Subject

Keep the existing long vertical/e2e tests in their current form while the new scenario-runner pattern proves its value through new useful tests.

## Context

The first scenario-runner proof added a duplicate scenario test for the raw LID `selectMany` `messages.upsert` flow. The original long WhatsApp transport test remains in place as the established behavior contract.

The user wants future vertical slice and end-to-end tests to use the new scenario-runner pattern, but existing tests should be migrated only after many new scenario tests earn their keep by being useful and readable.

## Guidance

- Add new vertical/e2e coverage with `tests/scenario-runner.js` when the test crosses subsystem seams.
- Use composite modules to hide repeated setup for common flows.
- Use real capture records from logs or smoke-generated capture output.
- Keep assertions as plain functions over scenario context.
- Preserve existing long tests until the scenario pattern has demonstrated a clear readability and maintenance benefit across several new tests.

## Next Action

After several useful new scenario tests exist, review whether the original raw LID `selectMany` transport test should be replaced by the scenario version.

## Status

Todo.
