# Vertical Scenario Runner

## Subject

Implement the first production-quality test-infrastructure slice for a vertical scenario runner built from plain JavaScript step arrays and composite module wrappers.

## Context

The user wants a more readable way to write broad vertical/e2e tests. The aligned shape is:

- `runScenario([...steps])` where each step is a function.
- assertions are ordinary functions that inspect `ctx`.
- composite modules hide repeated setup for common vertical paths.
- tests that need lower-level detail use primitive steps directly.
- real tests use capture records from logs or smoke-test capture output.
- route checkpoints are outside the first slice; current vertical/e2e tests assert outcomes.

The detailed self-contained handoff is saved at:

- `/tmp/vertical-scenario-testing-handoff.md`

## First Target

Use `tests/whatsapp-transport.test.js`, test name:

- `replays captured-shape raw LID selectMany poll votes delivered through messages.upsert`

This test has a large setup-to-assertion ratio and should gain substantial readability from a scenario module.

## Acceptance Criteria

- Add a duplicate scenario proof using the new runner shape while preserving the current target test.
- Use full `whatsapp.inbound` capture records generated through the existing capture substrate or committed from that output.
- Add a composite module for the WhatsApp transport `selectMany` flow.
- Keep assertions as plain functions over scenario context.
- Run the new proof test, the original target test, and `pnpm type-check`.

## Status

Todo.
