# Clean Up Pinned Turn Status Messages

## Task

Pinned turn status messages should not accumulate in WhatsApp chats. A new turn should first unpin any previously tracked pinned status messages for that chat, and turn completion should unpin every tracked status message created during the turn, not only the latest editable handle.

## Evidence

- User transcript says pinned status messages keep accumulating.
- User specifically wants all status messages unpinned at the end of the turn because a replacement status can be created after the edit handle expires.
- User prefers unpinning any pinned status message before starting a turn as a defensive cleanup.
- Current implementation tracks only `state.handle` in `whatsapp/outbound/send-content.js`; replacement flow unpins stale handles immediately, but turn completion only unpins the current handle.

## Acceptance Criteria

- Pinned status duration is reduced from the current 24 hours when sending a pin payload.
- On `turn.started`, any tracked pinned status handles for that chat are unpinned before the new status is created.
- On `turn.completed`, every tracked pinned status handle for the active status lifecycle is unpinned.
- Existing user-visible status rendering remains unchanged apart from cleanup pin payloads and pin duration.

## Verification

- Red proof before production edits: `pnpm test tests/sendBlocks.test.js` failed as expected on the one-hour pin duration, missing pre-turn cleanup, and missing stale replacement unpin retry.
- Additional red proof before production edit: `pnpm test --test-name-pattern="retries failed pre-turn cleanup unpins" tests/sendBlocks.test.js` failed because failed pre-turn cleanup dropped the old pinned key instead of retrying it at turn completion.
- Green proof after production edits:
  - `pnpm test --test-name-pattern="retries failed pre-turn cleanup unpins" tests/sendBlocks.test.js`
  - `pnpm test tests/sendBlocks.test.js`
  - `pnpm type-check`
  - `pnpm test tests/acp-payload-to-whatsapp.test.js tests/e2e-adapter.test.js tests/whatsapp-transport.test.js` outside the sandbox because sandboxed child-process pipes prevent the ACP mock fixture from receiving stdin.

## Completion Notes

- Reduced turn status pin duration to one hour.
- Track every successfully pinned turn status message key for a chat lifecycle.
- Unpin tracked status keys before creating a new turn status.
- Unpin every tracked key at turn completion, including replacement statuses created after edit handle expiry.
- Preserve failed pre-turn cleanup keys into the new lifecycle so completion retries them.
