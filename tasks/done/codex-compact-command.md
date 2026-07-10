# Add `/compact` for Codex app-server sessions

## Task

Implement a slash command that triggers Codex App Server context compaction for the active Codex session.

## Evidence

- User asked to implement `/compact` through the Codex app server.
- Prior research found Codex App Server exposes `thread/compact/start` with `{ threadId }`.
- Current app forwards slash commands to the active runtime; the pinned Codex ACP bridge received compaction events but did not expose a manual trigger.

## Constraints

- Keep the command on the existing ACP/Codex seam.
- Do not route this through the Platform Responses `/v1/responses/compact` endpoint.
- Preserve existing slash command behavior for non-Codex providers.

## Completion

- Added an ACP runner helper that resumes or loads an existing session, then sends `session/compact`.
- Exposed `/compact` in the generic ACP command handler for Codex sessions, including missing-session, non-Codex, success, and failure feedback.
- Patched `@agentclientprotocol/codex-acp@0.0.44` so its ACP extension `session/compact` calls Codex App Server `thread/compact/start`.
- Added focused command-handler coverage and ACP mock-agent coverage for the compact request path.

## Verification

- `pnpm test tests/acp-model-command.test.js`
- `pnpm test tests/acp-harness.test.js` with escalated child-process stdio permissions
- `pnpm run type-check`
- `pnpm run type-check:tests`
- `node --check node_modules/@agentclientprotocol/codex-acp/dist/index.js`

The default sandbox blocked spawned Node child stdin for ACP fixture tests, causing sandbox-only timeouts. The same ACP harness tests passed outside the sandbox with the required child-process stdio permissions.
