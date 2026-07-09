# WhatsApp Presentation Intent Category Ownership

## Status

Todo. Category-owned visibility settings and legacy migration are complete; the remaining work is a presentation-intent refactor.

## Goal

Move WhatsApp side-channel presentation decisions behind category-owned intent classification instead of spreading raw event handling across dispatch, pinned status, standalone messages, inspect, and continuation code.

## Problem

Raw event names are too low-level for settings:

- `item.completed` can mean assistant text, reasoning, tool output, or file output.
- `runtime.warning` should belong to the feature that caused it.
- snapshots and explicit file changes need different behavior.
- the same category is currently touched in multiple presentation paths.

## Proposal

Add a WhatsApp presentation intent layer.

Flow:

1. Producers emit existing semantic events.
2. A classifier maps known side-channel events to category intents.
3. Settings policy chooses the representation.
4. Category renderers produce existing WhatsApp primitives.
5. `send-content.js` executes delivery, not category decisions.

Candidate categories:

- `reasoning`
- `tools`
- `plans`
- `file_changes`
- `snapshots`
- `subagents`
- `usage`
- `transcription`
- `middle_assistant_message`
- `requests`

Each category owns:

- raw event membership;
- legal presentation options;
- warning/error handling;
- whether `off` disables work or only hides output;
- artifact constraints.

## Decisions

- No global settings for `runtime notices`, raw event names, warnings, or errors.
- Preserve current behavior by default.
- Agent-originated errors use `agent_error`, not app messages.
- `snapshots` and `file_changes` are separate settings.
- `snapshots = off` should disable snapshot logic where possible.
- Middle assistant messages are on/off only.

## Current State

- Category settings now exist and several category decisions live in `build-agent-io-hooks.js`, `codex-hook-display.js`, `send-content.js`, and transcription setup.
- This is not yet the proposed intent layer. The remaining refactor is to centralize classification and policy instead of continuing to spread category checks across those files.

## Live Visibility Requirement

User correction on 2026-07-09:

> You can now change these in real time, so these aren't locked to your prompt.

Media: `/home/mada/whatsapp-llm-bot/.media/20b742f1ee7d0253e9c86518e2abd1813d89da78a15127245d94ed6bf9bca69f.ogg`

Implication for this repo: side-channel visibility should not be captured once at agent-run start. A settings change during a running turn or batch should affect subsequent generated presentation items. For categories with an explicit start boundary, such as tool calls and reasoning items, the visibility sampled at item start owns that item through completion; the user should see the setting change on the next item, not retroactively on the already-started one.

## Live Visibility Implementation Notes

- Agent-run output hooks now accept a visibility provider and production resolves `output_visibility` from the latest chat config before side-channel presentation decisions.
- Reasoning and tool items keep the visibility sampled at item start through completion/result output.
- File changes, subagent messages, middle assistant messages, plans, usage, and generic runtime file-change filtering sample current visibility at their emission boundary.
- WhatsApp runtime rendering preserves already-started standalone tool/command messages if the chat switches to pinned tool status before completion.
- This does not complete the broader presentation-intent classifier refactor; category decisions are still spread across the existing hook and renderer files.

## Open Questions

- Where should classification live?
- Should intents be WhatsApp-specific or app-level?
- Keep or replace current pinned-status state?
- How should inspect fallback-to-new-message be represented?
- How should tests be reorganized around category contracts?
