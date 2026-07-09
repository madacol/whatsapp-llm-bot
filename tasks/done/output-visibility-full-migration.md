# Output Visibility Full Migration

## Status

Done.

## Goal

Remove runtime backward compatibility for legacy `output_visibility` settings and replace it with an explicit config-file migration to the new category-owned show contract.

## Evidence

- User explicitly rejected keeping backward compatibility for old show settings and wants a full migration.
- Current implementation still normalizes old keys such as `thinking`, `changes`, `toolStatus`, `toolDetails`, boolean `tools`, boolean `usage`, and boolean `subagents`.
- Chat settings are persisted as per-chat JSON `config.json` files under the chat base directory.

## Acceptance Criteria

- A migration translates legacy `output_visibility` config into new keys.
- Runtime `normalizeOutputVisibility` only accepts the new contract.
- Old helper APIs for grouped visibility flags are removed or replaced by explicit migration helpers.
- Tests prove old keys are migrated, then ignored by runtime normalization.
- Existing tests stop seeding legacy output visibility shapes except migration-specific tests.

## Completion Notes

- Removed legacy visibility flag normalization from runtime `normalizeOutputVisibility`.
- Removed old grouped-flag helper APIs from `chat-output-visibility.js`.
- Added explicit legacy migration helpers and a chat-config file migrator.
- Production startup now migrates legacy per-chat `output_visibility` files before initializing the store.
- Updated tests and fixtures to use the new show contract.
- Added focused coverage for:
  - legacy config migration and runtime rejection of old keys;
  - preset/custom show settings;
  - pinned plan status;
  - transcription hidden/default/full-details modes;
  - workspace customization copy preserving non-default output visibility.

## Verification

- `pnpm test tests/chat-output-visibility.test.js tests/chat-config-migration.test.js tests/chat-settings.test.js`
- `pnpm test tests/build-agent-io-hooks.test.js tests/sendBlocks.test.js tests/whatsapp-outbound-durability.test.js`
- `pnpm test tests/audio-transcription-output-visibility.test.js tests/sendBlocks.test.js`
- `pnpm test tests/whatsapp-transport.test.js`
- `pnpm test tests/build-run-config.test.js`
- `pnpm test tests/workspace-lifecycle.test.js` with local-bind permission after the default-compaction fixture fix
- `pnpm type-check`
- `pnpm type-check:tests`
