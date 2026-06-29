# Vertical Scenario Runner

## Subject

Implemented the first production-quality test-infrastructure slice for a vertical scenario runner built from plain JavaScript step arrays and helpers that map to real runtime surfaces.

## Context

The user wanted a more readable way to write broad vertical/e2e tests. The aligned shape was:

- `runScenario([...steps])` where each step is a function.
- assertions are ordinary functions that inspect `ctx`.
- shared helpers and composites map to production modules or groupings documented in `CONTEXT.md`, linked architecture docs, or the module's own internal files.
- test-specific sequencing stays visible as scenario steps.
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
- a visible scenario step that starts the real WhatsApp transport module;
- explicit app behavior steps for the selectMany interaction;
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

## Superseded Guidance

Later review changed the intended testing model. Do not treat the scenario-runner pattern as the default future vertical/e2e approach. Current guidance is tracked in `tasks/vertical-user-case-tests.md`: vertical tests should be an independently runnable user-case catalog, mock only external transport and agent seams by default, run real production code between those seams, prefer capture-system seam inputs, and add narrow automatic regression tests for module flaws found through vertical proof.
