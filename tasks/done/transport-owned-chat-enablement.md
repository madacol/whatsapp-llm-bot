# Transport-Owned Chat Enablement

## Subject

Move the default chat enabled/disabled policy out of generic conversation routing and into transport-owned chat initialization or transport metadata.

## Evidence

- During web audio client E2E work on 2026-07-01, authenticated HTTP API audio turns using `api:*` chat IDs were accepted but then routed as `persist-only` because newly-created chats inherit the default `is_enabled: false`.
- The user clarified that chat enablement is a transport-level concern and should not be handled by the rest of the app.
- Current short-term fix may special-case authenticated HTTP API client chats so the deployed web audio path works, but that is not the intended long-term architecture.

## Desired Direction

- Define transport-owned defaults for new chat records, including whether a chat should start enabled.
- Keep WhatsApp's disabled-by-default behavior explicit at the WhatsApp transport boundary.
- Keep authenticated HTTP API client chats enabled by default without leaking `api:*` naming assumptions into generic conversation routing.
- Preserve per-chat user/admin overrides after a chat exists.

## Acceptance

- New chat enablement defaults are selected by transport identity or explicit transport metadata, not by generic conversation-runner string matching.
- Existing WhatsApp enable/disable behavior remains unchanged.
- HTTP API client chats can invoke the configured agent without manual `!s enabled on`.
- Regression tests cover both WhatsApp/default-disabled behavior and HTTP API/default-enabled behavior.

## Completion Notes

- Added `ChannelInput.chatCreationDefaults` as explicit transport metadata for creation-time chat defaults.
- HTTP API turn intake now marks new HTTP API chats with `{ isEnabled: true }`; WhatsApp inputs do not supply creation defaults and keep the disabled store default.
- Store `createChat` now accepts creation defaults and maps semantic `isEnabled` to persisted `is_enabled` only when a chat config is first created.
- Removed the generic conversation runner's `api:` chat ID prefix check and forced `setChatEnabled` workaround.
- Added regressions for HTTP API default-enabled metadata, no-default/WhatsApp-style default disabled routing, and preserving existing user/admin overrides.

## Verification

- `pnpm test tests/store.test.js tests/http-api-turn-intake.test.js`
- `pnpm test tests/integration.test.js` (rerun with sandbox escalation because the test binds a local mock HTTP server)
- `pnpm test tests/http-api-transport.test.js` (rerun with sandbox escalation because the test binds a local HTTP server)
- `pnpm type-check`
- `pnpm type-check:tests`
