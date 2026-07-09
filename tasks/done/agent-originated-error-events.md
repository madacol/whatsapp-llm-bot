# Agent-Originated Error Events

## Status

Done.

## Context

Agent-run errors are currently mixed with app-originated error output in the outbound event shape. `AgentRunOutputPort.sendError()` and `replyWithError()` call `appMessageEvent("error", ...)`, so downstream WhatsApp presentation cannot distinguish an agent runtime failure from a direct app/command reply error by event kind.

User direction: errors from underlying agents such as Codex, Pi, or ACP-provider payloads should travel through the agent output path and must not be represented as app messages. App-originated command/preflight replies should remain outside the new agent verbosity settings.

## Acceptance Criteria

- Agent-run error output uses a distinct agent-owned outbound event kind.
- App-owned errors continue using `app_message` through `AppOutputPort`.
- WhatsApp rendering keeps the existing visible error presentation for agent errors.
- Focused tests cover the output-port boundary and rendering path.

## Verification

- `pnpm test tests/agent-run-output-port.test.js tests/outbound-event-rendering.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`

## Completion Notes

Added `agent_error` as a distinct outbound event kind. `AgentRunOutputPort.sendError()` and `replyWithError()` now emit `agent_error` instead of `app_message`. WhatsApp rendering maps `agent_error` to the existing error source, so visible presentation stays the same while origin semantics are no longer mixed with app-owned errors.
