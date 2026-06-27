# Fix ACP EPIPE Crash After Clear Follow-Up

## Subject

Prevent the whole WhatsApp bot process from exiting when an ACP child process is aborted during startup/initialize. The observed incident happened on master after `/clear` followed by `improve architecture` in chat `120363179758540546@g.us`.

## Incident

- Time window: `2026-06-27 10:32:20` to `2026-06-27 10:32:24` UTC.
- User flow from screenshot/logs: `/clear`, then `improve architecture`; later `?` and `! restart`.
- Crash turn: `120363179758540546@g.us:1782556343738:20`.
- ACP resume cursor in console: `019f0571-da2c-74e3-8df3-764c1abebe06`.
- Workdir: `/home/mada/whatsapp-llm-bot`.
- Snapshot before ACP open completed: `fileCount: 426`, `durationMs: 1169`.
- The bot supervisor restarted the process afterward; current PIDs after investigation were new, so the crash was real and recovered by the supervisor.

## Evidence

- `pgdata/root.sqlite`, `whatsapp_ingress_journal`:
  - row `23471`, chat `120363179758540546@g.us`, `messages.upsert`, `done`, created `2026-06-27 10:32:20`.
  - row `23472`, same chat, `messages.upsert`, `done`, created `2026-06-27 10:32:23`, updated `2026-06-27 10:41:15`.
  - rows `23473` and `23474` are self-authored WhatsApp messages and were correctly `ignored`: `CODEX turn started` and `Session cleared...`.
- `/home/mada/chat/120363179758540546@g.us/chat.sqlite`, `messages`:
  - row `4709`, timestamp `2026-06-27 10:32:23`, user text `improve architecture`.
  - rows `4710` to `4713` are later retry/restart inputs around `10:35`.
- `/home/mada/chat/120363179758540546@g.us/chat.sqlite`, `agent_runs`:
  - no rows between `2026-06-27 10:32:23` and `2026-06-27 10:35:00`, so the crashed run never completed/persisted an agent result.
- User-provided console log:
  - `ACP child process error` with `code: 'ABORT_ERR'`, message `The operation was aborted`, no pending requests.
  - Immediately afterward `ACP initialize request starting`.
  - Then uncaught `Error: write EPIPE` at `harnesses/acp-client.js:533:16`, called from `sendRequest` around `harnesses/acp-client.js:694`.
  - Process exited with code `1`, triggering WhatsApp cleanup and DB close.

## Code Path

- `harnesses/acp-runner.js` opens the child in `openInitializedAcpConnection()` and then sends `initialize`:
  - `openAcpConnection(...)` around line `796`.
  - `connection.sendRequest("initialize", ...)` around line `809`.
- `harnesses/acp-client.js` spawns the ACP process with an optional `AbortSignal`:
  - `spawn(..., { signal: options.signal })` around line `456`.
  - child `error` handler records `processError`, sets `closed = true`, and rejects pending requests around lines `478-506`.
  - `send()` writes directly to `proc.stdin` around line `533`.
  - `sendRequest()` registers a pending request and calls `send(...)` around line `694`.
- ACP adapter active runs use `AbortController`:
  - `harnesses/acp.js` creates an `AbortController` for each run around line `358`.
  - `interruptTurn`, `stopSession`, `cancel`, and `stopAll` call `abortController.abort()`.
- `/clear` can clear the active session:
  - `conversation/create-conversation-runner.js` handles clear follow-up around lines `533-581`.
  - `conversation/harness-session-binding.js` calls `adapter.stopSession(chatId)` around line `140`.

## Current Understanding

Known:

- The user message was received and persisted.
- The ACP child was aborted before/during `initialize`.
- The parent bot process crashed because `proc.stdin.write(...)` was not guarded against a closed/aborted child process.
- The workdir snapshot was quick (`1169ms`) and only `426` files; current evidence does not prove OOM or file-count overload.

Inferred:

- The most likely immediate trigger for `ABORT_ERR` is an `AbortController` race around `/clear`, active-run interruption, stopSession, or restart behavior.
- The exact abort caller for this incident is not proven from persisted state alone.
- Regardless of abort trigger, an ACP child abort must be contained as a failed run, not as a process-level crash.

## Non-Goals

- Do not delete session/cache directories as a first response; there is no evidence of corrupted state.
- Do not treat the architecture request itself or the 426-file snapshot as root cause without a reproduction.
- Do not hide provider failures by swallowing all ACP errors; convert transport-level failures into controlled run failures with useful logs.

## Proposed Fix

1. Harden `harnesses/acp-client.js`:
   - Add a `proc.stdin` error handler.
   - Treat `EPIPE`, `ERR_STREAM_DESTROYED`, and writes after `closed/processError` as controlled ACP connection failures.
   - Reject the request being sent and any pending requests instead of allowing an uncaught exception.
   - Avoid leaving a pending request registered if the write fails.
2. Add a focused regression test:
   - Reproduce a child abort/closed stdin before `initialize`.
   - Assert `openInitializedAcpConnection` or the ACP adapter rejects with a controlled error.
   - Assert no `uncaughtException` / process crash path is triggered.
3. Investigate the abort trigger separately if needed:
   - Trace `/clear` plus immediate follow-up while an active run exists.
   - Confirm whether `clearActiveSession`/`stopSession` can abort the newly-started follow-up run instead of only the old session.

## Acceptance Criteria

- A red test proves the current unguarded write can surface as `EPIPE`/uncaught or an uncontrolled rejection.
- The fix converts aborted ACP startup into a normal failed run path: visible error/log, bot process remains alive.
- `pnpm type-check` passes.
- Relevant ACP tests pass, including an ACP client/runner regression test and any existing ACP adapter tests.
- Manual or automated reproduction of `/clear` followed immediately by a normal Codex request no longer exits the Node process.
