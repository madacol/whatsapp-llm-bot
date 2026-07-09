# WhatsApp Side-Channel Presentation Settings

## Status

Done.

## Goal

Keep the current balanced behavior as the default, while adding WhatsApp settings that can reduce side-channel noise.

## Decisions

- Settings are WhatsApp-specific.
- Empty/default config preserves current behavior.
- Settings affect side-channel output, not final assistant answers.
- Direct app/command/preflight replies stay outside these settings, except transcription status.
- A setting names the thing shown; its option names how it is shown.
- The renderer should not invent alternate fallback displays outside the selected setting.
- Ambiguous/unclassified events need scenario-specific handling.
- Generated media/files are primary artifacts, not inspect/pinned-only output.
- Inspect is text detail on an existing editable message; quiet modes should not create surprise extra detail messages.
- Generic pinned `LLM thinking` should be removed. Pinned reasoning is only for `reasoning = indicator in pinned status`.
- No generic `working indicator` setting.
- Middle assistant messages are separate from the final assistant answer.

## Settings

## Defaults

- `reasoning`: `indicator + inspectable`
- `tools`: `indicator + inspectable`
- `plans`: `shown`
- `file changes`: `shown`
- `snapshots`: `on`
- `subagents`: `shown`
- `usage`: `shown`
- `transcription`: `indicator + inspectable`
- `middle assistant messages`: `on`

## Legacy Mapping

- `thinking: true` -> `reasoning = indicator + inspectable`
- `thinking: false` -> `reasoning = hidden`
- old `toolStatus: true` -> `tools = indicator in pinned status`
- old `toolStatus: false` or absent -> `tools = indicator + inspectable`
- `changes: true` -> `file changes = shown`
- `changes: false` -> `file changes = hidden`
- `subagents: true` -> `subagents = shown`
- `subagents: false` -> `subagents = hidden`
- no old equivalent -> `plans = shown`, `snapshots = on`, `usage = shown`, `transcription = indicator + inspectable`, `middle assistant messages = on`

When migrating from the existing `toolStatus` flag, preserve behavior carefully: the old flag describes the pinned-status route, while the new `tools` setting is an enum that describes how tool presentation is shown.

`reasoning`

Options:
- `full details`
- `indicator + inspectable`
- `indicator in pinned status`
- `hidden`

If reasoning is encrypted/unavailable under `full details`, show the maximum truthful output with explicit unavailable/encrypted detail.

`tools`

All tool/command lifecycle, stdout/stderr/output, and tool failures.

Options:
- `full details`
- `indicator + inspectable`
- `indicator in pinned status`
- `hidden`

If hidden, tool/command failures are hidden as tool presentation. The final assistant answer may still explain the failure.

`plans`

Agent plan/checklist updates.

Options:
- `shown`
- `current step in pinned status`
- `hidden`

`file changes`

Explicit file edit/change presentation: proposed, denied, failed, applied.

Options:
- `shown`
- `hidden`

There is no separate summary-only presentation in the current logic.

`snapshots`

Unreported/snapshot file-change detection and presentation, including continuation prompts and snapshot warnings/errors.

Options:
- `on`
- `off`

Separate from `file changes`. If off, disable snapshot logic where possible instead of running it and hiding output.

`subagents`

Subagent text output.

Options:
- `shown`
- `hidden`

Subagent progress belongs under `tools`; this setting covers subagent text output.

`usage`

Token/cost summaries.

Options:
- `shown`
- `pinned status`
- `hidden`

`transcription`

Audio transcription status/transcript presentation.

Default/current behavior: `Transcribing audio...` updates to `Transcribed`, transcript in inspect.

Options:
- `full details`
- `indicator + inspectable`
- `indicator in pinned status`
- `hidden`

Hidden means no status message; transcript still feeds the agent.

`middle assistant messages`

Assistant text before the final answer.

Options:
- `on`
- `off`

Final assistant answer always shows.

## Non-Settings

- `runtime notices`
- raw events such as `item.completed`
- global `warnings` / `errors`
- approval/user-input requests
- artifacts, for now

Warnings/errors belong to the setting for the thing that caused them.

## Open Questions

- Split file-change summaries and rendered diffs?
- Any app-owned side-channel outputs besides transcription?
- Quiet-mode behavior when inspect editing fails.
- Future `shown`/`hidden` setting for generated artifacts?

## Implementation Notes

- Added enum-based output visibility settings with legacy normalization.
- Wired category controls through agent hooks, WhatsApp pinned/standalone rendering, queued delivery visibility, and chat settings commands.
- Added snapshot disabling to ACP run config so snapshot workdir passes are skipped when `snapshots = off`.
- Transcription supports hidden, full details, and indicator+inspectable. `indicator in pinned status` currently falls back to the existing editable app message because there is no app-owned pinned status path yet.
- Updated tests for the new contract and pinned-only modes.
