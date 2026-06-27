# Extract ACP Client Connection Failure Lifecycle

## Subject

Refactor ACP client process/stdin/request failure handling into a deeper connection-failure lifecycle module.

## Source

Created from the user's request to convert refactor candidates 1, 2, and 3 into pending handoff tasks.

This is candidate 2 from the prior recommendation:

- "ACP client connection failure lifecycle"
- It was identified after fixing the ACP `EPIPE` crash. The immediate bug is fixed, but `harnesses/acp-client.js` is now larger and owns several related failure paths inline.

## Current Evidence

- `tasks/done/acp-epipe-crash-after-clear.md` records the completed bug fix.
- Commit `3d10165 Handle ACP stdin failures without crashing` hardened stdin failures by:
  - adding controlled ACP write failures;
  - rejecting pending requests with pending-request context;
  - ending notifications;
  - terminating the child process for cleanup;
  - guarding request, notification, and client-response writes.
- The owner area is currently mostly `harnesses/acp-client.js`, with tests in `tests/acp-client.test.js`.

## Problem

The ACP client now handles child startup error, runtime process error, process exit, stdin error, closed-stream writes, pending request timeout, notification send failure, and close cleanup in one large module. This is acceptable after the crash fix, but future child-process failure bugs will likely require editing scattered state transitions.

## Goal

Extract a small lifecycle owner for ACP connection failure state:

- process error and stdin error;
- connection closed/unavailable status;
- pending request rejection;
- queue ending;
- warning/log details;
- cleanup decisions for child termination.

The public ACP client interface should stay small.

## Non-Goals

- Do not change ACP protocol behavior or request/notification shapes.
- Do not hide provider failures; controlled failures still need useful context.
- Do not split merely for file-size aesthetics. The module should improve locality for failure semantics.

## Suggested First Pass

1. Read `harnesses/acp-client.js` around startup, `send`, `sendRequest`, stdin error, and exit handling.
2. Read `tests/acp-client.test.js`, especially startup failure, pending request exit, timeout, and stdin `EPIPE`.
3. Design a connection lifecycle object whose interface is smaller than the current implementation details.
4. Move one failure path at a time, preserving red/green coverage.

## Acceptance Criteria

- ACP process/stdin/closed-write failure semantics are owned by one lifecycle module or object.
- `openAcpConnection` reads mostly as protocol wiring and child process setup, not pending-request failure choreography.
- Existing ACP client failure tests remain green.
- Add or retain coverage for startup failure, runtime exit with pending requests, timeout, stdin `EPIPE`, and closed/unwritable send.
- `pnpm type-check` and ACP client tests pass.

## Completion Notes

- Added `harnesses/acp-client-connection-lifecycle.js` as the owner for ACP connection failure state.
- Moved closed/close-requested/process-error state, stderr tail context, pending request registration/rejection, timeout errors, process error handling, process exit handling, and stdin/write failure handling behind the lifecycle object.
- Kept `harnesses/acp-client.js` responsible for child process setup, JSON-RPC send/receive, protocol capture, request/notification routing, and close orchestration.
- Added `tests/acp-client-connection-lifecycle.test.js` to prove stdin failure rejects pending requests, ends notifications, records useful context, and kills the child.
- Existing `tests/acp-client.test.js` coverage still proves startup failure, runtime exit with pending requests, timeout context, stdin `EPIPE`, fixture capture, and timeout refresh behavior.

## Verification

- Red: `pnpm test tests/acp-client-connection-lifecycle.test.js` failed with `ERR_MODULE_NOT_FOUND` before the lifecycle module existed.
- Green: `pnpm test tests/acp-client-connection-lifecycle.test.js tests/acp-client.test.js`.
- Green: `pnpm type-check`.
- Green with sandbox escalation: `pnpm test --test-name-pattern "runs an ACP stdio agent" tests/acp-harness.test.js`.

## Status

Done.
