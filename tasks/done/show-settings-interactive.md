# Interactive Show Settings

## Status

Done.

## Goal

Make `!s show` interactive in WhatsApp after the side-channel settings changed from a flat boolean set to category-specific options.

## Acceptance Criteria

- `!s show` without a value opens a category picker when `select` is available.
- After selecting a category, the user gets an option picker for that category.
- The selected option persists through the existing `output_visibility` model.
- Text commands such as `!s show tools pinned` still work.
- If interactive selection is unavailable or cancelled, the command falls back to the help/summary text.

## Notes

- Do not restore the old multi-select on/off picker; it cannot represent the new contract.
- Keep options stable by using setting keys and internal option ids as select ids.

## Completion Notes

- Added a generic `runSelectFlow` helper for multi-step single-select setting flows.
- Made `!s show` use the helper with category and option steps.
- Preserved text commands such as `!s show tools pinned`.
- Verified with `pnpm test tests/chat-settings.test.js`, `pnpm type-check`, and `pnpm type-check:tests`.
