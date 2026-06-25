# Fix idempotent chat workspace adoption

## Evidence

Startup ingress replay was repeatedly failing in `resolveOrAdoptChatWorkspace` with `UNIQUE constraint failed: workspaces.workspace_chat_id` while processing WhatsApp ingress journal rows. The trace showed the failure at `store/repos/projects.js:createWorkspace`, called from `workspace-binding-service.js`.

The resolver checked for an existing workspace by project/name before creating the chat workspace. That missed cases where the workspace already owned the chat id but the chat binding was absent, or where concurrent ingress rows raced between the lookup and insert.

## Completed

- Added a `getWorkspaceByChatId` store lookup for the workspace chat-id seam.
- Made group-chat auto-adoption reuse an existing workspace for the same workspace chat id and restore the chat binding.
- Made auto-adoption recover from SQLite unique-constraint races by reading the winning workspace row.

## Verification

- Red: `pnpm test tests/workspace-resolver.test.js` failed with `UNIQUE constraint failed: workspaces.workspace_chat_id`.
- Green: `pnpm test tests/workspace-resolver.test.js`.
- Type-check: `pnpm type-check`.
- Broader test: `pnpm test:fast` passed after rerunning outside the sandbox because the suite binds local `127.0.0.1` test servers.
