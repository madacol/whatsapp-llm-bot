# Vertical User-Case Tests

## Subject

Maintain vertical tests as an independently runnable user-case catalog, while using narrow automatic tests as the cheap regression layer for module flaws found through those vertical proofs.

## Context

The first scenario-runner proof added duplicate scenario tests for WhatsApp transport behavior, but the aligned testing model changed after review.

The user wants vertical tests to record expressed user cases and bugs. A missing or failed user case means existing vertical coverage was absent or insufficient. The vertical test should run the real production code between mocked external seams; normally the mocked seams are transports and agents.

Inputs crossing mocked seams should prefer capture-system outputs from logs, smoke tests, or other legitimate capture runs. Made-up payloads are acceptable only as a weaker fallback when capture evidence is not practical.

Future guidance should focus on independently runnable vertical user-case tests and module harnesses rather than the scenario-runner framework. Existing committed scenario-runner code can remain until deliberately replaced.

## Guidance

- For a new user case or bug, create or update an independently runnable vertical test for that user case.
- Mock only external transport and agent seams unless there is a specific reason to do otherwise.
- Run the real production code between mocked seams.
- Prefer capture-system outputs for seam inputs; use made-up payloads only as a weaker fallback.
- After the vertical test exposes a module flaw, add the narrowest useful automatic regression test for that module.
- Keep broad migration of unrelated legacy vertical/e2e tests deferred until a new vertical user-case harness design is chosen.

## Spike Result

`tests/vertical/whatsapp-agent-user-case.test.js` is the first plain vertical user-case spike for this direction.

It proves that a private WhatsApp text can travel through:

- mocked Baileys socket receiving `messages.upsert`;
- real `createWhatsAppTransport`, including the production ingress journal path via `outboundStore`;
- real conversation runner, route decision, message persistence, agent runtime orchestration, app output port, and WhatsApp rendering;
- mocked ACP harness seam;
- fake WhatsApp `sendMessage` observation.

The test asserts both seam outcomes:

- the selected harness receives the normalized user text as its runtime input;
- WhatsApp outbound sends a rendered text response containing the harness answer to the original chat.

The inbound payload currently uses `createWAMessage`, so it is a made-up Baileys-shaped message rather than a capture-system fixture. That is acceptable for this spike, but a promoted user-case catalog should prefer records from logs or smoke-generated captures when practical.

This spike supports the plain-test direction better than the scenario-runner direction: the behavior is visible in ordinary `node:test` code, setup helpers represent only external seams, and production modules remain in the proof.

## Next Action

Use this spike as the reference when adding the next user-case vertical test. Delay shared harness extraction until at least a few useful user-case tests show the repeated setup that should be named. Replace made-up seam inputs with capture-system fixtures when practical.

## Status

Todo, with the first plain vertical spike completed.
