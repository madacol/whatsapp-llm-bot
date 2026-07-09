# Agent Output Presentation Category Ownership

## Status

Todo. Partially advanced by the side-channel settings implementation.

## Goal

Move side-channel presentation decisions behind category-owned classification instead of spreading raw event handling across dispatch, pinned status, standalone messages, inspect, and continuation code.

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

## Open Questions

- Where should classification live?
- Should intents be WhatsApp-specific or app-level?
- Keep or replace current pinned-status state?
- How should inspect fallback-to-new-message be represented?
- How should tests be reorganized around category contracts?
