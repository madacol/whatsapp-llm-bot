# Show Settings Presets

## Status

Done.

## Goal

Make `!s show` start with side-channel presentation presets, while preserving custom per-category configuration through the existing generic select flow.

## Evidence

- User wants presets surfaced first, with `custom` at the bottom leading into individual show settings.
- Existing implementation already has a reusable multi-step single-select flow and a two-step custom category/option path.
- Presets should be a convenience layer over the existing `output_visibility` contract, not a separate persisted mode.

## Acceptance Criteria

- `!s show` with interactive select first offers presets plus `custom`.
- Selecting a preset persists the corresponding `output_visibility` overrides.
- Selecting `custom` continues into category selection, then option selection.
- Text commands keep working for category/option commands.
- Text preset commands such as `!s show compact` work if practical.
- Tests cover preset application and the custom branch.

## Completion Notes

- Added preset definitions for `default`, `compact`, and `minimal` over the existing `output_visibility` contract.
- Made interactive `!s show` start with presets plus `custom`.
- Preset choices apply immediately; `custom` branches into category selection and option selection.
- Text commands such as `!s show compact` and `!s show tools pinned` both work.
- Verified with `pnpm test tests/chat-settings.test.js`, `pnpm test tests/chat-output-visibility.test.js`, `pnpm type-check`, and `pnpm type-check:tests`.
