# Vertical Scenario Runner

## Subject

Implemented the first production-quality test-infrastructure slice for a vertical scenario runner built from plain JavaScript step arrays and composite module wrappers.

## Context

The user wanted a more readable way to write broad vertical/e2e tests. The aligned shape was:

- `runScenario([...steps])` where each step is a function.
- assertions are ordinary functions that inspect `ctx`.
- composite modules hide repeated setup for common vertical paths.
- tests that need lower-level detail use primitive steps directly.
- real tests use capture records from logs or smoke-test capture output.
- route checkpoints are outside the first slice; current vertical/e2e tests assert outcomes.

The detailed self-contained handoff was saved at:

- `/tmp/vertical-scenario-testing-handoff.md`

## First Target

Used `tests/whatsapp-transport.test.js`, test name:

- `replays captured-shape raw LID selectMany poll votes delivered through messages.upsert`

## Completion Notes

Added:

- `tests/scenario-runner.js`
- `tests/whatsapp-transport-scenario-modules.js`
- `tests/whatsapp-transport-scenarios.test.js`

The proof scenario preserves the original target test and demonstrates:

- a plain `runScenario([...steps])` test shape;
- a composite `whatsappSelectManyModule(...)` for the repeated WhatsApp transport setup;
- full `whatsapp.inbound` capture records generated through the existing fixture capture substrate;
- replay through the same transport event processor used by live `messages.upsert` events;
- plain assertion functions over scenario context.

## Verification

- `pnpm test tests/whatsapp-transport-scenarios.test.js`
- `pnpm test tests/whatsapp-transport.test.js --test-name-pattern "replays captured-shape raw LID selectMany poll votes delivered through messages.upsert"`
- `pnpm type-check`
- `git diff --check`

The second command ran the whole `tests/whatsapp-transport.test.js` file under the repo's runner, which includes the original target test.

## Status

Done.
