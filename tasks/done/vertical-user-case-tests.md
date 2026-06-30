# Vertical User-Case Tests

## Subject

Maintain vertical tests as an independently runnable user-case catalog, while using narrow automatic tests as the cheap regression layer for module flaws found through those vertical proofs.

## Context

The first scenario-runner proof added duplicate scenario tests for WhatsApp transport behavior, but the aligned testing model changed after review.

The user wants vertical tests to record expressed user cases and bugs. A missing or failed user case means existing vertical coverage was absent or insufficient. The vertical test should run the real production code between mocked external seams; normally the mocked seams are transports and agents.

Inputs crossing mocked seams should prefer capture-system outputs from logs, smoke tests, or other legitimate capture runs. Made-up payloads are acceptable only as a weaker fallback when capture evidence is not practical.

Future guidance should focus on independently runnable vertical user-case tests and module harnesses rather than a scenario framework.

## Guidance

- For a new user case or bug, create or update an independently runnable vertical test for that user case.
- Mock only external transport and agent seams unless there is a specific reason to do otherwise.
- Run the real production code between mocked seams.
- Prefer capture-system outputs for seam inputs; use made-up payloads only as a weaker fallback.
- After the vertical test exposes a module flaw, add the narrowest useful automatic regression test for that module.
- Put user-case vertical tests under `tests/vertical/` and run them with `pnpm test:vertical` or a direct `pnpm test tests/vertical/<file>.test.js`.
- Keep top-level `tests/*.test.js` focused on automatic regression coverage.

## Result

The long-term testing direction is now encoded in the repo:

- `tests/vertical/whatsapp-agent-user-case.test.js` proves a private WhatsApp text through real transport, ingress journal, conversation runner, agent runtime, app output, and WhatsApp rendering, with mocked WhatsApp and ACP harness seams.
- `tests/vertical/whatsapp-inspect-reactions.test.js` preserves the useful inspect-reaction vertical behavior from the old scenario-runner test in plain `node:test` form.
- `tests/vertical/whatsapp-adapter-e2e.test.js` holds the broad WhatsApp adapter e2e catalog outside the default top-level automatic suite.
- `tests/vertical/whatsapp-transport-testbed.js` owns the fake WhatsApp socket, fake connection supervisor, and capture replay used by vertical tests.
- `pnpm test:vertical` runs the vertical user-case catalog explicitly.

The old scenario/declarative experiments were removed:

- `tests/scenario-runner.js`
- `tests/whatsapp-transport-scenario-modules.js`
- `tests/whatsapp-transport-scenarios.test.js`
- `tests/vertical-slice-scenarios.js`
- `tests/declarative-vertical-slice.test.js`
- `tests/fixtures/vertical/*`

The captured-shape raw LID poll scenario was not migrated because the same behavior is already covered by a plain test in `tests/whatsapp-transport.test.js`.

Current vertical fixtures still include made-up Baileys-shaped inputs in places. The reusable vertical testbed can replay through the capture substrate, but future user cases should prefer real log/smoke captures when practical.

## Next Action

Add new vertical tests only for concrete user cases or bugs. When a vertical exposes a module flaw, add the narrowest useful automatic regression test for that module.

## Status

Complete.

## Verification

- `pnpm type-check:tests`
- `pnpm type-check`
- `pnpm test:rendering`
- `pnpm test:fast`
- `pnpm test:vertical`
