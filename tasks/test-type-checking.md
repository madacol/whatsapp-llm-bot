# Test Type Checking

## Subject

Make test type-checking valuable by moving test-heavy seams toward small app-owned port types.

## End Goal

- New reusable test infrastructure and new vertical/e2e scenario tests are type-checkable.
- Production code exposes narrow app-owned ports at test-heavy seams.
- Test mocks satisfy those app-owned ports instead of inline-casting partial objects into large third-party interfaces.
- Legacy mock-heavy tests can migrate incrementally as their seams gain app-owned ports.
- The normal `pnpm type-check` contract remains green throughout.

## Context

The production `pnpm type-check` config currently excludes `tests/`. The clean target is not to force every mock to satisfy a giant third-party interface; it is to keep third-party types at adapter boundaries and let tests satisfy app-owned ports.

## Current Slice

Start with the WhatsApp socket seam because many tests currently create partial Baileys sockets and cast them to `WASocket`.

Done in this slice:

- introduced app-owned WhatsApp socket ports in `types.d.ts`;
- moved the WhatsApp transport, inbound channel input, select/confirm runtime, outbound durability, outbound delivery, HD media normalization, and connection-supervisor public seams toward those ports;
- updated the new WhatsApp transport scenario helper so its fake socket is a `WhatsAppTransportSocketPort` instead of a `WASocket` double-cast.

Verified:

- `pnpm type-check`
- `pnpm exec tsc --noEmit --allowJs --checkJs --strict --target ES2022 --module ESNext --moduleResolution bundler --skipLibCheck --types node types.d.ts tests/whatsapp-transport-scenario-modules.js`
- `pnpm test tests/whatsapp-transport-scenarios.test.js`
- `pnpm test tests/select-runtime.test.js`
- `pnpm test tests/connection-supervisor.test.js`
- `pnpm test tests/whatsapp-transport.test.js`

## Remaining Questions

- Which test files are reusable infrastructure and would benefit from type-checking first?
- What is the right scope for a future test type-check command after the first ports exist?
- Should the next slice add a narrow test type-check command for scenario helpers only, or first migrate more mock-heavy helpers to app-owned ports?

## Status

Active. The first WhatsApp socket port slice is implemented; the broader test type-check contract is still pending.
