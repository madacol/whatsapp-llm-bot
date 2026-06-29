# Vertical User-Case Tests

## Subject

Maintain vertical tests as an independently runnable user-case catalog, while using narrow automatic tests as the cheap regression layer for module flaws found through those vertical proofs.

## Context

The first scenario-runner proof added duplicate scenario tests for WhatsApp transport behavior, but the aligned testing model changed after review.

The user wants vertical tests to record expressed user cases and bugs. A missing or failed user case means existing vertical coverage was absent or insufficient. The vertical test should run the real production code between mocked external seams; normally the mocked seams are transports and agents.

Inputs crossing mocked seams should prefer capture-system outputs from logs, smoke tests, or other legitimate capture runs. Made-up payloads are acceptable only as a weaker fallback when capture evidence is not practical.

The scenario-runner direction should not be promoted as the default. Existing committed scenario-runner code can remain until deliberately replaced, but future guidance should focus on independently runnable vertical user-case tests and module harnesses rather than a scenario framework.

## Guidance

- For a new user case or bug, create or update an independently runnable vertical test for that user case.
- Mock only external transport and agent seams unless there is a specific reason to do otherwise.
- Run the real production code between mocked seams.
- Prefer capture-system outputs for seam inputs; use made-up payloads only as a weaker fallback.
- After the vertical test exposes a module flaw, add the narrowest useful automatic regression test for that module.
- Keep broad migration of unrelated legacy vertical/e2e tests deferred until a new vertical user-case harness design is chosen.

## Next Action

Design the next vertical user-case harness before migrating more tests or promoting the existing scenario-runner pattern.

## Status

Todo.
