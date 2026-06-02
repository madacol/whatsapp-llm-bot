# Refactor Backlog

This backlog records refactors noticed while validating provider event behavior and the surrounding transport tests.

1. [x] Superseded: The previous provider-private smoke harness was removed when the harness layer moved fully to ACP.
2. [x] Done: Add a transport-capture seam in tests so e2e coverage can assert media/attachment captions before Baileys-specific handling hides them. Added `getRenderedMessages()` to the mock Baileys socket.
3. [x] Done: Fix noisy context-log schema setup in workspace lifecycle tests so expected test flows do not log `no such table: messages`. Test-created workspace chats now map to the shared in-memory chat DB.
4. [x] Done: Split or better organize the oversized e2e adapter coverage by feature area. ACP transport coverage now lives in `tests/e2e-adapter.test.js`.
5. [x] Superseded: Provider-private runtime loops were removed when the harness layer moved fully to ACP.
6. [x] Done: Reduce slow visual test cost by making rendering-heavy suites easier to target separately from fast unit tests. Added `pnpm test:fast` and `pnpm test:rendering`.
7. [x] Done: Normalize ACP file-change semantics so new writes report `add`, deletes report `delete`, and updates preserve diffs at the transport boundary.
8. [x] Done: Add shared runtime-event contract test helpers for provider-to-hook behavior. Added `createRuntimeHookRecorder()`.

Verification passed:

- `pnpm test tests/test-runner.test.js tests/acp-harness.test.js tests/acp-events.test.js tests/acp-file-changes.test.js tests/e2e-adapter.test.js tests/workspace-lifecycle.test.js tests/sendBlocks.test.js`
- `pnpm type-check`
- `pnpm test` (1111 passed)
