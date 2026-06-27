# Deepen Outbound Durability And State Seams

## Subject

Implemented the three candidates from `architecture-review-site/reviews/20260626-1942-outbound-state-seams.html`:

- Deepened WhatsApp outbound durability.
- Localized Session persistence behind Agent Runtime.
- Split HTTP API turn flow from wire routing.

## Evidence

- User first asked to improve architecture; report commit `530832f` identified the three candidates.
- User then said "do them all", interpreted as implementing all three report candidates.
- Architectural constraints:
  - Keep concrete Transports explicit.
  - Preserve `OutboundEvent` as the canonical output event.
  - Keep producer ports ownership-specific.
  - Move internal vocabulary toward Channel, Session, Invocation, Agent Runtime, and OutboundEvent, while legacy chat/harness names can remain at storage/config edges.

## Completed Work

- Added `whatsapp/outbound/durability.js` as the owner of live send-or-queue, replay, recoverable-error policy, output visibility reload, stream buffering, and queued handle resolution.
- Kept `whatsapp/outbound/persistent-queue.js` and `whatsapp/outbound/queue-replay.js` as compatibility re-export entry points.
- Added `conversation/session-persistence.js` to translate legacy harness-session store methods into Agent Runtime Session vocabulary.
- Updated Agent Runtime and session binding to consume the Session persistence seam.
- Added `http-api-turn-flow.js` to own idempotent HTTP turn records, active-turn event correlation, assistant text accumulation, event cursors, and SSE fanout.
- Updated `http-api-transport.js` so route parsing, auth, media download, and response serialization stay in the wire module.
- Added seam tests for all three modules and updated the delivery-plan architecture assertion to inspect the new durability owner.

## Verification

- Red proof before production edits:
  - `pnpm test tests/whatsapp-outbound-durability.test.js tests/session-persistence.test.js tests/http-api-turn-flow.test.js` failed with missing-module errors for the new seams.
- Green targeted:
  - `pnpm test tests/whatsapp-outbound-durability.test.js tests/session-persistence.test.js tests/http-api-turn-flow.test.js`
  - `pnpm test tests/harness-session-binding.test.js tests/session-persistence.test.js tests/http-api-turn-flow.test.js tests/http-api-transport-ledger.test.js tests/http-api-transport.test.js tests/whatsapp-outbound-durability.test.js tests/whatsapp-delivery-plan.test.js`
  - `pnpm test tests/http-api-transport.test.js` with escalation for localhost listener permissions.
  - `pnpm test tests/whatsapp-transport.test.js`
- Full verification:
  - `pnpm type-check`
  - `pnpm test` with escalation for localhost listener permissions; 957 passed.
