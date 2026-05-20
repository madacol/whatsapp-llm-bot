# Refactor Backlog

This backlog records refactors noticed while validating Pi RPC event behavior and the surrounding transport tests.

1. [x] Done: Add a repeatable Pi RPC smoke harness under `scripts/` that can be run manually and emits redacted event-shape summaries. Verified with `node scripts/pi-rpc-smoke.js`.
2. [x] Done: Add a transport-capture seam in tests so e2e coverage can assert media/attachment captions before Baileys-specific handling hides them. Added `getRenderedMessages()` to the mock Baileys socket.
3. [x] Done: Fix noisy context-log schema setup in workspace lifecycle tests so expected test flows do not log `no such table: messages`. Test-created workspace chats now map to the shared in-memory chat DB.
4. [x] Done: Split or better organize the oversized e2e adapter coverage by feature area. Moved Pi RPC adapter coverage to `tests/e2e-pi-rpc-adapter.test.js`.
5. [x] Done: Tighten `startPiRpcRun` hook typing and extract Pi tool-call start-arg tracking from the notification loop.
6. [x] Done: Reduce slow visual test cost by making rendering-heavy suites easier to target separately from fast unit tests. Added `pnpm test:fast` and `pnpm test:rendering`.
7. [x] Done: Normalize Pi `write` file-change semantics so new writes report `add` instead of relying on the renderer to infer that later.
8. [x] Done: Add shared runtime-event contract test helpers for provider-to-hook behavior. Added `createRuntimeHookRecorder()`.

Verification passed:

- `node scripts/pi-rpc-smoke.js`
- `pnpm test tests/test-runner.test.js tests/pi-runtime-events.test.js tests/pi-rpc-runner.test.js tests/e2e-pi-rpc-adapter.test.js tests/e2e-adapter.test.js tests/workspace-lifecycle.test.js tests/sendBlocks.test.js`
- `pnpm type-check`
- `pnpm test` (1111 passed)
